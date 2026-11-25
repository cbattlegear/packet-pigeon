import { routeLabel, typeLabel } from '../radio/rx-packet.ts'
import type { RxPacket } from '../radio/rx-packet.ts'

export const maxRxPackets = 500

export type CapturedPacket = {
  id: number
  time: number
  transport: 'usb' | 'bluetooth'
  packet: RxPacket
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
