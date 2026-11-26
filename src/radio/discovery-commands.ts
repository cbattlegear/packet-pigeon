import { CompanionError, decodeContact, Response } from './protocol.ts'
import type { CompanionContact } from './protocol.ts'
import type { SerialLink } from './serial-link.ts'
import { expectResponse } from './serial-link.ts'
import { contactPublicKey } from './contact-commands.ts'
import { decodeContactPath } from './contact-path.ts'
import type { ContactPathWidth } from './contact-path.ts'
import type { CompanionPush } from './companion-session.ts'

export type AdvertPath = { receivedAt: number; hops: number; width: number; hex: string }
export type AutoAddPolicy = { flags: number; maxHops?: number | null; selectedRoles: boolean }
export type NearbyNode = {
  publicKey: string
  type: 1 | 2 | 3 | 4
  outboundSnrDb: number
  inboundSnrDb: number
  rssiDbm: number
}
export type RepeaterDetails =
  | { kind: 'regions'; regions: string[] }
  | { kind: 'owner'; name: string; owner: string }
export type RepeaterRequestOptions = {
  expectedRoute: { pathLength: number; pathHex: string } | null
  replyPath: { width: ContactPathWidth; text: string }
}

type PushSubscription = (listener: (push: CompanionPush) => void) => () => void

const keyBytes = (key: string) => Uint8Array.from(contactPublicKey(key).match(/../g)!, (byte) => parseInt(byte, 16))
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
export const advertCachePrefixLength = 14
export const nearbyWindowMs = 20_000

export function decodeAdvert(code: number, payload: Uint8Array): {
  publicKey: string; contact?: CompanionContact; added: boolean
} | null {
  if (code === 0x80 && payload.length === 32) return { publicKey: hex(payload), added: true }
  if (code !== 0x8a || payload.length !== 147) return null
  const contact = decodeContact(Uint8Array.of(Response.contact, ...payload))
  return { publicKey: contact.publicKey, contact, added: false }
}

async function discoveryResponse(link: SerialLink, command: Uint8Array, response: number) {
  return link.request(command, (frame) => {
    if (frame[0] !== Response.error && frame[0] !== Response.disabled) {
      expectResponse(frame, response)
      if (response === 0 && frame.length !== 1) {
        throw new CompanionError('protocol', 'The radio returned an invalid discovery acknowledgement.')
      }
    }
    return { value: frame }
  })
}

function checkResponse(frame: Uint8Array) {
  if (frame[0] === Response.disabled || (frame[0] === Response.error && frame[1] === 1)) {
    throw new CompanionError('unsupported-firmware', 'This firmware does not support this discovery setting or command.')
  }
  if (frame[0] === Response.error) throw new CompanionError('device-error', 'The radio rejected the discovery command.')
}

function signedByte(value: number) {
  return value < 128 ? value : value - 256
}

export function decodeNearbyNode(push: CompanionPush, tag: number): NearbyNode | null {
  const { code, payload } = push
  const type = payload[3] & 0x0f
  if (code !== 0x8e || payload.length !== 41 || payload[2] !== 0
    || (payload[3] & 0xf0) !== 0x90 || (type !== 1 && type !== 2 && type !== 3 && type !== 4)
    || new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(5, true) !== tag) return null
  return {
    publicKey: hex(payload.subarray(9)),
    type,
    outboundSnrDb: signedByte(payload[4]) / 4,
    inboundSnrDb: signedByte(payload[0]) / 4,
    rssiDbm: signedByte(payload[1]),
  }
}

export async function sendNearbyRequest(link: SerialLink, tag: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const command = new Uint8Array(11)
  command.set([55, 0x80, 0x1e])
  new DataView(command.buffer).setUint32(3, tag, true)
  checkResponse(await discoveryResponse(link, command, Response.ok))
}

function waitForWindow(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, nearbyWindowMs)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function scanNearby(
  send: (tag: number) => Promise<void>,
  subscribe: PushSubscription,
  signal: AbortSignal,
  onNode: (node: NearbyNode) => void,
  onListening: () => void,
) {
  signal.throwIfAborted()
  const tag = crypto.getRandomValues(new Uint32Array(1))[0]
  const early = new Map<string, NearbyNode>()
  let listening = false
  const stopListening = subscribe((push) => {
    if (signal.aborted) return
    const node = decodeNearbyNode(push, tag)
    if (!node) return
    if (listening) onNode(node)
    else if (early.size < 200 || early.has(node.publicKey)) early.set(node.publicKey, node)
  })
  try {
    await send(tag)
    signal.throwIfAborted()
    listening = true
    onListening()
    for (const node of early.values()) onNode(node)
    await waitForWindow(signal)
  } finally {
    stopListening()
  }
}

function decodeRepeaterDetails(payload: Uint8Array, kind: RepeaterDetails['kind']): RepeaterDetails {
  if (payload.length < 9) throw new CompanionError('protocol', 'The repeater returned a truncated discovery reply.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(9))
  } catch (cause) {
    throw new CompanionError('protocol', 'The repeater returned invalid UTF-8.', { cause })
  }
  if (kind === 'regions') {
    const regions = text ? text.split(',') : []
    if (regions.some((region) => !region || /\p{Cc}/u.test(region))) {
      throw new CompanionError('protocol', 'The repeater returned an invalid region list.')
    }
    return { kind, regions: [...new Set(regions)] }
  }
  const separator = text.indexOf('\n')
  if (separator < 0 || text.includes('\0')) {
    throw new CompanionError('protocol', 'The repeater returned invalid owner information.')
  }
  return { kind, name: text.slice(0, separator), owner: text.slice(separator + 1) }
}

