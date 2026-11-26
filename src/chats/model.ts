import type { RadioData, StoredContact, StoredMessage } from '../storage/index.ts'
import { isBlockedChannelMessage } from '../channels/senders.ts'
import type { CapturedChannelObservation } from '../integration/channel-observations.ts'

export type Conversation = {
  id: string
  title: string
  description: string
  recipient: string | null
  channel: { index: number; name: string } | null
  messages: StoredMessage[]
}

export function conversations(data: RadioData, inMemoryDraftIds: readonly string[] = []): Conversation[] {
  const contacts = new Map(data.contacts.map((contact) => [contact.publicKey.toLowerCase(), contact]))
  const prefixes = new Map<string, StoredContact[]>()
  for (const contact of data.contacts) {
    const prefix = contact.publicKey.slice(0, 12).toLowerCase()
    prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), contact])
  }
  const names = new Map((data.contactPreferences ?? []).map((entry) => [entry.publicKey, entry.customName]))
  const byId = new Map<string, Conversation>()
  const blockedSenders = new Set(data.blockedChannelSenders ?? [])

  function direct(id: string) {
    const key = id.slice('direct:'.length).toLowerCase()
    const contact = contacts.get(key)
    const matches = prefixes.get(key.slice(0, 12)) ?? []
    const role = contact?.details?.type
    const recipient = contact && matches.length === 1 && (role === 1 || role === 3) ? contact.publicKey : null
    const title = contact ? names.get(key) || contact.name || 'Unnamed contact' : `Unknown contact ${key.slice(0, 12)}`
    const description = contact
      ? recipient ? contact.publicKey : matches.length > 1 ? 'Ambiguous key prefix; sending is unavailable.' : 'This contact cannot receive direct messages.'
      : 'Sender or former contact is not uniquely identified.'
    return { id, title, description, recipient, channel: null, messages: [] }
  }

  function add(id: string) {
    let conversation = byId.get(id)
    if (!conversation) {
      if (id.startsWith('direct:')) {
        conversation = direct(id)
      } else if (id.startsWith('channel:')) {
        const index = Number(id.slice('channel:'.length))
        const channel = data.channels.find((entry) => entry.index === index)
        conversation = {
          id, title: channel?.name || `Channel ${index}`, description: 'Channel messages; sender names are not verified.',
          recipient: null, channel: channel ?? null, messages: [],
        }
      } else {
        conversation = { id, title: 'Unrecognized responses', description: 'Raw bytes are preserved for inspection.', recipient: null, channel: null, messages: [] }
      }
      byId.set(id, conversation)
    }
    return conversation
  }

  for (const contact of data.contacts) {
    if (contact.details?.type === 1 || contact.details?.type === 3) add(`direct:${contact.publicKey.toLowerCase()}`)
  }
  for (const channel of data.channels) add(`channel:${channel.index}`)
  for (const draft of data.drafts) add(draft.conversationId)
  for (const id of inMemoryDraftIds) add(id)
  for (const message of data.messages) {
    let id = message.outgoing ? `direct:${message.outgoing.recipient}` : message.conversationId
    if (id.startsWith('direct:')) {
      const key = id.slice('direct:'.length).toLowerCase()
      const matches = prefixes.get(key.slice(0, 12)) ?? []
      if (key.length === 12 && matches.length === 1) id = `direct:${matches[0].publicKey.toLowerCase()}`
      else id = `direct:${key}`
    }
    const conversation = add(id)
    if (isBlockedChannelMessage(message, blockedSenders)) {
      conversation.description = 'Received channel entries; messages from blocked names are hidden.'
    } else {
      conversation.messages.push(message)
    }
  }
  for (const conversation of byId.values()) {
    conversation.messages.sort((first, second) => {
      const time = (message: StoredMessage) => message.timestamp !== null && Number.isFinite(message.timestamp)
        ? message.timestamp : Infinity
      return time(first) - time(second) || 0
    })
  }
  return [...byId.values()].sort((first, second) => {
    const latest = (conversation: Conversation) => conversation.messages.reduce(
      (latest, message) => Number.isFinite(message.timestamp) ? Math.max(latest, message.timestamp ?? 0) : latest, 0,
    )
    return latest(second) - latest(first) || first.title.localeCompare(second.title) || first.id.localeCompare(second.id)
  })
}

export function searchMessages(messages: readonly StoredMessage[], query: string) {
  const term = query.trim().toLocaleLowerCase()
  return term ? messages.filter((message) => message.text.toLocaleLowerCase().includes(term)) : messages
}

