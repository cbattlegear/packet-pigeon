import { channelSender, validSenderName } from '../channels/senders.ts'
import type { StoredContact, StoredMessage } from '../storage/index.ts'

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

export function mentionableName(name: string) {
  return validSenderName(name) && !name.includes(']')
}

export function channelMentionNames(contacts: readonly StoredContact[], messages: readonly StoredMessage[], index: number) {
  const names = new Set(contacts.filter((contact) => contact.details?.type === 1 && mentionableName(contact.name))
    .map((contact) => contact.name))
  for (const message of messages) {
    if (message.receipt?.kind !== 'channel-text' || message.receipt.channelIndex !== index) continue
    const name = channelSender(message)
    if (name && mentionableName(name)) names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0))
}

export type ChannelTextPart = { kind: 'text'; text: string } | { kind: 'mention'; name: string }

export function channelTextParts(text: string): ChannelTextPart[] {
  const parts: ChannelTextPart[] = []
  let end = 0
  for (const match of text.matchAll(/@\[([^\]\r\n]+)\]/gu)) {
    if (match.index > end) parts.push({ kind: 'text', text: text.slice(end, match.index) })
    parts.push({ kind: 'mention', name: match[1] })
    end = match.index + match[0].length
  }
  if (end < text.length) parts.push({ kind: 'text', text: text.slice(end) })
  return parts
}

function mention(name: string) {
  if (!mentionableName(name)) throw new Error('This name cannot be represented as a mention.')
  return `@[${name}]`
}

export function channelReply(name: string, body: string, draft: string) {
  const source = body.replace(/^@\[[^\]\r\n]+\]\s*/u, '')
  const characters = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(source), ({ segment }) => segment) : Array.from(source)
  const preview = characters.slice(0, 10).join('').replace(/\r\n|[\s\u0085]/gu, ' ')
  return `${mention(name)}\n>${preview}${characters.length > 10 ? '..' : ''}\n${draft}`
}

export function insertChannelMention(draft: string, name: string, selectionStart: number, selectionEnd: number) {
  const start = Math.max(0, Math.min(draft.length, selectionStart))
  const end = Math.max(start, Math.min(draft.length, selectionEnd))
  const prefix = draft.slice(0, start)
  const query = start === end ? /(?:^|\s)@([^\s@[\]]*)$/u.exec(prefix) : null
  const before = query ? prefix.slice(0, -(query[1].length + 1)) : prefix
  const after = draft.slice(end)
  const leading = before && !/\s$/u.test(before) ? ' ' : ''
  const trailing = after && /^\s/u.test(after) ? '' : ' '
  const inserted = `${leading}${mention(name)}${trailing}`
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length + (trailing || !after ? 0 : 1),
  }
}
