export type ParsedReaction =
  | { format: 'meshcore'; emoji: string; hash: string; targetSender: string | null }
  | { format: 'open-v3'; emoji: string; hash: string }
  | { format: 'open-v1'; emoji: string; timestamp: number; senderHash: number; textHash: number }

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

export const reactionEmojiSupport = segmenter !== null

function characters(text: string) {
  return segmenter ? Array.from(segmenter.segment(text), ({ segment }) => segment) : []
}

export function isReactionEmoji(text: string) {
  const scalars = Array.from(text)
  return reactionEmojiSupport && characters(text).length === 1 && /^\p{Emoji}$/u.test(scalars[0] ?? '')
    && (text.codePointAt(0)! > 0x238c || scalars.length > 1)
}

// The index order is wire data: Open v3 sends the index, not the emoji itself.
export const openReactionEmojis = [
  '👍', '❤️', '😂', '🎉', '👏', '🔥',
  '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘',
  '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳', '😏',
  '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡',
  '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶',
  '👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤌', '🤏', '👈', '👉', '👆',
  '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗',
  '💖', '💘', '💝', '💟', '💌', '💢', '💥', '💫', '💦', '💨', '🕳️', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭',
  '🎉', '🎊', '🎈', '🎁', '🎀', '🪅', '🪆', '🏆', '🥇', '🥈', '🥉', '⚽', '⚾', '🥎', '🏀', '🏐',
  '🏈', '🏉', '🎾', '🥏', '🎳', '🏏', '🏑', '🏒', '🥍', '🏓', '🏸', '🥊', '🥋', '🥅', '⛳', '🔥',
  '⭐', '🌟', '✨', '⚡', '💡', '🔦', '🏮', '🪔', '📱', '💻', '⌚', '📷', '📺', '📻', '🎵', '🎶', '🚀',
]

export function parseReaction(text: string, channel: boolean): ParsedReaction | null {
  const v3 = /^r:([0-9a-f]{4}):([0-9a-f]{2})$/.exec(text)
  if (v3 && openReactionEmojis[parseInt(v3[2], 16)]) {
    return { format: 'open-v3', hash: v3[1], emoji: openReactionEmojis[parseInt(v3[2], 16)] }
  }
  // V1 allows a non-empty arbitrary reaction string; it is not restricted to one emoji.
  const v1 = /^r:([^]+):([^:]+)$/.exec(text)
  if (v1) {
    const fields = v1[1].split('_').filter(Boolean)
    if (fields.length === 3 && fields.every((field) => /^\+?\d+$/.test(field))) {
      const [millis, sender, body] = fields.map((field) => BigInt(field))
      if (millis <= 0xffffffffffffffffn && millis / 1000n <= 0xffffffffn
        && sender <= 0xffffffffn && body <= 0xffffffffn) {
        return { format: 'open-v1', emoji: v1[2], timestamp: Number(millis / 1000n),
          senderHash: Number(sender), textHash: Number(body) }
      }
    }
  }
  const split = text.lastIndexOf('\n')
  if (split < 0 || text[split - 1] === '\r') return null
  const encoded = text.slice(split + 1).toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1')
  if (encoded.length !== 8 || Array.from(encoded).some((char) => !alphabet.includes(char))) return null
  const head = characters(text.slice(0, split))
  const mention = head.findIndex((char, index) => char === '@' && head[index + 1] === '[')
  if (!channel) {
    const emoji = head.join('')
    return mention < 0 && isReactionEmoji(emoji)
      ? { format: 'meshcore', emoji, hash: encoded, targetSender: null } : null
  }
  if (mention < 0) return null
  const close = mention === 0 ? head.indexOf(']', 2) : head.length - 1
  if (close < mention + 3 || head[close] !== ']') return null
  const emoji = (mention === 0 ? head.slice(close + 1) : head.slice(0, mention)).join('')
  return isReactionEmoji(emoji) ? {
    format: 'meshcore', emoji, hash: encoded, targetSender: head.slice(mention + 2, close).join(''),
  } : null
}

export function dartStringHash(text: string) {
  let hash = 0
  for (let index = 0; index < text.length; index++) {
    hash = (hash + text.charCodeAt(index)) >>> 0
    hash = (hash + (hash << 10)) >>> 0
    hash = (hash ^ (hash >>> 6)) >>> 0
  }
  hash = (hash + (hash << 3)) >>> 0
  hash = (hash ^ (hash >>> 11)) >>> 0
  hash = (hash + (hash << 15)) & 0x3fffffff
  return hash || 1
}

export function openReactionHash(text: string, timestamp: number, sender: string | null) {
  return (dartStringHash(`${timestamp}${sender ?? ''}${text.slice(0, 5)}`) & 0xffff).toString(16).padStart(4, '0')
}

const hashes = new Map<string, Promise<string>>()

export function messageReactionHash(text: string, timestamp: number, cache = hashes): Promise<string> {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
    throw new Error('The reaction target has no valid wire timestamp.')
  }
  if (!globalThis.crypto?.subtle) throw new Error('Reaction matching needs Web Crypto in a secure browser context.')
  const key = JSON.stringify([text, timestamp])
  const cached = cache.get(key)
  if (cached) return cached
  const bytes = new TextEncoder().encode(text)
  const input = new Uint8Array(bytes.length + 4)
  input.set(bytes)
  new DataView(input.buffer).setUint32(bytes.length, timestamp, true)
  const result = crypto.subtle.digest('SHA-256', input).then((digest) => {
    const bytes = new Uint8Array(digest).slice(0, 5)
    let bits = 0n
    for (const byte of bytes) bits = (bits << 8n) | BigInt(byte)
    return Array.from({ length: 8 }, (_, index) => alphabet[Number((bits >> BigInt(35 - index * 5)) & 31n)]).join('')
  }).catch((error: unknown) => { cache.delete(key); throw error })
  if (cache === hashes && cache.size >= 2000) cache.delete(cache.keys().next().value!)
  cache.set(key, result)
  return result
}

export async function buildReaction(emoji: string, text: string, timestamp: number, sender: string | null) {
  if (!isReactionEmoji(emoji)) throw new Error('Choose exactly one emoji; this browser must support grapheme segmentation.')
  if (sender !== null && (!sender || sender.includes(']') || sender.includes('\n'))) {
    throw new Error('The target sender name cannot be represented in a reaction.')
  }
  return `${sender === null ? '' : `@[${sender}]`}${emoji}\n${await messageReactionHash(text, timestamp)}`
}

export function reactionChannelContent(wireText: string) {
  const chars = characters(wireText)
  const separator = chars.indexOf(':')
  if (separator <= 0) return null
  // Match the peer's channel-envelope whitespace set, without trimming newlines.
  const trim = (text: string) => text.replace(/^[\t \u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]+|[\t \u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]+$/gu, '')
  return { sender: trim(chars.slice(0, separator).join('')), text: trim(chars.slice(separator + 1).join('')) }
}
