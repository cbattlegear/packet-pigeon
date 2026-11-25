export const rxPacketPush = 0x88

const routes = ['Flood with transport codes', 'Flood', 'Direct', 'Direct with transport codes'] as const
const packetTypes: Partial<Record<number, string>> = {
  0: 'Request', 1: 'Response', 2: 'Direct text', 3: 'Acknowledgement', 4: 'Advertisement',
  5: 'Channel text', 6: 'Channel data', 7: 'Anonymous request', 8: 'Returned path',
  9: 'Trace', 10: 'Multipart', 11: 'Control', 15: 'Custom',
}
const minimumPayloadBytes: Partial<Record<number, number>> = {
  0: 4, 1: 4, 2: 4, 3: 4, 4: 100, 5: 3, 6: 3, 7: 35, 8: 4, 9: 9,
}

type PacketHeader = {
  routeCode: number
  typeCode: number
  version: number
}

type PacketPath = {
  encoded: number
  count: number
  hashWidth: number | null
  hashes?: string[]
  traceSnrDb?: number[]
}

export type RxPacket = {
  wire: Uint8Array
  snrDb: number | null
  rssiDbm: number | null
  header: PacketHeader | null
  transportCodes?: [number, number]
  path?: PacketPath
  payload?: Uint8Array<ArrayBuffer>
  status: 'decoded' | 'unsupported' | 'malformed'
  note?: string
}

export function packetHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function signedByte(value: number) {
  return value < 128 ? value : value - 256
}

export function routeLabel(header: PacketHeader) {
  return routes[header.routeCode]
}

export function typeLabel(header: PacketHeader) {
  return packetTypes[header.typeCode] ?? `Unknown type ${header.typeCode}`
}

export function decodeRxPacket(pushPayload: Uint8Array): RxPacket {
  const wire = Uint8Array.from(pushPayload.subarray(2))
  const base = {
    wire,
    snrDb: pushPayload.length > 0 ? signedByte(pushPayload[0]) / 4 : null,
    rssiDbm: pushPayload.length > 1 ? signedByte(pushPayload[1]) : null,
    header: wire.length > 0 ? { routeCode: wire[0] & 3, typeCode: (wire[0] >> 2) & 15, version: (wire[0] >> 6) + 1 } : null,
  }
  const header = base.header
  if (!header) return { ...base, status: 'malformed', note: 'The notification has no packet header.' }
  const hasTransport = header.routeCode === 0 || header.routeCode === 3
  const pathOffset = hasTransport ? 5 : 1
  if (wire.length <= pathOffset) {
    return { ...base, status: 'malformed', note: 'The transport or path header is incomplete.' }
  }
  const view = new DataView(wire.buffer)
  const codes: [number, number] | undefined = hasTransport
    ? [view.getUint16(1, true), view.getUint16(3, true)] : undefined
  const encoded = wire[pathOffset]
  const width = (encoded >> 6) + 1
  const count = encoded & 63
  if (width === 4 || width * count > 64) {
    return { ...base, transportCodes: codes, status: 'malformed', note: 'The packet has an invalid path encoding.' }
  }
  const payloadOffset = pathOffset + 1 + width * count
  if (wire.length <= payloadOffset || wire.length - payloadOffset > 184) {
    return { ...base, transportCodes: codes, status: 'malformed', note: 'The declared path or payload length is invalid.' }
  }
  const payload = wire.subarray(payloadOffset)
  const trace = header.version === 1 && header.routeCode >= 2 && header.typeCode === 9
  const path: PacketPath = trace
    ? {
      encoded, count, hashWidth: payload.length >= 9 ? 1 << (payload[8] & 3) : null,
      traceSnrDb: Array.from(wire.subarray(pathOffset + 1, payloadOffset), (byte) => signedByte(byte) / 4),
    }
    : {
      encoded, count, hashWidth: width,
      hashes: Array.from({ length: count }, (_, index) => {
        const start = pathOffset + 1 + index * width
        return packetHex(wire.subarray(start, start + width))
      }),
    }
  const packet = { ...base, transportCodes: codes, path, payload }
  if (header.version !== 1 || packetTypes[header.typeCode] === undefined) {
    return { ...packet, status: 'unsupported', note: 'The payload type or version is unknown.' }
  }
  if (payload.length < (minimumPayloadBytes[header.typeCode] ?? 1)) {
    return { ...packet, status: 'malformed', note: 'The payload is too short for this packet type.' }
  }
  return { ...packet, status: 'decoded' }
}

export async function rxPacketHash(packet: RxPacket) {
  if (packet.status !== 'decoded' || !packet.header || !packet.payload || !packet.path) return null
  const type = packet.header.typeCode
  const prefix = type === 9 ? [type, packet.path.encoded, 0] : [type]
  const input = new Uint8Array(prefix.length + packet.payload.length)
  input.set(prefix)
  input.set(packet.payload, prefix.length)
  const hash = await crypto.subtle.digest('SHA-256', input)
  return packetHex(new Uint8Array(hash, 0, 8))
}

export function payloadFields(packet: RxPacket): [string, string][] {
  if (packet.status !== 'decoded' || !packet.header || !packet.payload) return []
  const { typeCode } = packet.header
  const payload = packet.payload
  if ([0, 1, 2, 8].includes(typeCode) && payload.length >= 4) {
    return [
      ['Destination hash', packetHex(payload.subarray(0, 1))],
      ['Source hash', packetHex(payload.subarray(1, 2))],
    ]
  }
  if ([5, 6].includes(typeCode) && payload.length >= 3) {
    return [['Channel hash', packetHex(payload.subarray(0, 1))]]
  }
  if (typeCode === 4 && payload.length >= 100) {
    const time = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(32, true)
    return [
      ['Advertised public key', packetHex(payload.subarray(0, 32))],
      ['Advertised time', new Date(time * 1_000).toISOString()],
    ]
  }
  if (typeCode === 11) {
    return [['Control subtype', String(payload[0] >> 4)]]
  }
  return []
}
