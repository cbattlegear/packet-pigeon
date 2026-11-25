import { Command, CompanionError, Response, decodeChannel } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

const encoder = new TextEncoder()
const publicKey = '8b3387e9c5cdea6ac9e5edbaa115cd72'

export function channelName(name: string) {
  const trimmed = name.trim()
  if (!trimmed || trimmed.includes('\0') || encoder.encode(trimmed).length > 31) {
    throw new Error('Channel names must be 1–31 UTF-8 bytes and cannot contain NUL.')
  }
  return trimmed
}

export function parseChannelSecret(value: string) {
  const hex = value.trim()
  if (!/^[\da-f]{32}$/i.test(hex) || /^0{32}$/.test(hex)) {
    throw new Error('The private secret must be 32 hexadecimal characters and cannot be all zero.')
  }
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16))
}

export async function makeChannelSecret(kind: 'private' | 'join' | 'public' | 'hashtag', name: string, value: string) {
  if (kind === 'join') return parseChannelSecret(value)
  if (kind === 'public') return parseChannelSecret(publicKey)
  if (kind === 'hashtag') {
    if (!name.startsWith('#') || name.length < 2) throw new Error('Hashtag names must start with # and include a topic.')
    return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(name))).slice(0, 16)
  }
  const secret = crypto.getRandomValues(new Uint8Array(16))
  if (secret.every((byte) => byte === 0)) throw new Error('Could not generate a private secret. Try again.')
  return secret
}

export function secretHex(secret: Uint8Array) {
  return Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function readChannelSlot(link: SerialLink, index: number) {
  return link.request(Uint8Array.of(Command.channel, index), (frame) => {
    if (frame[0] === Response.error && frame[1] === 2) return { value: null }
    expectResponse(frame, Response.channelInfo)
    const channel = decodeChannel(frame, index)
    return { value: { channel, secret: frame.slice(34, 50) } }
  })
}

export async function writeChannelSlot(link: SerialLink, index: number, name: string, secret: Uint8Array) {
  const command = new Uint8Array(50)
  command[0] = 32
  command[1] = index
  command.set(encoder.encode(name), 2)
  command.set(secret, 34)
  const result = await link.request(command, (frame) => {
    if (frame[0] !== Response.error && frame[0] !== Response.disabled) expectResponse(frame, Response.ok)
    return { value: frame[0] === Response.ok ? null : frame[1] }
  })
  if (result !== null) {
    throw new CompanionError('device-error', `The radio rejected the channel change (device error ${result ?? 'unknown'}).`)
  }
}
