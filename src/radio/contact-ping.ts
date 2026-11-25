import type { CompanionPush } from './companion-session.ts'
import { Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

export type PingHashWidth = 1 | 2 | 4

const traceCommand = 36
const traceResponse = 0x89

export type ContactPingResult = {
  elapsedMs: number
  outboundSnrDb: number
  returnSnrDb: number
}

function signalDb(value: number) {
  return (value < 128 ? value : value - 256) / 4
}

export function contactPingWidth(version: number, width: PingHashWidth) {
  return width === 1 || (version >= 10 && (width === 2 || width === 4))
}

export async function sendContactPing(
  link: SerialLink,
  publicKey: string,
  width: PingHashWidth,
  subscribe: (listener: (push: CompanionPush) => void) => () => void,
  signal: AbortSignal,
): Promise<ContactPingResult> {
  signal.throwIfAborted()
  const tag = crypto.getRandomValues(new Uint32Array(1))[0]
  const prefix = Uint8Array.from({ length: width }, (_, index) => Number.parseInt(publicKey.slice(index * 2, (index + 1) * 2), 16))
  const flags = width === 1 ? 0 : width === 2 ? 1 : 2
  const wire = new Uint8Array(10 + width)
  wire[0] = traceCommand
  new DataView(wire.buffer).setUint32(1, tag, true)
  wire[9] = flags
  wire.set(prefix, 10)

  let settle!: (result: ContactPingResult | null) => void
  const response = new Promise<ContactPingResult | null>((resolve) => { settle = resolve })
  const abort = () => settle(null)
  const started = performance.now()
  const stopListening = subscribe(({ code, payload }) => {
    if (code !== traceResponse || payload.length !== 13 + width || payload[1] !== width || payload[2] !== flags) return
    const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    if (header.getUint32(3, true) !== tag || header.getUint32(7, true) !== 0 ||
      !prefix.every((byte, index) => payload[11 + index] === byte)) return
    settle({
      elapsedMs: Math.round(performance.now() - started),
      outboundSnrDb: signalDb(payload[11 + width]),
      returnSnrDb: signalDb(payload[12 + width]),
    })
  })
  signal.addEventListener('abort', abort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const accepted = await link.request(wire, (frame) => {
      if (frame[0] !== Response.error && frame[0] !== Response.disabled) expectResponse(frame, Response.sent)
      return { value: frame }
    })
    if (accepted[0] === Response.disabled) throw new Error('This firmware does not support a contact ping.')
    expectResponse(accepted, Response.sent)
    if (accepted.length !== 10) throw new Error('The radio did not confirm the ping tag.')
    const receipt = new DataView(accepted.buffer, accepted.byteOffset, accepted.byteLength)
    if (receipt.getUint32(2, true) !== tag) throw new Error('The radio confirmed a different ping tag.')
    signal.throwIfAborted()
    timeout = setTimeout(abort, Math.min(30_000, Math.max(1_000, receipt.getUint32(6, true))))
    const result = await response
    signal.throwIfAborted()
    if (!result) throw new Error('No ping reply was received before the deadline.')
    return result
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    stopListening()
  }
}
