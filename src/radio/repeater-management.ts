import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import type { CompanionPush } from './companion-session.ts'

type Subscribe = (listener: (push: CompanionPush) => void) => () => void
export type RepeaterLogin = { role: 'admin' | 'guest' | 'guest-or-legacy'; route: 'direct' | 'flood' }
export type RepeaterStatus = {
  batteryMv: number; queue: number; noiseFloor: number; rssi: number; snr: number
  received: number; sent: number; uptime: number; txAir: number
}

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
  try {
    signal.throwIfAborted()
    const receipt = await link.request(command, (frame) => {
      accepted = frame[0] === Response.sent && frame.length === 10 && frame[1] <= 1
      return { value: frame }
    })
    expectResponse(receipt, Response.sent)
    if (!accepted) throw new CompanionError('protocol', 'The radio returned an invalid repeater request confirmation.')
    signal.throwIfAborted()
    const estimate = new DataView(receipt.buffer, receipt.byteOffset, receipt.byteLength).getUint32(6, true)
    timer = setTimeout(abort, Math.min(120_000, Math.max(10_000, estimate + 5_000)))
    const push = await response
    signal.throwIfAborted()
    if (!push) throw new Error('No repeater reply arrived before the timeout. The request may still have reached the repeater.')
    if (operation === 'login') {
      if (push.code === 0x86) throw new Error('The repeater rejected the login.')
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
      snr: data.getInt16(42, true) / 4,
    }
  } finally {
    command.fill(0)
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    stop()
  }
}
