import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRepeaterNeighborPage, repeaterNeighborRequest, repeaterRequest } from './repeater-management.ts'

const key = 'bc'.repeat(32)
const prefix = new Uint8Array(6).fill(0xbc)

function fixture(code, body, route = 0) {
  let listener
  let captured
  const subscribe = (callback) => { listener = callback; return () => { listener = undefined } }
  const link = {
    async request(command, receive) {
      captured = command.slice()
      const reply = Uint8Array.of(6, route, 0, 0, 0, 0, 0, 0, 0, 0)
      const result = receive(reply)
      listener({ code: 0x85, payload: Uint8Array.of(1, ...new Uint8Array(6)) })
      listener({ code, payload: Uint8Array.of(...body) })
      return result.value
    },
  }
  return { link, subscribe, get captured() { return captured } }
}

test('login recognizes guest, legacy and rejection without persisting credentials', async () => {
  for (const [body, expected] of [
    [[0, ...prefix], 'guest-or-legacy'],
    [[0, ...prefix, 0, 0, 0, 0, 0, 1], 'guest'],
  ]) {
    const f = fixture(0x85, body, 1)
    const result = await repeaterRequest(f.link, key, 'login', 'password', f.subscribe, new AbortController().signal)
    assert.deepEqual(result, { role: expected, route: 'flood' })
    assert.equal(f.captured[0], 26)
  }
  const rejected = fixture(0x86, [0, ...prefix])
  await assert.rejects(repeaterRequest(rejected.link, key, 'login', '', rejected.subscribe, new AbortController().signal), /rejected/)
  const invalid = fixture(0x85, [1, ...prefix])
  await assert.rejects(repeaterRequest(invalid.link, key, 'login', 'x'.repeat(16), invalid.subscribe, new AbortController().signal), /15 UTF-8 bytes/)
  assert.equal(invalid.captured, undefined)
})

test('status rejects truncated replies and cancellation stops listening', async () => {
  const f = fixture(0x87, [0, ...prefix, 1])
  await assert.rejects(repeaterRequest(f.link, key, 'status', '', f.subscribe, new AbortController().signal), /truncated/)
  const controller = new AbortController()
  let unsubscribe = false
  const link = { async request(_command, receive) {
    const result = receive(Uint8Array.of(6, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    controller.abort(new Error('cancelled'))
    return result.value
  } }
  await assert.rejects(repeaterRequest(link, key, 'status', '', () => () => { unsubscribe = true }, controller.signal), /cancelled/)
  assert.equal(unsubscribe, true)
})

test('status decodes detailed counters and only complete optional fields', async () => {
  const stats = new Uint8Array(56)
  const view = new DataView(stats.buffer)
  view.setUint32(24, 0x12345678, true)
  view.setUint32(28, 2, true)
  view.setUint32(32, 3, true)
  view.setUint32(36, 0xffffffff, true)
  view.setUint16(40, 0x8123, true)
  view.setInt16(42, -7, true)
  view.setUint16(44, 456, true)
  view.setUint16(46, 789, true)
  view.setUint32(48, 1234, true)
  view.setUint32(52, 5678, true)
  for (const [length, rxAir, receiveErrors] of [
    [48, null, null], [51, null, null], [52, 1234, null],
    [55, 1234, null], [56, 1234, 5678],
  ]) {
    const f = fixture(0x87, [0, ...prefix, ...stats.slice(0, length)])
    const result = await repeaterRequest(f.link, key, 'status', '', f.subscribe, new AbortController().signal)
    assert.deepEqual({
      floodSent: result.floodSent, directSent: result.directSent,
      floodReceived: result.floodReceived, directReceived: result.directReceived,
      errorEvents: result.errorEvents, snr: result.snr,
      directDuplicates: result.directDuplicates, floodDuplicates: result.floodDuplicates,
      rxAir: result.rxAir, receiveErrors: result.receiveErrors,
    }, {
      floodSent: 0x12345678, directSent: 2, floodReceived: 3, directReceived: 0xffffffff,
      errorEvents: 0x8123, snr: -1.75, directDuplicates: 456, floodDuplicates: 789,
      rxAir, receiveErrors,
    })
  }
})

test('full-key neighbor request and page parsing enforce bounds and preserve signed SNR', () => {
  for (const [order, code] of [['newest', 0], ['oldest', 1], ['strongest', 2], ['weakest', 3]]) {
    const request = repeaterNeighborRequest(258, order)
    assert.deepEqual([...request.slice(0, 7)], [6, 0, 3, 2, 1, code, 32])
    assert.equal(request.length, 11)
  }
  for (const offset of [-1, 65536, 1.5, NaN]) assert.throws(() => repeaterNeighborRequest(offset, 'newest'), /offset/)
  for (const order of ['', 'invalid', 4, undefined]) assert.throws(() => repeaterNeighborRequest(0, order), /order/)
  const row = Uint8Array.of(...new Uint8Array(32).fill(0xdd), 0x78, 0x56, 0x34, 0x12, 0xec)
  const reply = Uint8Array.of(7, 0, 1, 0, ...row)
  assert.deepEqual(parseRepeaterNeighborPage(reply, 3), {
    total: 7, entries: [{ publicKey: 'dd'.repeat(32), secondsAgo: 0x12345678, snrDb: -5 }],
  })
  assert.deepEqual(parseRepeaterNeighborPage(Uint8Array.of(0, 0, 0, 0), 3), { total: 0, entries: [] })
  for (const [payload, offset] of [
    [Uint8Array.of(0, 0, 0), 0], [reply.slice(0, -1), 0],
    [Uint8Array.of(...reply, 0), 0], [Uint8Array.of(4, 0, 4, 0), 0],
    [reply, 7], [reply, -1],
  ]) assert.throws(() => parseRepeaterNeighborPage(payload, offset), /invalid neighbor page/)
})
