import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import type { CompanionPush } from './companion-session.ts'

type Subscribe = (listener: (push: CompanionPush) => void) => () => void
export type RepeaterLogin = { role: 'admin' | 'guest' | 'guest-or-legacy'; route: 'direct' | 'flood' }
export type RepeaterStatus = {
  batteryMv: number; queue: number; noiseFloor: number; rssi: number; snr: number
  received: number; sent: number; uptime: number; txAir: number
  floodSent: number; directSent: number; floodReceived: number; directReceived: number
  errorEvents: number; directDuplicates: number; floodDuplicates: number
  rxAir: number | null; receiveErrors: number | null
}

export type RepeaterNeighborPage = {
  total: number
  entries: { publicKey: string; secondsAgo: number; snrDb: number }[]
}

export const repeaterNeighborOrders = ['newest', 'oldest', 'strongest', 'weakest'] as const
export type RepeaterNeighborOrder = typeof repeaterNeighborOrders[number]

export function repeaterNeighborRequest(offset: number, order: RepeaterNeighborOrder) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) {
    throw new Error('Choose a valid neighbor page offset.')
  }
  const orderCode = repeaterNeighborOrders.indexOf(order)
  if (orderCode < 0) throw new Error('Choose a valid neighbor order.')
  const request = Uint8Array.of(6, 0, 3, offset & 0xff, offset >> 8, orderCode, 32, 0, 0, 0, 0)
  crypto.getRandomValues(request.subarray(7))
  return request
}

export function parseRepeaterNeighborPage(payload: Uint8Array, offset: number): RepeaterNeighborPage {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff || payload.length < 4) {
    throw new Error('The repeater returned an invalid neighbor page.')
  }
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const total = data.getUint16(0, true)
  const count = data.getUint16(2, true)
  if (count > 3 || payload.length !== 4 + count * 37 || (count > 0 && offset + count > total)) {
    throw new Error('The repeater returned an invalid neighbor page.')
  }
  const entries: RepeaterNeighborPage['entries'] = []
  for (let i = 0; i < count; i++) {
    const start = 4 + i * 37
    entries.push({
      publicKey: Array.from(payload.subarray(start, start + 32), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      secondsAgo: data.getUint32(start + 32, true),
      snrDb: data.getInt8(start + 36) / 4,
    })
  }
  return { total, entries }
}

export class UncertainRepeaterRequestError extends Error {}

export async function repeaterRequest(
  link: SerialLink, key: string, operation: 'login' | 'status', password: string,
  subscribe: Subscribe, signal: AbortSignal,
): Promise<RepeaterLogin | RepeaterStatus> {
  const bytes = Uint8Array.from(key.match(/../g)!, (part) => parseInt(part, 16))
  const secret = new TextEncoder().encode(password)
  if (operation === 'login' && (secret.length > 15 || secret.includes(0))) {
    secret.fill(0)
    throw new Error('The password must be at most 15 UTF-8 bytes and cannot contain a null character.')
  }
  const command = operation === 'login'
    ? Uint8Array.of(26, ...bytes, ...secret, 0)
    : Uint8Array.of(27, ...bytes)
  secret.fill(0)
  let accepted = false
  let settle!: (push: CompanionPush | null) => void
  const response = new Promise<CompanionPush | null>((resolve) => { settle = resolve })
  const stop = subscribe((push) => {
    if (!accepted || signal.aborted || push.payload.length < 7 ||
      !bytes.subarray(0, 6).every((byte, i) => byte === push.payload[i + 1])) return
    if (operation === 'login' ? push.code === 0x85 || push.code === 0x86 : push.code === 0x87) settle(push)
  })
  const abort = () => settle(null)
  signal.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let dispatched = false
  let rejected = false
  try {
    signal.throwIfAborted()
    dispatched = true
    const receipt = await link.request(command, (frame) => {
      accepted = frame[0] === Response.sent && frame.length === 10 && frame[1] <= 1
      return { value: frame }
    })
    rejected = (receipt[0] === Response.error && receipt.length === 2) ||
      (receipt[0] === Response.disabled && receipt.length === 1)
    expectResponse(receipt, Response.sent)
    if (!accepted) throw new CompanionError('protocol', 'The radio returned an invalid repeater request confirmation.')
    signal.throwIfAborted()
    const estimate = new DataView(receipt.buffer, receipt.byteOffset, receipt.byteLength).getUint32(6, true)
    timer = setTimeout(abort, Math.min(120_000, Math.max(10_000, estimate + 5_000)))
    const push = await response
    signal.throwIfAborted()
    if (!push) throw new Error('No repeater reply arrived before the timeout. The request may still have reached the repeater.')
    if (operation === 'login') {
      if (push.code === 0x86) {
        rejected = push.payload.length === 7 && push.payload[0] === 0
        if (!rejected) throw new CompanionError('protocol', 'The repeater returned an invalid login rejection.')
        throw new Error('The repeater rejected the login.')
      }
      if (push.payload[0] > 1) throw new CompanionError('protocol', 'The repeater returned invalid login permissions.')
      return { role: push.payload[0] === 1 ? 'admin' : push.payload.length === 7 ? 'guest-or-legacy' : 'guest',
        route: receipt[1] === 1 ? 'flood' : 'direct' }
    }
    if (push.payload.length < 55) throw new CompanionError('protocol', 'The repeater returned a truncated status reply.')
    const data = new DataView(push.payload.buffer, push.payload.byteOffset + 7, push.payload.byteLength - 7)
    return {
      batteryMv: data.getUint16(0, true), queue: data.getUint16(2, true),
      noiseFloor: data.getInt16(4, true), rssi: data.getInt16(6, true),
      received: data.getUint32(8, true), sent: data.getUint32(12, true),
      txAir: data.getUint32(16, true), uptime: data.getUint32(20, true),
      floodSent: data.getUint32(24, true), directSent: data.getUint32(28, true),
      floodReceived: data.getUint32(32, true), directReceived: data.getUint32(36, true),
      errorEvents: data.getUint16(40, true),
      snr: data.getInt16(42, true) / 4,
      directDuplicates: data.getUint16(44, true), floodDuplicates: data.getUint16(46, true),
      rxAir: data.byteLength >= 52 ? data.getUint32(48, true) : null,
      receiveErrors: data.byteLength >= 56 ? data.getUint32(52, true) : null,
    }
  } catch (cause) {
    if (dispatched && !rejected) {
      const message = cause instanceof Error ? cause.message : 'The repeater request outcome is unknown.'
      throw new UncertainRepeaterRequestError(`${message} Reconnect before retrying.`, { cause })
    }
    throw cause
  } finally {
    command.fill(0)
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    stop()
  }
}
