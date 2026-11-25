import type { RadioData, StoredContact, StoredMessage } from '../storage/index.ts'

export type Conversation = {
  id: string
  title: string
  description: string
  recipient: string | null
  messages: StoredMessage[]
}

export function conversations(data: RadioData): Conversation[] {
  const contacts = new Map(data.contacts.map((contact) => [contact.publicKey.toLowerCase(), contact]))
  const prefixes = new Map<string, StoredContact[]>()
  for (const contact of data.contacts) {
    const prefix = contact.publicKey.slice(0, 12).toLowerCase()
    prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), contact])
  }
  const names = new Map((data.contactPreferences ?? []).map((entry) => [entry.publicKey, entry.customName]))
  const byId = new Map<string, Conversation>()

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
    return { id, title, description, recipient, messages: [] }
  }

  function add(id: string) {
    let conversation = byId.get(id)
    if (!conversation) {
      if (id.startsWith('direct:')) {
        conversation = direct(id)
      } else if (id.startsWith('channel:')) {
        const index = Number(id.slice('channel:'.length))
        const channel = data.channels.find((entry) => entry.index === index)
        conversation = { id, title: channel?.name || `Channel ${index}`, description: 'Received channel entries', recipient: null, messages: [] }
      } else {
        conversation = { id, title: 'Unrecognized responses', description: 'Raw bytes are preserved for inspection.', recipient: null, messages: [] }
      }
      byId.set(id, conversation)
    }
    return conversation
  }

  for (const contact of data.contacts) {
    if (contact.details?.type === 1 || contact.details?.type === 3) add(`direct:${contact.publicKey.toLowerCase()}`)
  }
  for (const message of data.messages) {
    let id = message.outgoing ? `direct:${message.outgoing.recipient}` : message.conversationId
    if (id.startsWith('direct:')) {
      const key = id.slice('direct:'.length).toLowerCase()
      const matches = prefixes.get(key.slice(0, 12)) ?? []
      if (key.length === 12 && matches.length === 1) id = `direct:${matches[0].publicKey.toLowerCase()}`
      else id = `direct:${key}`
    }
    add(id).messages.push(message)
  }
  return [...byId.values()].sort((first, second) => {
    const latest = (conversation: Conversation) => Math.max(0, ...conversation.messages.map((message) => message.timestamp ?? 0))
    return latest(second) - latest(first) || first.title.localeCompare(second.title) || first.id.localeCompare(second.id)
  })
}

export function possibleRepeats(messages: readonly StoredMessage[]) {
  const seen = new Set<string>()
  const repeats = new Set<string>()
  for (const message of messages) {
    const receipt = message.receipt
    if (!receipt || receipt.kind === 'channel-data') continue
    const origin = receipt.kind === 'direct-text'
      ? `${receipt.senderKeyPrefix}:${receipt.signatureHex ?? ''}` : String(receipt.channelIndex)
    const identity = JSON.stringify([receipt.kind, origin, receipt.senderTimestamp, receipt.textType, receipt.text])
    if (seen.has(identity)) repeats.add(message.id)
    seen.add(identity)
  }
  return repeats
}
