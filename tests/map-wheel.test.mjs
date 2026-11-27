import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeWheelZoom, mapMaxZoom, mapMinZoom, normalizedWheelDelta, pointerAnchoredCenter,
} from '../src/map/wheel-zoom.ts'

test('wheel direction zooms in and out, including accumulated trackpad deltas', () => {
  assert.deepEqual(consumeWheelZoom(5, -100), { zoom: 6, remainingDelta: 0 })
  assert.deepEqual(consumeWheelZoom(5, 100), { zoom: 4, remainingDelta: 0 })
  assert.deepEqual(consumeWheelZoom(5, -35), { zoom: 5, remainingDelta: -35 })
  assert.deepEqual(consumeWheelZoom(5, -135), { zoom: 6, remainingDelta: -35 })
  assert.equal(normalizedWheelDelta(3, 1, 400), 48)
  assert.equal(normalizedWheelDelta(1, 2, 400), 400)
})

test('wheel zoom remains within the supported map bounds', () => {
  assert.equal(consumeWheelZoom(mapMinZoom, 600).zoom, mapMinZoom)
  assert.equal(consumeWheelZoom(mapMaxZoom, -600).zoom, mapMaxZoom)
  assert.equal(consumeWheelZoom(mapMinZoom + 1, 1200).zoom, mapMinZoom)
  assert.equal(consumeWheelZoom(mapMaxZoom - 1, -1200).zoom, mapMaxZoom)
})

test('pointer anchoring keeps the world point under the pointer between zoom levels', () => {
  const center = { x: 1_000, y: 800 }
  const pointer = { x: 260, y: 190 }
  const viewport = { x: 400, y: 300 }
  const zoomed = pointerAnchoredCenter(center, pointer, viewport, 4, 5)
  const worldAtPointer = {
    x: center.x + pointer.x - viewport.x / 2,
    y: center.y + pointer.y - viewport.y / 2,
  }
  assert.deepEqual({
    x: zoomed.x + pointer.x - viewport.x / 2,
    y: zoomed.y + pointer.y - viewport.y / 2,
  }, {
    x: worldAtPointer.x * 2,
    y: worldAtPointer.y * 2,
  })
  assert.deepEqual(pointerAnchoredCenter(zoomed, pointer, viewport, 5, 4), center)
})
