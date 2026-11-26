import { CompanionError } from './protocol.ts'
import { maxCompanionFrameSize } from './transport.ts'

export interface CompanionSerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  getInfo?(): { usbVendorId?: number; usbProductId?: number }
}

export interface WebSerialEnvironment {
  readonly secureContext: boolean
  readonly serial?: {
    requestPort(): Promise<CompanionSerialPort>
    getPorts?(): Promise<CompanionSerialPort[]>
  }
}

export function browserSerialEnvironment(): WebSerialEnvironment {
  const navigator = globalThis.navigator as (Navigator & { serial?: WebSerialEnvironment['serial'] }) | undefined
  return { secureContext: globalThis.isSecureContext === true, serial: navigator?.serial }
}

export type WebSerialSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly error: CompanionError }

export function getWebSerialSupport(environment = browserSerialEnvironment()): WebSerialSupport {
  if (!environment.secureContext) {
    return { supported: false, error: new CompanionError('insecure-context', 'USB serial requires HTTPS or localhost.') }
  }
  if (!environment.serial) {
    return { supported: false, error: new CompanionError('unsupported-browser', 'This browser does not support Web Serial.') }
  }
  return { supported: true }
}

export async function choosePort(environment: WebSerialEnvironment) {
  const support = getWebSerialSupport(environment)
  if (!support.supported) throw support.error
  const { serial } = environment
  if (!serial) throw new CompanionError('unsupported-browser', 'This browser does not support Web Serial.')
  try {
    return await serial.requestPort()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null
    throw new CompanionError('chooser-failed', 'Could not select a USB serial port. Check browser permissions.', { cause: error })
  }
}

// MeshCore ArduinoSerialInterface: marker, uint16 little-endian length, payload.

export function encodeCommand(payload: Uint8Array) {
  if (payload.length < 1 || payload.length > maxCompanionFrameSize) {
    throw new CompanionError('protocol', 'Invalid companion command length.')
  }
  const packet = new Uint8Array(3 + payload.length)
  packet.set([0x3c, payload.length, 0])
  packet.set(payload, 3)
  return packet
}

export class SerialFrameDecoder {
  private remainder = new Uint8Array()

  read(chunk: Uint8Array) {
    const bytes = new Uint8Array(this.remainder.length + chunk.length)
    bytes.set(this.remainder)
    bytes.set(chunk, this.remainder.length)
    const frames: Uint8Array[] = []
    let offset = 0
    while (offset < bytes.length) {
      const start = bytes.indexOf(0x3e, offset)
      if (start < 0) {
        offset = bytes.length
        break
      }
      offset = start
      if (bytes.length - start < 3) break
      const length = bytes[start + 1] + bytes[start + 2] * 256
      if (length === 0 || length > maxCompanionFrameSize) {
        offset++
        continue
      }
      const end = start + 3 + length
      if (end > bytes.length) break
      offset = end
      frames.push(bytes.slice(start + 3, end))
    }
    this.remainder = bytes.slice(offset)
    return frames
  }
}
