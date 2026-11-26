import type { CompanionPush } from './companion-session.ts'
import { Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

const telemetryCommand = 39
const telemetryResponse = 0x8b
export const telemetryProtocolVersion = 5
export const maxTelemetryPayloadLength = 168

function keyBytes(publicKey: string) {
  return Uint8Array.from({ length: publicKey.length / 2 }, (_, index) =>
    Number.parseInt(publicKey.slice(index * 2, index * 2 + 2), 16))
}

function matchesPrefix(payload: Uint8Array, prefix: Uint8Array) {
  return payload.length >= 7 && payload[0] === 0 && prefix.every((byte, index) => payload[index + 1] === byte)
}

function checkResponse(frame: Uint8Array, expected: number) {
  if (frame[0] === Response.disabled || (frame[0] === Response.error && frame[1] === 1)) {
    throw new Error('This companion firmware does not support telemetry.')
  }
  if (frame[0] === Response.error && frame[1] === 2) throw new Error('The radio no longer has this contact.')
  expectResponse(frame, expected)
}

export async function requestOwnTelemetry(link: SerialLink, publicKey: string, signal: AbortSignal) {
  const prefix = keyBytes(publicKey.slice(0, 12))
  signal.throwIfAborted()
  const frame = await link.request(Uint8Array.of(telemetryCommand, 0, 0, 0),
    (frame) => ({ value: frame }),
    (frame) => frame[0] === telemetryResponse && matchesPrefix(frame.subarray(1), prefix))
  signal.throwIfAborted()
  checkResponse(frame, telemetryResponse)
  return frame.slice(8)
}

export async function requestRemoteTelemetry(
  link: SerialLink,
  publicKey: string,
  subscribe: (listener: (push: CompanionPush) => void) => () => void,
  signal: AbortSignal,
) {
  const key = keyBytes(publicKey)
  const prefix = key.subarray(0, 6)
  const command = new Uint8Array(4 + key.length)
  command[0] = telemetryCommand
  command.set(key, 4)
  let accepted = false
  let settle!: (payload: Uint8Array | null) => void
  const reply = new Promise<Uint8Array | null>((resolve) => { settle = resolve })
  const stopWaiting = () => settle(null)
  const stopListening = subscribe(({ code, payload }) => {
    if (accepted && code === telemetryResponse && matchesPrefix(payload, prefix)) settle(payload.slice(7))
  })
  signal.addEventListener('abort', stopWaiting, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const frame = await link.request(command, (frame) => {
      // The USB stream can deliver the confirmation and push in the same read.
      accepted = frame[0] === Response.sent && frame.length === 10 && (frame[1] === 0 || frame[1] === 1)
      return { value: frame }
    })
    checkResponse(frame, Response.sent)
    if (!accepted) throw new Error('The radio returned an invalid telemetry confirmation.')
    signal.throwIfAborted()
    const estimated = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(6, true)
    timer = setTimeout(stopWaiting, Math.min(120_000, Math.max(1_000, estimated)))
    const payload = await reply
    signal.throwIfAborted()
    if (!payload) throw new Error('No telemetry reply arrived before the deadline. The contact may be out of range or require permission.')
    return payload
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stopWaiting)
    stopListening()
  }
}
