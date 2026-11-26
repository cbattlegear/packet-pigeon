import type { CompanionPush } from './companion-session.ts'
import { Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

export type TraceHashWidth = 1 | 2 | 4
export type PingHashWidth = TraceHashWidth

const traceCommand = 36
const traceResponse = 0x89

export type ContactPingResult = {
  elapsedMs: number
  outboundSnrDb: number
  returnSnrDb: number
}

export type PathTraceResult = {
  elapsedMs: number
  hops: { hash: string; snrDb: number }[]
  returnSnrDb: number
}

export function parseTracePath(text: string, width: TraceHashWidth) {
  if (width !== 1 && width !== 2 && width !== 4) throw new Error('Choose a 1-, 2- or 4-byte trace hash.')
  const normalized = text.trim().toLowerCase()
  const sections = normalized ? normalized.split(/[,\s]+/) : []
  const size = width * 2
  if (!sections.length || sections.some((section) => !/^[0-9a-f]+$/.test(section) || section.length % size !== 0)) {
    throw new Error(`Enter complete ${width}-byte repeater hashes in the order to trace.`)
  }
  const path = sections.join('')
  const count = path.length / size
  const limit = Math.min(63, 64 / width)
  if (count > limit) throw new Error(`A ${width}-byte trace can contain at most ${limit} hops.`)
  return Array.from({ length: count }, (_, index) => path.slice(index * size, (index + 1) * size))
}

function signalDb(value: number) {
  return (value < 128 ? value : value - 256) / 4
}

export function contactPingWidth(version: number, width: PingHashWidth) {
  return width === 1 || (version >= 10 && (width === 2 || width === 4))
}

export async function sendPathTrace(
  link: SerialLink,
  hashes: readonly string[],
  width: TraceHashWidth,
  subscribe: (listener: (push: CompanionPush) => void) => () => void,
  signal: AbortSignal,
  label: 'ping' | 'trace' = 'trace',
): Promise<PathTraceResult> {
  signal.throwIfAborted()
  const tag = crypto.getRandomValues(new Uint32Array(1))[0]
  const path = hashes.join('')
  const prefix = Uint8Array.from({ length: path.length / 2 }, (_, index) => Number.parseInt(path.slice(index * 2, index * 2 + 2), 16))
  const flags = width === 1 ? 0 : width === 2 ? 1 : 2
  const wire = new Uint8Array(10 + prefix.length)
  wire[0] = traceCommand
  new DataView(wire.buffer).setUint32(1, tag, true)
  wire[9] = flags
  wire.set(prefix, 10)

  let settle!: (result: PathTraceResult | null) => void
  const response = new Promise<PathTraceResult | null>((resolve) => { settle = resolve })
  const abort = () => settle(null)
  const started = performance.now()
  const stopListening = subscribe(({ code, payload }) => {
    const snrOffset = 11 + prefix.length
    if (code !== traceResponse || payload.length !== snrOffset + hashes.length + 1 ||
      payload[1] !== prefix.length || payload[2] !== flags) return
    const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    if (header.getUint32(3, true) !== tag || header.getUint32(7, true) !== 0 ||
      !prefix.every((byte, index) => payload[11 + index] === byte)) return
    settle({
      elapsedMs: Math.round(performance.now() - started),
      hops: hashes.map((hash, index) => ({ hash, snrDb: signalDb(payload[snrOffset + index]) })),
      returnSnrDb: signalDb(payload[snrOffset + hashes.length]),
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
    if (accepted[0] === Response.disabled) throw new Error(`This firmware does not support the ${label} command.`)
    expectResponse(accepted, Response.sent)
    if (accepted.length !== 10) throw new Error(`The radio did not confirm the ${label} tag.`)
    const receipt = new DataView(accepted.buffer, accepted.byteOffset, accepted.byteLength)
    if (receipt.getUint32(2, true) !== tag) throw new Error(`The radio confirmed a different ${label} tag.`)
    signal.throwIfAborted()
    const maxWait = label === 'trace' ? 120_000 : 30_000
    timeout = setTimeout(abort, Math.min(maxWait, Math.max(1_000, receipt.getUint32(6, true))))
    const result = await response
    signal.throwIfAborted()
    if (!result) throw new Error(`No ${label} reply was received before the deadline.`)
    return result
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    stopListening()
  }
}

export async function sendContactPing(
  link: SerialLink,
  publicKey: string,
  width: PingHashWidth,
  subscribe: (listener: (push: CompanionPush) => void) => () => void,
  signal: AbortSignal,
): Promise<ContactPingResult> {
  const result = await sendPathTrace(link, [publicKey.slice(0, width * 2)], width, subscribe, signal, 'ping')
  return { elapsedMs: result.elapsedMs, outboundSnrDb: result.hops[0].snrDb, returnSnrDb: result.returnSnrDb }
}
