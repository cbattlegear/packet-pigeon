import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeTelemetry } from './cayenne-lpp.ts'

test('decodes MeshCore device, environmental, electrical and signed location readings', () => {
  const location = (...values) => values.flatMap((value) => [(value >> 16) & 255, (value >> 8) & 255, value & 255])
  const { readings, issue } = decodeTelemetry(Uint8Array.of(
    1, 116, 1, 132,
    1, 103, 0xff, 0xc7,
    1, 136, ...location(407128, -740060, -125),
    2, 104, 87,
    2, 115, 0x27, 0x94,
    2, 121, 0xff, 0xe2,
    3, 117, 4, 210,
    3, 128, 0, 25,
  ))
  assert.equal(issue, undefined)
  assert.deepEqual(readings.map(({ channel, label, values, unit }) => [channel, label, values, unit]), [
    [1, 'Battery voltage', [3.88], 'V'],
    [1, 'Temperature', [-5.7], '°C'],
    [1, 'Location', [40.7128, -74.006, -1.25], ''],
    [2, 'Relative humidity', [43.5], '%'],
    [2, 'Pressure', [1013.2], 'hPa'],
    [2, 'Altitude', [-30], 'm'],
    [3, 'Current', [1.234], 'A'],
    [3, 'Power', [25], 'W'],
  ])
})

test('keeps completed fields and stops when an unknown field has no known byte length', () => {
  const { readings, issue } = decodeTelemetry(Uint8Array.of(1, 116, 1, 132, 2, 250, 0, 3, 103, 0, 100))
  assert.equal(readings.length, 1)
  assert.deepEqual(issue, { kind: 'unsupported', type: 250, offset: 4 })
  assert.deepEqual(decodeTelemetry(Uint8Array.of(1, 136, 2)).issue, { kind: 'truncated', type: 136, offset: 0 })
  assert.deepEqual(decodeTelemetry(Uint8Array.of(1)).issue, { kind: 'truncated', offset: 0 })
  assert.deepEqual(decodeTelemetry(new Uint8Array()), { readings: [] })
})
