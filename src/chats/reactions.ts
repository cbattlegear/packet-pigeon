import type { RadioData, StoredMessage } from '../storage/index.ts'
import { isBlockedChannelMessage } from '../channels/senders.ts'
import { dartStringHash, messageReactionHash, openReactionHash, parseReaction, reactionChannelContent } from '../radio/reactions.ts'
import type { ParsedReaction } from '../radio/reactions.ts'

export type ReactionSummary = { emoji: string; senders: string[]; count: number }
export type MessageReaction = { parsed: ParsedReaction; state: 'matched' | 'unmatched' | 'ambiguous' | 'unavailable'; targetId?: string }

export function reactionTarget(message: StoredMessage) {
  if (message.outgoing) return { text: message.text, timestamp: message.outgoing.wireTimestamp, sender: null }
  if (message.channelOutgoing) return {
    text: message.text, timestamp: message.channelOutgoing.wireTimestamp, sender: message.channelOutgoing.senderName,
  }
  const receipt = message.receipt
  if (!receipt || receipt.kind === 'channel-data' || receipt.textType !== 0) return null
  if (receipt.kind === 'direct-text') return { text: receipt.text, timestamp: receipt.senderTimestamp, sender: null }
  const content = reactionChannelContent(receipt.text)
  return content?.sender ? { ...content, timestamp: receipt.senderTimestamp } : null
}

export function canReactTo(message: StoredMessage) {
  const target = reactionTarget(message)
  return Boolean(target && !message.reaction && !parseReaction(target.text, target.sender !== null)
    && Number.isInteger(target.timestamp) && target.timestamp >= 0 && target.timestamp <= 0xffffffff
    && (target.sender === null || !target.sender.includes(']'))
    && (!message.outgoing || message.outgoing.acknowledgements.some(({ confirmed }) => confirmed))
    && message.channelOutgoing?.status !== 'sending')
}

/**
 * Saved wire receipts are authoritative. Index candidate identifiers without dropping pending formats
 * or choosing an arbitrary hash collision.
 */
