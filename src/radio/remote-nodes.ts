import { contactPublicKey } from './contact-commands.ts'
import { decodeDirectSent, directMessageCommand, maxDirectTextBytes } from './direct-message.ts'
import type { DirectSendReceipt } from './direct-message.ts'
import type { CompanionPush } from './companion-session.ts'
import { Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import { maxRoomTextBytes } from './node-access.ts'
import type { RemoteNodeAccess, RemoteNodeRole } from './node-access.ts'

export type RemoteNodeClient = { prefix: string; permissions: number; role: RemoteNodeRole }

type PushSubscription = (listener: (push: CompanionPush) => void) => () => void
type Reply<T> = { value: T } | { error: unknown } | null
class RemoteLoginRejected extends Error {}
export class RemoteLoginUnconfirmed extends Error {}
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const roles = ['guest', 'read-only', 'read-write', 'admin'] as const

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function keyBytes(key: string) {
  return Uint8Array.from(contactPublicKey(key).match(/../g)!, (pair) => parseInt(pair, 16))
}

export function nodeRole(permissions: number): RemoteNodeRole {
  return roles[permissions & 3]
}

async function requestWithPush<T>(link: SerialLink, command: Uint8Array, subscribe: PushSubscription,
  signal: AbortSignal, match: (push: CompanionPush, sent: DirectSendReceipt) => T | undefined, onSent?: () => void) {
  signal.throwIfAborted()
  let sent: DirectSendReceipt | undefined
  let settle!: (reply: Reply<T>) => void
  const reply = new Promise<Reply<T>>((resolve) => { settle = resolve })
  const stop = () => settle(null)
  const unsubscribe = subscribe((push) => {
    if (!sent) return
    try {
      const value = match(push, sent)
      if (value !== undefined) settle({ value })
    } catch (error) { settle({ error }) }
  })
  signal.addEventListener('abort', stop, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const accepted = await link.request(command, (frame) => {
      // A confirmation and the remote push can arrive in the same read.
      if (frame[0] === Response.sent) {
        sent = decodeDirectSent(frame)
        onSent?.()
      }
      return { value: frame }
    })
    expectResponse(accepted, Response.sent)
    if (!sent) throw new Error('The radio did not confirm the request.')
    signal.throwIfAborted()
    timer = setTimeout(stop, Math.min(120_000, Math.max(1_000, sent.timeoutMs)))
    const result = await reply
    signal.throwIfAborted()
    if (!result) throw new Error('No reply arrived before the deadline. Check the node’s range, route, and access settings.')
    if ('error' in result) throw result.error
    return result.value
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    unsubscribe()
  }
}

export function parseRemoteLogin(push: CompanionPush, publicKey: string, route: DirectSendReceipt['route']): RemoteNodeAccess | undefined {
  const { code, payload } = push
  if ((code !== 0x85 && code !== 0x86) || payload.length < 7 || hex(payload.subarray(1, 7)) !== publicKey.slice(0, 12)) return
  if (code === 0x86) throw new RemoteLoginRejected('The node rejected the login.')
  const permissions = payload.length >= 13 ? payload[11] : null
  return { role: permissions === null ? null : nodeRole(permissions), permissions, firmware: payload[12] ?? null, route }
}

export async function loginRemoteNode(link: SerialLink, publicKey: string, password: string,
  subscribe: PushSubscription, signal: AbortSignal) {
  const bytes = encoder.encode(password)
  try {
    if (bytes.length > 15 || password.includes('\0') || decoder.decode(bytes) !== password) {
      throw new Error('The node password must be at most 15 UTF-8 bytes without NUL characters.')
    }
    const command = Uint8Array.of(26, ...keyBytes(publicKey), ...bytes)
    let queued = false
    try {
      return await requestWithPush(link, command, subscribe, signal,
        (push, { route }) => parseRemoteLogin(push, publicKey, route), () => { queued = true })
    } catch (error) {
      if (queued && !(error instanceof RemoteLoginRejected)) {
        throw new RemoteLoginUnconfirmed('The login reply is unconfirmed. Reconnect before trying this node again. A late reply is still possible after reconnecting.',
          { cause: error })
      }
      throw error
    } finally { command.fill(0) }
  } finally { bytes.fill(0) }
}

export function requestRemoteNodeData(link: SerialLink, publicKey: string, payload: Uint8Array,
  subscribe: PushSubscription, signal: AbortSignal) {
  return requestWithPush(link, Uint8Array.of(50, ...keyBytes(publicKey), ...payload), subscribe, signal,
    ({ code, payload }, { expectedAck }) => code === 0x8c && payload[0] === 0 && hex(payload.subarray(1, 5)) === expectedAck
      ? payload.slice(5) : undefined)
}

export function parseRemoteNodeClients(payload: Uint8Array): RemoteNodeClient[] {
  if (payload.length % 7 !== 0) throw new Error('The node returned an incomplete access list.')
  const rows: RemoteNodeClient[] = []
  for (let offset = 0; offset < payload.length; offset += 7) {
    const permissions = payload[offset + 6]
    rows.push({ prefix: hex(payload.subarray(offset, offset + 6)), permissions, role: nodeRole(permissions) })
  }
  return rows
}

export function parseRoomStatus(payload: Uint8Array) {
  if (payload.length < 24) throw new Error('The server returned an incomplete status report.')
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return { batteryVolts: data.getUint16(0, true) / 1_000, queueSize: data.getUint16(2, true),
    noiseFloorDbm: data.getInt16(4, true), packetsReceived: data.getUint32(8, true), uptimeSeconds: data.getUint32(20, true) }
}

export type RemoteNodeAdmin =
  | { kind: 'allow-read-only'; enabled: boolean }
  | { kind: 'room-announcement'; text: string }
  | { kind: 'client-permissions'; publicKey: string; permissions: number }
  | { kind: 'name'; value: string }

function validText(value: string, limit: number) {
  const text = value.trim()
  const bytes = encoder.encode(text)
  if (!text || bytes.length > limit || bytes.some((byte) => byte < 32 || byte === 127) || decoder.decode(bytes) !== text) {
    throw new Error(`Enter 1 to ${limit} UTF-8 bytes without control characters.`)
  }
  return text
}

export function remoteNodeAdminText(action: RemoteNodeAdmin, nodeType: 3 | 4) {
  if (action.kind === 'client-permissions') {
    if (!Number.isInteger(action.permissions) || action.permissions < 0 || action.permissions > 255) {
      throw new Error('Enter valid client permissions.')
    }
    return `setperm ${contactPublicKey(action.publicKey)} ${action.permissions}`
  }
  if (action.kind === 'name') return `set name ${validText(action.value, 31)}`
  if (nodeType !== 3) throw new Error('This action requires a room server.')
  if (action.kind === 'allow-read-only') return `set allow.read.only ${action.enabled ? 'on' : 'off'}`
  const prefix = 'room.post '
  return prefix + validText(action.text, Math.min(maxRoomTextBytes, maxDirectTextBytes - prefix.length))
}

export async function sendRemoteNodeAdmin(link: SerialLink, key: string, text: string) {
  // The companion supplies the radio timestamp for CLI traffic.
  const command = directMessageCommand(key, 0, 0, text)
  command[1] = 1
  const frame = await link.request(command, (frame) => ({ value: frame }))
  expectResponse(frame, Response.sent)
  return decodeDirectSent(frame).route
}
