import assert from 'node:assert/strict'
import test from 'node:test'
import { repeaterRequest } from './repeater-management.ts'

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
