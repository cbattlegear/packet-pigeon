import { contactPublicKey } from './contact-commands.ts'
import { Command, CompanionError, Response } from './protocol.ts'

export const maxDirectTextBytes = 150
export const maxDirectAttempts = 8

function bytesFromKey(publicKey: string) {
  return Uint8Array.from(contactPublicKey(publicKey).match(/../g)!, (pair) => Number.parseInt(pair, 16))
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function directTextBytes(text: string) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length === 0 || bytes.length > maxDirectTextBytes || text.includes('\0')
    || new TextDecoder().decode(bytes) !== text) {
    throw new Error(`Enter a message of 1 to ${maxDirectTextBytes} valid UTF-8 bytes without NUL characters.`)
  }
  return bytes
}

function validateAttempt(timestamp: number, attempt: number) {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff
    || !Number.isInteger(attempt) || attempt < 0 || attempt >= maxDirectAttempts) {
    throw new Error('Invalid direct-message timestamp or attempt.')
  }
}

export function directMessageCommand(recipient: string, timestamp: number, attempt: number, text: string) {
  validateAttempt(timestamp, attempt)
  const body = directTextBytes(text)
  const command = new Uint8Array(13 + body.length)
  command.set([Command.sendDirect, 0, attempt])
  new DataView(command.buffer).setUint32(3, timestamp, true)
  command.set(bytesFromKey(recipient).subarray(0, 6), 7)
  command.set(body, 13)
  return command
}

export function resetPathCommand(recipient: string) {
  return Uint8Array.of(Command.resetPath, ...bytesFromKey(recipient))
}

export async function expectedDirectAck(sender: string, timestamp: number, attempt: number, text: string) {
  validateAttempt(timestamp, attempt)
  const body = directTextBytes(text)
  const input = new Uint8Array(5 + body.length + 32)
  new DataView(input.buffer).setUint32(0, timestamp, true)
  input[4] = attempt & 3
  input.set(body, 5)
  input.set(bytesFromKey(sender), 5 + body.length)
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot calculate message acknowledgements.')
  const digest = await crypto.subtle.digest('SHA-256', input)
  return hex(new Uint8Array(digest, 0, 4))
}

export type DirectSendReceipt = {
  route: 'direct' | 'flood'
  expectedAck: string
  timeoutMs: number
}

export function decodeDirectSent(frame: Uint8Array): DirectSendReceipt {
  if (frame[0] !== Response.sent || frame.length < 10 || (frame[1] !== 0 && frame[1] !== 1)) {
    throw new CompanionError('protocol', 'Invalid direct-message send response.')
  }
  return {
    route: frame[1] === 0 ? 'direct' : 'flood',
    expectedAck: hex(frame.subarray(2, 6)),
    timeoutMs: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(6, true),
  }
}

export function decodeDirectAck(payload: Uint8Array) {
  if (payload.length < 8) throw new CompanionError('protocol', 'Truncated message acknowledgement.')
  return {
    code: hex(payload.subarray(0, 4)),
    roundTripMs: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true),
  }
}
