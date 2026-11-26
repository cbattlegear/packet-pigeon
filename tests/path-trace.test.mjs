import assert from 'node:assert/strict'
import test from 'node:test'
import { mapPath, mapSegments, pathSegments, resolvePath } from '../src/paths/model.ts'
import { parseTracePath } from '../src/radio/contact-ping.ts'

test('trace hash encoding reserves the unreachable 64th hop and accepts four-byte hashes', () => {
  assert.deepEqual(parseTracePath('abcdef01 abcd0002', 4), ['abcdef01', 'abcd0002'])
  assert.equal(parseTracePath('ab'.repeat(63), 1).length, 63)
  assert.throws(() => parseTracePath('ab'.repeat(64), 1), /at most 63/)
  assert.throws(() => parseTracePath('ab'.repeat(65), 2), /complete 2-byte/)
  assert.throws(() => parseTracePath('aabbcc', 3), /1-, 2- or 4-byte/)
})

test('resolves unique positions without choosing between collisions or drawing across missing nodes', () => {
  const west = { lat: 1, lon: 170 }
  const east = { lat: 2, lon: -160 }
  const north = { lat: 4, lon: -159 }
  const nodes = [
    { publicKey: 'abcd'.padEnd(64, '0'), name: 'West', position: null },
    { publicKey: 'abcd'.padEnd(64, '0'), name: 'West', position: west },
    { publicKey: 'abef'.padEnd(64, '0'), name: 'East', position: east },
    { publicKey: 'beef'.padEnd(64, '0'), name: 'North', position: north },
  ]
  const route = resolvePath(['ab', 'abcd', 'aabb', 'abef', 'beef', 'abcd'], nodes)
  assert.deepEqual(route.map(({ matches }) => matches.length), [2, 1, 0, 1, 1, 1])
  const path = mapPath('Test path', route)
  assert.deepEqual(path.points.map(({ position }) => position), [null, west, null, east, north, west])
  assert.deepEqual(pathSegments(path.points), [[east, north]])
  assert.deepEqual(mapSegments(path), [[east, north]])
  assert.deepEqual(mapSegments({ title: 'Neighbors', connect: false, points: path.points }), [])
})
