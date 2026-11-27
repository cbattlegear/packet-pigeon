import type { RadioData, StoredMessage } from '../storage/index.ts'
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
 * Saved wire receipts are authoritative. Rebuild this projection on each cache read, including all pending
 * formats, rather than dropping an unmatched reaction or choosing an arbitrary hash collision.
 */
export async function resolveReactions(data: RadioData, radioKey: string): Promise<RadioData> {
  const contacts = data.contacts.map(({ publicKey }) => publicKey.toLowerCase())
  const conversation = (message: StoredMessage) => {
    const id = message.outgoing ? `direct:${message.outgoing.recipient}` : message.conversationId
    if (!id.startsWith('direct:')) return id
    const key = id.slice(7).toLowerCase()
    const matches = contacts.filter((full) => full.startsWith(key.slice(0, 12)))
    return `direct:${key.length === 12 && matches.length === 1 ? matches[0] : key}`
  }
  const entries = data.messages.map((message) => {
    const target = reactionTarget(message)
    const id = conversation(message)
    const prefix = id.startsWith('direct:') ? id.slice(7) : null
    return { message, target, conversation: id,
      ambiguousContact: prefix?.length === 12 && contacts.filter((key) => key.startsWith(prefix)).length > 1,
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
  const nativeHashes = new Map<string, { hash: string; sender: string | null }[]>()
  let reactionError: string | undefined
  if (reactionEntries.some(({ parsed }) => parsed?.format === 'meshcore')) {
    try {
      await Promise.all(candidates.map(async ({ message, target }) => {
        const stamps = [...new Set([target!.timestamp, ...(message.reactionTimestamps ?? [])])]
        nativeHashes.set(message.id, (await Promise.all(variants.get(message.id)!.map((variant) =>
          Promise.all(stamps.map(async (stamp) => ({ hash: await messageReactionHash(variant.text, stamp), sender: variant.sender }))),
        ))).flat())
      }))
    } catch (error) {
      reactionError = `Reaction matching failed: ${error instanceof Error ? error.message : 'Could not hash the target messages.'} Wire receipts are still saved.`
    }
  }
  const resolved = new Map<string, MessageReaction>()
  const summaries = new Map<string, Map<string, { emoji: string; senders: Map<string, string>; earliest: number }>>()
  for (const entry of reactionEntries) {
    const parsed = entry.parsed!
    const matches = candidates.filter((candidate) => {
      if (candidate.conversation !== entry.conversation || candidate.ambiguousContact || entry.ambiguousContact) return false
      const target = candidate.target!
      if (parsed.format === 'meshcore') return (nativeHashes.get(candidate.message.id) ?? []).some(({ hash, sender }) =>
        hash === parsed.hash && (parsed.targetSender === null || sender?.normalize('NFC') === parsed.targetSender.normalize('NFC')))
      const stamps = [...new Set([target.timestamp, ...(candidate.message.reactionTimestamps ?? [])])]
      if (parsed.format === 'open-v1') return stamps.some((stamp) => Math.abs(stamp - parsed.timestamp) <= 300)
        && variants.get(candidate.message.id)!.some((variant) => dartStringHash(variant.text) === parsed.textHash
          && (variant.sender === null || dartStringHash(variant.sender) === parsed.senderHash))
      const anchor = Math.floor((entry.message.receivedAt ?? entry.message.timestamp ?? 0) / 1000)
      return stamps.some((stamp) => Math.abs(stamp - anchor) <= 300
        && variants.get(candidate.message.id)!.some((variant) => openReactionHash(variant.text, stamp, variant.sender) === parsed.hash))
    })
    const state = parsed.format === 'meshcore' && reactionError ? 'unavailable'
      : entry.ambiguousContact ? 'ambiguous' : matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched'
    resolved.set(entry.message.id, { parsed, state, ...(state === 'matched' ? { targetId: matches[0].message.id } : {}) })
    if (state !== 'matched' || entry.target!.sender !== null && data.blockedChannelSenders?.includes(entry.target!.sender)
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