export function searchChatHistory(conversations: readonly Conversation[], query: string) {
  if (!query.trim()) return []
  const time = ({ timestamp }: StoredMessage) => timestamp !== null && Number.isFinite(timestamp) ? timestamp : -Infinity
  return conversations.flatMap((conversation) => searchMessages(conversation.messages, query)
    .map((message) => ({ conversation, message })))
    .sort((first, second) => time(second.message) - time(first.message))
}

export function messageDay(timestamp: number | null) {
  if (timestamp === null || !Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function receiptIdentity(receipt: NonNullable<StoredMessage['receipt']>) {
  if (receipt.kind === 'channel-data') return null
  const origin = receipt.kind === 'direct-text'
    ? `${receipt.senderKeyPrefix}:${receipt.signatureHex ?? ''}` : String(receipt.channelIndex)
  return JSON.stringify([receipt.kind, origin, receipt.senderTimestamp, receipt.textType, receipt.text])
}

export function possibleRepeats(messages: readonly StoredMessage[]) {
  const seen = new Set<string>()
  const repeats = new Set<string>()
  for (const message of messages) {
    const receipt = message.receipt
    if (!receipt) continue
    const identity = receiptIdentity(receipt)
    if (identity === null) continue
    if (seen.has(identity)) repeats.add(message.id)
    seen.add(identity)
  }
  return repeats
}

export function matchingChannelReceipts(messages: readonly StoredMessage[]) {
  const groups = new Map<string, StoredMessage[]>()
  for (const message of messages) {
    const receipt = message.receipt
    if (receipt?.kind !== 'channel-text') continue
    const key = receiptIdentity(receipt)!
    const group = groups.get(key) ?? []
    group.push(message)
    groups.set(key, group)
  }
  const matches = new Map<string, StoredMessage[]>()
  for (const group of groups.values()) {
    if (group.length > 1) for (const message of group) matches.set(message.id, group)
  }
  return matches
}

export function correlateChannelObservations(
  channelIndex: number, messages: readonly StoredMessage[], observations: readonly CapturedChannelObservation[],
) {
  const key = (timestamp: number, textType: number, text: string) => JSON.stringify([timestamp, textType, text])
  const groupedMessages = new Map<string, StoredMessage[]>()
  for (const message of messages) {
    let identity: string | undefined
    if (message.receipt?.kind === 'channel-text' && message.receipt.channelIndex === channelIndex) {
      identity = key(message.receipt.senderTimestamp, message.receipt.textType, message.receipt.text)
    } else if (message.channelOutgoing && message.conversationId === `channel:${channelIndex}`) {
      identity = key(message.channelOutgoing.wireTimestamp, 0, `${message.channelOutgoing.senderName}: ${message.text}`)
    }
    if (identity === undefined) continue
    const group = groupedMessages.get(identity) ?? []
    group.push(message)
    groupedMessages.set(identity, group)
  }
  const groupedObservations = new Map<string, CapturedChannelObservation[]>()
  for (const entry of observations) {
    const identity = key(entry.timestamp, entry.textType, entry.text)
    const group = groupedObservations.get(identity) ?? []
    group.push(entry)
    groupedObservations.set(identity, group)
  }
  const result = new Map<string, { entries: CapturedChannelObservation[]; matchingMessages: number }>()
  for (const [identity, group] of groupedMessages) {
    const entries = groupedObservations.get(identity)
    if (!entries?.length) continue
    for (const message of group) result.set(message.id, { entries, matchingMessages: group.length })
  }
  return result
}

export function unreadReceipts(messages: readonly StoredMessage[], read: ReadonlySet<string>) {
  return messages.filter((message) => !message.outgoing && !message.channelOutgoing && !read.has(message.id))
}

export function oldestUnreadReceipt(messages: readonly StoredMessage[]) {
  const time = (message: StoredMessage) =>
    message.timestamp !== null && Number.isFinite(message.timestamp) ? message.timestamp : Infinity
  return messages.reduce<StoredMessage | undefined>((oldest, message) => (
    !oldest || time(message) < time(oldest) ? message : oldest
  ), undefined)
}

export function messageVisibility(messages: readonly StoredMessage[], hidePossibleRepeats: boolean) {
  const repeats = possibleRepeats(messages)
  return {
    repeats,
    visible: hidePossibleRepeats ? messages.filter((message) => !repeats.has(message.id)) : messages,
  }
}

export function receiptPathDescription(pathLength: number) {
  if (pathLength === 0xff) return 'Direct receipt'
  if (!Number.isInteger(pathLength) || pathLength < 0 || pathLength > 0xff || pathLength >>> 6 === 3) {
    return 'Unsupported path metadata'
  }
  const hops = pathLength & 63
  const width = (pathLength >>> 6) + 1
  return `${hops} path hop${hops === 1 ? '' : 's'} · ${width}-byte path hashes`
}
