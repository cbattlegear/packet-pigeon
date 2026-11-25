import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { redactedDiagnostics } from '../src/diagnostics/rx-log.ts'
import { decodeRxPacket, payloadFields, routeLabel, rxPacketHash, typeLabel } from '../src/radio/rx-packet.ts'

test('decodes signed signal values, transport codes and two-byte path hashes', async () => {
  const payload = [0x56, 0x78, 0, 0, 0xaa]
  const packet = decodeRxPacket(Uint8Array.of(0xf6, 0xab, 0x0b, 0x34, 0x12, 0xcd, 0xab, 0x42,
    0x10, 0x20, 0x30, 0x40, ...payload))
  assert.equal(packet.status, 'decoded')
  assert.equal(packet.snrDb, -2.5)
  assert.equal(packet.rssiDbm, -85)
  assert.equal(routeLabel(packet.header), 'Direct with transport codes')
  assert.equal(typeLabel(packet.header), 'Direct text')
  assert.deepEqual(packet.transportCodes, [0x1234, 0xabcd])
  assert.deepEqual(packet.path, { encoded: 0x42, count: 2, hashWidth: 2, hashes: ['1020', '3040'] })
  assert.deepEqual(payloadFields(packet), [['Destination hash', '56'], ['Source hash', '78']])
  assert.equal(await rxPacketHash(packet), createHash('sha256').update(Uint8Array.of(2, ...payload)).digest('hex').slice(0, 16))
})

test('decodes trace path bytes as SNR samples and includes trace path length in the hash', async () => {
  const payload = [0, 0, 0, 0, 0, 0, 0, 0, 2]
  const packet = decodeRxPacket(Uint8Array.of(4, 200, 0x26, 2, 8, 0xf4, ...payload))
  assert.equal(packet.status, 'decoded')
  assert.deepEqual(packet.path, { encoded: 2, count: 2, hashWidth: 4, traceSnrDb: [2, -3] })
  assert.equal(await rxPacketHash(packet), createHash('sha256')
    .update(Uint8Array.of(9, 2, 0, ...payload)).digest('hex').slice(0, 16))
})

test('keeps incomplete frames, reserved paths and unknown packets isolated', async () => {
  const truncated = decodeRxPacket(Uint8Array.of(0xfe))
  assert.equal(truncated.status, 'malformed')
  assert.equal(truncated.header, null)
  assert.equal(truncated.rssiDbm, null)
  const badPath = decodeRxPacket(Uint8Array.of(0, 0, 0x09, 0xc0, 0xcc))
  assert.match(badPath.note, /invalid path/)
  const badPayload = decodeRxPacket(Uint8Array.of(0, 0, 0x09, 0, 0xcc))
  assert.match(badPayload.note, /payload is too short/)
  for (const header of [0x31, 0x7d]) {
    const unknown = decodeRxPacket(Uint8Array.of(0, 0, header, 0, 0xcc))
    assert.equal(unknown.status, 'unsupported')
    assert.equal(await rxPacketHash(unknown), null)
  }
})

test('redacted reports exclude payloads, route identifiers, packet hashes and raw bytes', () => {
  const packet = decodeRxPacket(Uint8Array.of(40, 170, 0x14, 0xde, 0xad, 0xbe, 0xef,
    0x41, 0x12, 0x34, ...new TextEncoder().encode('private packet contents')))
  const report = redactedDiagnostics([{ id: 1, time: 1_000, transport: 'bluetooth', packet }])
  assert.deepEqual(JSON.parse(report).packets, [{
    direction: 'RX', receivedAt: '1970-01-01T00:00:01.000Z', transport: 'bluetooth',
    possiblyTruncated: true, type: 'Channel text', route: 'Flood with transport codes',
    payloadVersion: 1, wireBytes: packet.wire.length, payloadBytes: 23,
    pathHashWidth: 2, hops: 1, snrDb: 10, rssiDbm: -86, status: 'decoded',
  }])
  assert.doesNotMatch(report, /contents|transportCodes|wireHex|adbe|1234|hashes|fingerprint/)
})