export async function requestRepeaterDetails(
  link: SerialLink,
  key: string,
  kind: RepeaterDetails['kind'],
  subscribe: PushSubscription,
  signal: AbortSignal,
  onWaiting: () => void,
  replyPath: { encoded: number; hex: string } = { encoded: 0, hex: '' },
  routed = false,
): Promise<RepeaterDetails> {
  signal.throwIfAborted()
  const decodedPath = decodeContactPath(replyPath.encoded, replyPath.hex)
  if (!decodedPath || replyPath.hex.length !== decodedPath.hops.length * decodedPath.width * 2) {
    throw new Error('The reply path is invalid.')
  }
  const pathBytes = Uint8Array.from(replyPath.hex.match(/../g) ?? [], (byte) => parseInt(byte, 16))
  let tag: number | undefined
  const early = new Map<number, Uint8Array>()
  let settle!: (payload: Uint8Array | null) => void
  const response = new Promise<Uint8Array | null>((resolve) => { settle = resolve })
  const stopListening = subscribe(({ code, payload }) => {
    if (signal.aborted || code !== 0x8c || payload.length < 5) return
    const received = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true)
    if (tag === received) settle(payload)
    else if (tag === undefined && early.size < 64) early.set(received, payload)
  })
  const abort = () => settle(null)
  signal.addEventListener('abort', abort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const reply = await discoveryResponse(link,
      Uint8Array.of(57, ...keyBytes(key), kind === 'regions' ? 1 : 2, replyPath.encoded, ...pathBytes), Response.sent)
    checkResponse(reply)
    if (reply.length !== 10 || reply[1] > 1) {
      throw new CompanionError('protocol', 'The radio did not confirm a direct discovery request.')
    }
    if (reply[1] === 1) {
      throw new CompanionError('protocol', 'The radio sent the request by a flood route instead of a direct route. Check its route before retrying.')
    }
    const receipt = new DataView(reply.buffer, reply.byteOffset, reply.byteLength)
    tag = receipt.getUint32(2, true)
    signal.throwIfAborted()
    onWaiting()
    if (early.has(tag)) settle(early.get(tag)!)
    const wait = routed || decodedPath.hops.length
      ? 120_000 : Math.min(30_000, Math.max(5_000, receipt.getUint32(6, true) + 2_000))
    timeout = setTimeout(() => settle(null), wait)
    const result = await response
    signal.throwIfAborted()
    if (!result) throw new Error('No repeater reply arrived before the timeout. The repeater may not support this request.')
    return decodeRepeaterDetails(result, kind)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    stopListening()
  }
}

export async function readNoiseFloor(link: SerialLink): Promise<number> {
  const response = await discoveryResponse(link, Uint8Array.of(56, 1), 24)
  checkResponse(response)
  if (response.length !== 14 || response[1] !== 1) {
    throw new CompanionError('protocol', 'The radio returned invalid radio statistics.')
  }
  return new DataView(response.buffer, response.byteOffset, response.byteLength).getInt16(2, true)
}

export async function readAdvertPath(link: SerialLink, key: string): Promise<AdvertPath | null> {
  const response = await discoveryResponse(link, Uint8Array.of(42, 0, ...keyBytes(key)), 22)
  if (response[0] === Response.error && response[1] === 2) return null
  checkResponse(response)
  const length = response[5]
  const hops = length & 63
  const width = (length >> 6) + 1
  if (response.length < 6 || width > 3 || response.length !== 6 + hops * width || hops * width > 64) {
    throw new CompanionError('protocol', 'The radio returned an invalid or fragmented advert path.')
  }
  const receivedAt = new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(1, true) * 1000
  return { receivedAt, hops, width, hex: hex(response.slice(6)) }
}

export async function readAutoAddPolicy(link: SerialLink, contactMode: number): Promise<AutoAddPolicy> {
  const reply = await discoveryResponse(link, Uint8Array.of(59), 25)
  checkResponse(reply)
  if (reply.length < 2 || reply.length > 3 || reply[2] > 64) {
    throw new CompanionError('protocol', 'The radio returned an invalid auto-add policy.')
  }
  return {
    flags: reply[1],
    ...(reply.length === 3 ? { maxHops: reply[2] === 0 ? null : reply[2] - 1 } : {}),
    selectedRoles: (contactMode & 1) !== 0,
  }
}

export async function writeAutoAddPolicy(link: SerialLink, policy: AutoAddPolicy, contactMode: number) {
  const current = await readAutoAddPolicy(link, contactMode)
  if (policy.maxHops !== undefined && policy.maxHops !== null
    && (!Number.isInteger(policy.maxHops) || policy.maxHops < 0 || policy.maxHops > 63)) {
    throw new Error('Enter a hop limit from 0 through 63.')
  }
  if (!Number.isInteger(policy.flags) || policy.flags < 0 || policy.flags > 0x1f) throw new Error('The auto-add roles are invalid.')
  if (policy.maxHops !== undefined && current.maxHops === undefined) {
    throw new Error('This firmware does not expose a configurable hop limit.')
  }
  const flags = (current.flags & ~0x1f) | policy.flags
  const max = policy.maxHops === null ? 0 : policy.maxHops === undefined ? undefined : policy.maxHops + 1
  checkResponse(await discoveryResponse(link, Uint8Array.of(58, flags, ...(max === undefined ? [] : [max])), 0))
  const mode = (contactMode & ~1) | Number(policy.selectedRoles)
  if (mode !== contactMode) {
    try {
      checkResponse(await discoveryResponse(link, Uint8Array.of(38, mode), 0))
    } catch (cause) {
      throw new CompanionError('device-error', 'Auto-add settings were saved, but the radio mode could not be changed. Reconnect and check the policy.', { cause })
    }
  }
  return { mode, policy: await readAutoAddPolicy(link, mode) }
}
