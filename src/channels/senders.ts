import type { StoredMessage } from '../storage/index.ts'

const encoder = new TextEncoder()

export function validSenderName(name: string) {
  if (typeof name !== 'string' || !name.trim() || name.includes(': ') || encoder.encode(name).length > 31) return false
  for (const character of name) {
    const code = character.codePointAt(0)!
    if (code < 32 || code === 127) return false
  }
  return true
}

export function channelSender(message: StoredMessage): string | null {
  const receipt = message.receipt
  if (!receipt || receipt.kind !== 'channel-text' || receipt.textType !== 0) return null
  const separator = receipt.text.indexOf(': ')
  if (separator <= 0) return null
  const name = receipt.text.slice(0, separator)
  return validSenderName(name) ? name : null
}

export function isBlockedChannelMessage(message: StoredMessage, blocked: ReadonlySet<string>) {
  const sender = channelSender(message)
  return sender !== null && blocked.has(sender)
}

export function observedChannelSenders(messages: readonly StoredMessage[], index: number) {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (message.receipt?.kind !== 'channel-text' || message.receipt.channelIndex !== index) continue
    const sender = channelSender(message)
    if (sender !== null) counts.set(sender, (counts.get(sender) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
