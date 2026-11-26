import assert from 'node:assert/strict'
import test from 'node:test'
import { loginRemoteNode, parseRemoteLogin, parseRemoteNodeClients, parseRoomStatus, RemoteLoginUnconfirmed,
  remoteNodeAdminText, requestRemoteNodeData } from './remote-nodes.ts'
import { canPostToRoom } from './node-access.ts'
import { decodeSensorSummary } from './cayenne-lpp.ts'

const publicKey = 'ab'.repeat(32)
const bytes = new Uint8Array(32).fill(0xab)
const keyPrefix = bytes.subarray(0, 6)

test('uses announced ACL roles for posting and never promotes legacy or incomplete room replies', () => {
  const legacy = Uint8Array.of(1, ...keyPrefix)
  assert.equal(canPostToRoom(parseRemoteLogin({ code: 0x85, payload: legacy }, publicKey, 'flood')), false)
  for (const permissions of [0, 1, 2, 3]) {
    const payload = Uint8Array.of(0, ...keyPrefix, 1, 0, 0, 0, permissions, 1)
    const access = parseRemoteLogin({ code: 0x85, payload }, publicKey, 'direct')
    assert.equal(canPostToRoom(access), permissions >= 2)
    assert.equal(access.firmware, 1)
    assert.equal(parseRemoteLogin({ code: 0x85, payload }, 'cd'.repeat(32), 'direct'), undefined)
  }
  assert.throws(() => parseRemoteLogin({ code: 0x86, payload: Uint8Array.of(0, ...keyPrefix) }, publicKey, 'direct'), /rejected/)
  assert.throws(() => parseRemoteLogin({ code: 0x86, payload: legacy }, publicKey, 'direct'), /invalid login rejection/)
})

test('matches a binary reply by request tag and ignores unsolicited telemetry', async () => {
  let push
  let unsubscribed = false
  const signal = new AbortController().signal
  const link = { async request(command, receive) {
    assert.deepEqual(command, Uint8Array.of(50, ...bytes, 5, 0, 0))
    const accepted = receive(Uint8Array.of(6, 1, 11, 22, 33, 44, 0xd0, 7, 0, 0)).value
    push({ code: 0x8c, payload: Uint8Array.of(0, 11, 22, 33, 45, ...keyPrefix, 2) })
    push({ code: 0x8c, payload: Uint8Array.of(0, 11, 22, 33, 44, ...keyPrefix, 0xc3) })
    return accepted
  } }
  const acl = await requestRemoteNodeData(link, publicKey, Uint8Array.of(5, 0, 0), (receive) => {
    push = receive
    return () => { unsubscribed = true }
  }, signal)
  assert.equal(unsubscribed, true)
  assert.deepEqual(parseRemoteNodeClients(acl), [{ prefix: publicKey.slice(0, 12), permissions: 0xc3, role: 'admin' }])
  assert.throws(() => parseRemoteNodeClients(acl.slice(1)), /incomplete/)
})

test('clears encoded credentials after login and validates room and sensor configuration', async () => {
  let sent
  let push
  const signal = new AbortController().signal
  const link = { async request(command, receive) {
    sent = command
    assert.deepEqual(command, Uint8Array.of(26, ...bytes, 0x70, 0xc3, 0xa5))
    const accepted = receive(Uint8Array.of(6, 0, 11, 22, 33, 44, 0xd0, 7, 0, 0)).value
    push({ code: 0x85, payload: Uint8Array.of(0, ...keyPrefix, 1, 0, 0, 0, 2, 1) })
    return accepted
  } }
  assert.equal((await loginRemoteNode(link, publicKey, 'på', (receive) => { push = receive; return () => {} }, signal)).role, 'read-write')
  assert.ok(sent.every((byte) => byte === 0))
  await assert.rejects(loginRemoteNode(link, publicKey, 'å'.repeat(8), () => () => {}, signal), /15 UTF-8/)
  assert.equal(remoteNodeAdminText({ kind: 'client-permissions', publicKey, permissions: 129 }, 4), `setperm ${publicKey} 129`)
  assert.equal(remoteNodeAdminText({ kind: 'allow-read-only', enabled: false }, 3), 'set allow.read.only off')
  assert.throws(() => remoteNodeAdminText({ kind: 'allow-read-only', enabled: true }, 4), /room server/)
  const status = new Uint8Array(52)
  const view = new DataView(status.buffer)
  view.setUint16(0, 3800, true)
  view.setInt16(4, -105, true)
  view.setUint32(20, 60, true)
  assert.deepEqual(parseRoomStatus(status), { batteryVolts: 3.8, queueSize: 0, noiseFloorDbm: -105, packetsReceived: 0, uptimeSeconds: 60 })
})

test('decodes scalar sensor history without treating truncated values as a reading', () => {
  const data = Uint8Array.of(1, 0, 0, 0, 2, 103, 0xff, 0xc9, 0, 55, 0, 0, 3, 104, 0x01, 0x90, 0x02, 0x58, 0x01, 0xf4)
  assert.deepEqual(decodeSensorSummary(data), { timestamp: 1, readings: [
    { channel: 2, type: 103, label: 'Temperature', unit: '°C', minimum: -5.5, maximum: 5.5, average: 0 },
    { channel: 3, type: 104, label: 'Relative humidity', unit: '%', minimum: 40, maximum: 60, average: 50 },
  ] })
  assert.throws(() => decodeSensorSummary(data.subarray(0, -1)), /incomplete history reading/)
})

test('distinguishes a cancelled sent login from a definite rejection', async () => {
  let push
  const controller = new AbortController()
  const subscribe = (receive) => {
    push = receive
    return () => {}
  }
  const sent = Uint8Array.of(6, 0, 11, 22, 33, 44, 0xd0, 7, 0, 0)
  const cancelled = { async request(_command, receive) {
    const response = receive(sent).value
    controller.abort()
    return response
  } }
  await assert.rejects(loginRemoteNode(cancelled, publicKey, '', subscribe, controller.signal), RemoteLoginUnconfirmed)

  const rejected = { async request(_command, receive) {
    const response = receive(sent).value
    push({ code: 0x86, payload: Uint8Array.of(0, ...keyPrefix) })
    return response
  } }
  await assert.rejects(loginRemoteNode(rejected, publicKey, '', subscribe, new AbortController().signal),
    (error) => /rejected/.test(error.message) && !(error instanceof RemoteLoginUnconfirmed))
})

test('treats ambiguous confirmations as unconfirmed and allows retry after a definite local rejection', async () => {
  const signal = new AbortController().signal
  const subscribe = () => () => {}
  for (const ack of [[0], [1], [6, 0]]) {
    const link = { async request(_command, receive) { return receive(Uint8Array.from(ack)).value } }
    await assert.rejects(loginRemoteNode(link, publicKey, '', subscribe, signal), RemoteLoginUnconfirmed)
  }
  for (const ack of [[1, 2], [15]]) {
    const link = { async request(_command, receive) { return receive(Uint8Array.from(ack)).value } }
    await assert.rejects(loginRemoteNode(link, publicKey, '', subscribe, signal),
      (error) => /companion rejected/.test(error.message) && !(error instanceof RemoteLoginUnconfirmed))
  }
  await assert.rejects(loginRemoteNode({ request() { assert.fail('Unexpected radio command') } },
    publicKey, '', subscribe, AbortSignal.abort()), { name: 'AbortError' })
})