export async function resolveReactions(
  data: RadioData, radioKey: string, previousHashes = new Map<string, Promise<string>>(),
  currentHashes = new Map<string, Promise<string>>(),
): Promise<RadioData> {
  const contacts = data.contacts.map(({ publicKey }) => publicKey.toLowerCase())
  const prefixes = new Map<string, string[]>()
  for (const contact of contacts) {
    const prefix = contact.slice(0, 12)
    prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), contact])
  }
  const conversation = (message: StoredMessage) => {
    const id = message.outgoing ? `direct:${message.outgoing.recipient}` : message.conversationId
    if (!id.startsWith('direct:')) return id
    const key = id.slice(7).toLowerCase()
    const matches = prefixes.get(key.slice(0, 12)) ?? []
    return `direct:${key.length === 12 && matches.length === 1 ? matches[0] : key}`
  }
  const entries = data.messages.map((message) => {
    const target = reactionTarget(message)
    const id = conversation(message)
    const prefix = id.startsWith('direct:') ? id.slice(7) : null
    return { message, target, conversation: id,
      ambiguousContact: prefix?.length === 12 && (prefixes.get(prefix)?.length ?? 0) > 1,
      parsed: target ? parseReaction(target.text, target.sender !== null) : null }
  })
  const reactionEntries = entries.filter(({ parsed }) => parsed !== null)
  if (!reactionEntries.length) return data
  const candidates = entries.filter(({ target, parsed }) => target && !parsed
    && Number.isInteger(target.timestamp) && target.timestamp >= 0 && target.timestamp <= 0xffffffff)
  const variants = new Map(candidates.map(({ message, target }) => {
    const peer = message.channelOutgoing
      ? reactionChannelContent(`${message.channelOutgoing.senderName}: ${message.text}`) : null
    return [message.id, peer && (peer.text !== target!.text || peer.sender !== target!.sender)
      ? [target!, { ...peer, timestamp: target!.timestamp }] : [target!]]
  }))
  type Candidate = (typeof candidates)[number]
  type TimedCandidate = { candidate: Candidate; timestamp: number }
  const native = new Map<string, Candidate[]>()
  const openV1 = new Map<string, TimedCandidate[]>()
  const openV3 = new Map<string, TimedCandidate[]>()
  const hasFormat = (format: ParsedReaction['format']) => new Set(
    reactionEntries.filter(({ parsed }) => parsed?.format === format).map(({ conversation }) => conversation),
  )
  const nativeConversations = hasFormat('meshcore')
  const v1Conversations = hasFormat('open-v1')
  const v3Conversations = hasFormat('open-v3')
  const add = <T,>(index: Map<string, T[]>, key: string, value: T) => {
    const values = index.get(key)
    if (values) values.push(value)
    else index.set(key, [value])
  }
  const indexKey = (...parts: (string | number | null)[]) => JSON.stringify(parts)
  let reactionError: string | undefined
  await Promise.all(candidates.map(async (candidate) => {
    const { message, target, conversation } = candidate
    if (candidate.ambiguousContact) return
    const stamps = [...new Set([target!.timestamp, ...(message.reactionTimestamps ?? [])])]
    for (const variant of variants.get(message.id)!) {
      const sender = variant.sender?.normalize('NFC') ?? null
      if (nativeConversations.has(conversation)) {
        for (const stamp of stamps) {
          const hashKey = JSON.stringify([variant.text, stamp])
          const previous = previousHashes.get(hashKey)
          if (previous && !currentHashes.has(hashKey)) currentHashes.set(hashKey, previous)
          try {
            const hash = await messageReactionHash(variant.text, stamp, currentHashes)
            add(native, indexKey(conversation, hash, sender), candidate)
          } catch (error) {
            reactionError = `Reaction matching failed: ${error instanceof Error ? error.message : 'Could not hash the target messages.'} Wire receipts are still saved.`
          }
        }
      }
      if (v1Conversations.has(conversation)) {
        const key = indexKey(conversation, dartStringHash(variant.text),
          variant.sender === null ? null : dartStringHash(variant.sender))
        for (const stamp of stamps) add(openV1, key, { candidate, timestamp: stamp })
      }
      if (v3Conversations.has(conversation)) {
        for (const stamp of stamps) {
          const key = indexKey(conversation, openReactionHash(variant.text, stamp, variant.sender))
          add(openV3, key, { candidate, timestamp: stamp })
        }
      }
    }
  }))
  for (const index of [openV1, openV3]) {
    for (const values of index.values()) values.sort((a, b) => a.timestamp - b.timestamp)
  }
  const distinct = (candidates: Iterable<Candidate>) => {
    const matches = new Map<string, Candidate>()
    for (const candidate of candidates) {
      matches.set(candidate.message.id, candidate)
      if (matches.size === 2) break
    }
    return [...matches.values()]
  }
  function* inWindow(candidates: TimedCandidate[], anchor: number) {
    let low = 0
    let high = candidates.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (candidates[middle].timestamp < anchor - 300) low = middle + 1
      else high = middle
    }
    for (let index = low; index < candidates.length && candidates[index].timestamp <= anchor + 300; index++) {
      yield candidates[index].candidate
    }
  }
  const resolved = new Map<string, MessageReaction>()
  const summaries = new Map<string, Map<string, { emoji: string; senders: Map<string, string>; earliest: number }>>()
  const blocked = new Set(data.blockedChannelSenders ?? [])
  for (const entry of reactionEntries) {
    const parsed = entry.parsed!
    let matches: Candidate[]
    if (parsed.format === 'meshcore') {
      matches = distinct(native.get(indexKey(entry.conversation, parsed.hash, parsed.targetSender?.normalize('NFC') ?? null)) ?? [])
    } else {
      const anchor = parsed.format === 'open-v1' ? parsed.timestamp
        : Math.floor((entry.message.receivedAt ?? entry.message.timestamp ?? 0) / 1000)
      const indexed = parsed.format === 'open-v1'
        ? openV1.get(indexKey(entry.conversation, parsed.textHash, entry.target!.sender === null ? null : parsed.senderHash))
        : openV3.get(indexKey(entry.conversation, parsed.hash))
      matches = distinct(inWindow(indexed ?? [], anchor))
    }
    if (entry.ambiguousContact) matches = []
    const state = parsed.format === 'meshcore' && reactionError ? 'unavailable'
      : entry.ambiguousContact ? 'ambiguous' : matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched'
    resolved.set(entry.message.id, { parsed, state, ...(state === 'matched' ? { targetId: matches[0].message.id } : {}) })
    if (state !== 'matched' || isBlockedChannelMessage(entry.message, blocked)
      || entry.message.outgoing && !['sent', 'delivered'].includes(entry.message.outgoing.status)
      || entry.message.channelOutgoing && entry.message.channelOutgoing.status !== 'accepted') continue
    const own = Boolean(entry.message.outgoing || entry.message.channelOutgoing)
    const senderKey = entry.target!.sender?.normalize('NFC')
      ?? (own ? radioKey : entry.message.receipt?.kind === 'direct-text' ? entry.message.receipt.senderKeyPrefix.toLowerCase() : '')
    const display = own ? 'You' : entry.target!.sender
      ?? data.contacts.find(({ publicKey }) => publicKey.toLowerCase().startsWith(senderKey))?.name ?? senderKey
    const groups = summaries.get(matches[0].message.id) ?? new Map()
    const emojiKey = parsed.emoji.normalize('NFC')
    const group = groups.get(emojiKey) ?? { emoji: parsed.emoji, senders: new Map(), earliest: entry.message.receivedAt ?? entry.message.timestamp ?? 0 }
    group.senders.set(senderKey, display)
    groups.set(emojiKey, group)
    summaries.set(matches[0].message.id, groups)
  }
  return { ...data, reactionError, messages: data.messages.map((message) => {
    const groups = summaries.get(message.id)
    return { ...message, reaction: resolved.get(message.id),
      reactions: groups ? [...groups.values()].sort((a, b) => b.senders.size - a.senders.size || a.earliest - b.earliest)
        .map(({ emoji, senders }) => ({ emoji, senders: [...senders.values()], count: senders.size })) : undefined }
  }) }
}
