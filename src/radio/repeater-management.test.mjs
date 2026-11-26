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

test('full-key neighbor request and page parsing enforce bounds and preserve signed SNR', () => {
  const request = repeaterNeighborRequest(258)
  assert.deepEqual([...request.slice(0, 7)], [6, 0, 3, 2, 1, 0, 32])
  assert.equal(request.length, 11)
  for (const offset of [-1, 65536, 1.5, NaN]) assert.throws(() => repeaterNeighborRequest(offset), /offset/)
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
