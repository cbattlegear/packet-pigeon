import { routeLabel, typeLabel } from '../radio/rx-packet.ts'
import type { RxPacket } from '../radio/rx-packet.ts'
import { framedTransport } from '../radio/transport.ts'
import type { CompanionTransport } from '../radio/transport.ts'

export const maxRxPackets = 500

export type CapturedPacket = {
  id: number
  time: number
  transport: CompanionTransport
  packet: RxPacket
}

export function matchingChannelObservations(selected: CapturedPacket, entries: readonly CapturedPacket[]) {
  const valid = ({ packet, transport }: CapturedPacket) => framedTransport(transport)
    && packet.status === 'decoded' && packet.header?.version === 1 && packet.header.typeCode === 5
    && packet.payload !== undefined && packet.payload.length >= 19 && (packet.payload.length - 3) % 16 === 0
    && packet.path?.hashes !== undefined
  if (!valid(selected)) return []
  const payload = selected.packet.payload!
  return entries.filter((entry) => valid(entry) && entry.packet.payload!.length === payload.length
    && entry.packet.payload!.every((byte, index) => byte === payload[index]))
}

export function redactedDiagnostics(entries: readonly CapturedPacket[]) {
  return JSON.stringify({
    version: 1,
    packets: entries.map(({ time, transport, packet }) => ({
      direction: 'RX',
      receivedAt: new Date(time).toISOString(),
      transport,
      possiblyTruncated: transport === 'bluetooth',
      type: packet.header ? typeLabel(packet.header) : null,
      route: packet.header ? routeLabel(packet.header) : null,
      payloadVersion: packet.header?.version ?? null,
      wireBytes: packet.wire.length,
      payloadBytes: packet.payload?.length ?? null,
      pathHashWidth: packet.path?.hashWidth ?? null,
      hops: packet.path?.count ?? null,
      snrDb: packet.snrDb,
      rssiDbm: packet.rssiDbm,
      status: packet.status,
    })),
  }, null, 2)
}
