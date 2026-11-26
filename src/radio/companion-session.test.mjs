import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { once } from 'node:events'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { IDBFactory } from 'fake-indexeddb'
import { CompanionSession, getWebSerialSupport } from './index.ts'
import { SerialFrameDecoder } from './web-serial.ts'
import { SerialLink } from './serial-link.ts'
import { SessionCache } from '../integration/session-cache.ts'
import { MessageSync } from '../integration/message-sync.ts'
import { DirectMessages } from '../integration/direct-messages.ts'
import { expectedDirectAck } from './direct-message.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import { assertScopeSupported, channelScopeCommand, validateChannelScope } from './channel-scope.ts'

const encode = (text) => new TextEncoder().encode(text)
const response = (...payload) => Uint8Array.of(0x3e, payload.length, 0, ...payload)

class FixturePort extends EventTarget {
  constructor(onCommand) {
    super()
    this.commands = []
    this.closed = false
    this.readable = new ReadableStream({ start: (controller) => { this.incoming = controller } })
    this.writable = new WritableStream({
      write: (packet) => {
        assert.deepEqual([...packet.slice(0, 3)], [0x3c, packet.length - 3, 0])
        const command = [...packet.slice(3)]
        this.commands.push(command)
        this.dispatchEvent(new Event('command'))
        return onCommand(command, this)
      },
    })
  }

  async open(options) {
    assert.deepEqual(options, { baudRate: 115200 })
  }

  async close() {
    assert.equal(this.readable.locked, false)
    assert.equal(this.writable.locked, false)
    this.closed = true
  }

  getInfo() {
    return { usbVendorId: 1, usbProductId: 2 }
  }

  emit(...payload) {
    this.incoming.enqueue(response(...payload))
  }
}

function fixtureLocks() {
  let owned = false
  return {
    async request(_name, _options, callback) {
      if (owned) return callback(null)
      owned = true
      try { await callback({}) } finally { owned = false }
    },
  }
}

function sessionWith(port, timeoutMs = 1000, options = {}) {
  return new CompanionSession({
    environment: { secureContext: true, serial: { requestPort: async () => port, getPorts: async () => [] } },
    timeoutMs,
    locks: fixtureLocks(),
    ...options,
  })
}

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for session state')
}

function workingPort(key = 0xab) {
  return new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: {
        const info = selfInfo()
        info.fill(key, 4, 36)
        serial.emit(...info)
        break
      }
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
}

function deviceInfo(slots = 0) {
  const frame = Uint8Array.of(13, 14, 100, slots, ...new Uint8Array(78))
  frame.set(encode('20 Nov 2026'), 8)
  frame.set(encode('Test Companion'), 20)
  frame.set(encode('1.14.0'), 60)
  frame.set([1, 2], 80)
  return frame
}

function selfInfo() {
  return Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab), ...new Uint8Array(22), ...encode('Pigeon'))
}

test('noise-floor reads are local, capability gated, and decode signed radio stats', async () => {
  let version = 14
  let reply = [24, 1, 0x85, 0xff, ...new Uint8Array(10)]
  const port = new FixturePort(([code], serial) => {
    if (code === 22) {
      const info = deviceInfo()
      info[1] = version
      serial.emit(...info)
    } else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) { serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0) }
    else if (code === 56) serial.emit(...reply)
    else assert.fail(`Unexpected command ${code}`)
  })
  const session = sessionWith(port)
  await session.connect()
  const key = session.getSnapshot().device.publicKey
  assert.equal(await session.noiseFloor(key), -123)
  assert.deepEqual(port.commands.at(-1), [56, 1])
  reply = [1, 1]
  await assert.rejects(session.noiseFloor(key), { code: 'unsupported-firmware' })
  await session.disconnect()

  version = 7
  const oldPort = new FixturePort(([code], serial) => {
    if (code === 22) { const info = deviceInfo(); info[1] = version; serial.emit(...info) }
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) { serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0) }
    else assert.fail(`Unexpected command ${code}`)
  })
  const oldSession = sessionWith(oldPort)
  await oldSession.connect()
  await assert.rejects(oldSession.noiseFloor(key), { code: 'unsupported-firmware' })
  assert.equal(oldPort.commands.some(([code]) => code === 56), false)
  await oldSession.disconnect()
})

test('noise-floor reads reject malformed statistics without accepting a partial frame', async () => {
  const port = new FixturePort(([code], serial) => {
    if (code === 22) serial.emit(...deviceInfo())
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) { serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0) }
    else if (code === 56) serial.emit(24, 1, 0x85, 0xff)
    else assert.fail(`Unexpected command ${code}`)
  })
  const session = sessionWith(port)
  await session.connect()
  await assert.rejects(session.noiseFloor(session.getSnapshot().device.publicKey), { code: 'protocol' })
  await session.disconnect()
})

test('a timed-out noise-floor command closes the link rather than misattributing a late reply', async () => {
  const port = new FixturePort(([code], serial) => {
    if (code === 22) serial.emit(...deviceInfo())
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) { serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0) }
    else if (code !== 56) assert.fail(`Unexpected command ${code}`)
  })
  const session = sessionWith(port, 40)
  await session.connect()
  await assert.rejects(session.noiseFloor(session.getSnapshot().device.publicKey), { code: 'timeout' })
  await waitFor(() => session.getSnapshot().phase === 'error')
  assert.equal(port.closed, true)
  await session.disconnect()
})

test('nearby discovery is explicit, capability-aware, and releases the radio while listening', async () => {
  let version = 14
  let rejectDiscovery = false
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: { const info = deviceInfo(); info[1] = version; serial.emit(...info); break }
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 55:
        if (rejectDiscovery) serial.emit(1, 1)
        else {
          serial.emit(0x8e, 0xf8, 0x9c, 0, 0x92, 0xec, ...command.slice(3, 7), ...new Uint8Array(32).fill(0xbc))
          serial.emit(0)
        }
        break
      case 56: serial.emit(24, 1, 0x85, 0xff, ...new Uint8Array(10)); break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  await session.connect()
  assert.deepEqual(port.commands.map(([code]) => code), [22, 1, 4])
  const controller = new AbortController()
  const found = []
  let listening = false
  const scanning = session.discoverNearby(key, controller.signal, (node) => found.push(node), () => { listening = true })
  await waitFor(() => listening && found.length === 1)
  const command = port.commands.find(([code]) => code === 55)
  assert.deepEqual(command.slice(0, 3), [55, 0x80, 0x1e])
  assert.deepEqual(command.slice(7), [0, 0, 0, 0])
  assert.equal(found[0].publicKey, 'bc'.repeat(32))
  assert.equal(await session.noiseFloor(key), -123)
  await assert.rejects(session.discoverNearby(key, new AbortController().signal, () => {}, () => {}), /already running/)
  controller.abort(new Error('Stopped by fixture'))
  await assert.rejects(scanning, /Stopped by fixture/)
  port.emit(0x8e, 0, 0, 0, 0x92, 0, ...command.slice(3, 7), ...new Uint8Array(32).fill(0xcd))
  await setImmediate()
  assert.equal(found.length, 1)
  rejectDiscovery = true
  await assert.rejects(session.discoverNearby(key, new AbortController().signal, () => {}, () => {}),
    { code: 'unsupported-firmware' })
  assert.equal(session.getSnapshot().phase, 'ready')
  await session.disconnect()

  version = 7
  const oldPort = new FixturePort(([code], serial) => {
    if (code === 22) { const info = deviceInfo(); info[1] = version; serial.emit(...info) }
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) { serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0) }
    else assert.fail(`Unexpected command ${code}`)
  })
  const oldSession = sessionWith(oldPort)
  await oldSession.connect()
  await assert.rejects(oldSession.discoverNearby(key, new AbortController().signal, () => {}, () => {}),
    { code: 'unsupported-firmware' })
  await assert.rejects(oldSession.discoverRepeaterDetails(key, 'bc'.repeat(32), 'regions',
    new AbortController().signal, () => {}), { code: 'unsupported-firmware' })
  assert.equal(oldPort.commands.some(([code]) => code === 55), false)
  assert.equal(oldPort.commands.some(([code]) => code === 57), false)
  await oldSession.disconnect()
})

test('nearby discovery waits for an in-flight acknowledgement and stops on disconnect', async () => {
  let acknowledge
  let hold = true
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 55:
        if (hold) acknowledge = () => serial.emit(0)
        else serial.emit(0)
        break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port, 1000, { retryDelays: [10_000] })
  const key = 'ab'.repeat(32)
  await session.connect()
  const controller = new AbortController()
  let settled = false
  const scanning = session.discoverNearby(key, controller.signal, () => {}, () => {})
  scanning.catch(() => { settled = true })
  await waitFor(() => typeof acknowledge === 'function')
  controller.abort(new Error('Stopped before acknowledgement'))
  await setImmediate()
  assert.equal(settled, false)
  await assert.rejects(session.noiseFloor(key), /already in progress/)
  acknowledge()
  await assert.rejects(scanning, /Stopped before acknowledgement/)

  hold = false
  let listening = false
  const disconnected = session.discoverNearby(key, new AbortController().signal, () => {}, () => { listening = true })
  await waitFor(() => listening)
  port.dispatchEvent(new Event('disconnect'))
  await assert.rejects(disconnected, /disconnected/)
  await session.disconnect()
})

test('repeater login and explicit status use verified routes and distinguish reported access', async () => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 1
  contact[36] = 0x45
  let duplicate = false
  let reply = true
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: {
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contact)
        if (duplicate) {
          const other = contact.slice()
          other[5] = 0xdd
          serial.emit(...other)
        }
        serial.emit(4, 0, 0, 0, 0)
        break
      }
      case 26:
      case 27: {
        serial.emit(6, 0, 0, 0, 0, 0, 0xe8, 3, 0, 0)
        if (!reply) break
        if (command[0] === 26) serial.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
        else {
          const stats = new Uint8Array(48)
          const view = new DataView(stats.buffer)
          view.setUint16(0, 4050, true)
          view.setInt16(4, -110, true)
          view.setInt16(6, -80, true)
          view.setUint32(8, 42, true)
          view.setInt16(42, -8, true)
          serial.emit(0x87, 0, ...contact.slice(1, 7), ...stats)
        }
        break
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  await session.connect()
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 1, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  const signal = () => new AbortController().signal
  await assert.rejects(session.manageRepeater(key, target, route, 'status', '', signal()), /Log in/)
  assert.equal(port.commands.some(([code]) => code === 27), false)
  assert.deepEqual(await session.manageRepeater(key, target, route, 'login', 'test', signal(), true), { role: 'admin', route: 'direct' })
  assert.deepEqual(port.commands.find(([code]) => code === 26), [26, ...contact.slice(1, 33), ...encode('test'), 0])
  const status = await session.manageRepeater(key, target, route, 'status', '', signal())
  assert.equal(status.batteryMv, 4050)
  assert.equal(status.noiseFloor, -110)
  assert.equal(status.rssi, -80)
  assert.equal(status.snr, -2)
  assert.equal(status.received, 42)
  let commandCount = port.commands.length
  session.clearRepeaterAccess('cd'.repeat(32), target)
  session.clearRepeaterAccess(key, 'dd'.repeat(32))
  assert.equal(port.commands.length, commandCount)
  await session.manageRepeater(key, target, route, 'status', '', signal())
  commandCount = port.commands.length
  session.clearRepeaterAccess(key, target)
  assert.equal(port.commands.length, commandCount)
  assert.equal(session.hasRememberedRepeaterPassword(key, target), true)
  await assert.rejects(session.manageRepeater(key, target, route, 'status', '', signal()), /Log in/)
  await assert.rejects(session.readRepeaterAccessList(key, target, route, signal()), /Log in/)
  await assert.rejects(session.readRepeaterNeighbors(key, target, route, 0, signal()), /Log in/)
  await assert.rejects(session.sendRepeaterCommand(key, target, route, 'ver', false, signal()), /Log in/)
  assert.equal(port.commands.filter(([code]) => [2, 26, 27, 50].includes(code)).length, 3)
  assert.deepEqual(await session.resumeRepeater(key, target, route, signal()), { role: 'admin', route: 'direct' })
  contact[36] = 0x46
  await assert.rejects(session.manageRepeater(key, target, route, 'status', '', signal()), /route changed/)
  contact[36] = 0x45
  duplicate = true
  await assert.rejects(session.manageRepeater(key, target, route, 'login', 'test', signal()), /shares a response prefix/)
  duplicate = false
  reply = false
  const controller = new AbortController()
  const pending = session.manageRepeater(key, target, route, 'login', 'test', controller.signal)
  await waitFor(() => port.commands.filter(([code]) => code === 26).length === 3)
  controller.abort(new Error('Stopped waiting'))
  await assert.rejects(pending, /Stopped waiting/)
  await assert.rejects(session.manageRepeater(key, target, route, 'status', '', signal()), /Reconnect/)
  await session.disconnect()
})

test('remembered repeater passwords are opt-in, scoped, forgettable and used only for explicit verified logins', async (t) => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 1
  contact[36] = 0x45
  let mode = 'success'
  let release
  const respond = (command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contact)
        serial.emit(4, 0, 0, 0, 0)
        break
      case 26:
        serial.emit(6, 0, 0, 0, 0, 0, 0xe8, 3, 0, 0)
        if (mode === 'reject') serial.emit(0x86, 0, ...contact.slice(1, 7))
        else if (mode === 'hold') release = () => serial.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
        else serial.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
        break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  }
  const ports = [new FixturePort(respond), new FixturePort(respond), new FixturePort(respond)]
  let port = ports[0]
  let nextPort = 0
  const session = new CompanionSession({
    environment: { secureContext: true, serial: { requestPort: async () => ports[nextPort++], getPorts: async () => [] } },
    timeoutMs: 1000, locks: fixtureLocks(),
  })
  await session.connect()
  t.after(() => session.disconnect())
  const radio = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 1, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  const signal = () => new AbortController().signal
  assert.throws(() => session.resumeRepeater(radio, target, route, signal()), /No repeater password/)
  await assert.rejects(session.manageRepeater(radio, target, route, 'login', '', signal(), true), /nonempty password/)
  assert.equal(port.commands.filter(([code]) => code === 26).length, 0)
  await session.manageRepeater(radio, target, route, 'login', 'fixture-secret', signal())
  assert.equal(session.hasRememberedRepeaterPassword(radio, target), false)
  await session.manageRepeater(radio, target, route, 'login', 'fixture-secret', signal(), true)
  assert.equal(session.hasRememberedRepeaterPassword(radio, target), true)
  assert.equal(session.hasRememberedRepeaterPassword('cd'.repeat(32), target), false)
  assert.equal(session.hasRememberedRepeaterPassword(radio, 'dd'.repeat(32)), false)
  assert.equal(JSON.stringify(session).includes('fixture-secret'), false)
  assert.equal(JSON.stringify(session.getSnapshot()).includes('fixture-secret'), false)
  const before = port.commands.filter(([code]) => code === 26).length
  contact[36] = 0x46
  await assert.rejects(session.resumeRepeater(radio, target, route, signal()), /route changed/)
  assert.equal(port.commands.filter(([code]) => code === 26).length, before)
  contact[36] = 0x45
  assert.deepEqual(await session.resumeRepeater(radio, target, route, signal()), { role: 'admin', route: 'direct' })
  assert.deepEqual(port.commands.filter(([code]) => code === 26).at(-1),
    [26, ...contact.slice(1, 33), ...encode('fixture-secret'), 0])
  await session.disconnect()
  await session.connect()
  port = ports[1]
  assert.equal(session.hasRememberedRepeaterPassword(radio, target), true)
  assert.equal(port.commands.filter(([code]) => code === 26).length, 0)
  await session.resumeRepeater(radio, target, route, signal())
  assert.deepEqual(port.commands.filter(([code]) => code === 26).at(-1),
    [26, ...contact.slice(1, 33), ...encode('fixture-secret'), 0])
  mode = 'hold'
  const controller = new AbortController()
  const resumed = session.resumeRepeater(radio, target, route, controller.signal)
  await waitFor(() => release)
  assert.throws(() => session.clearRepeaterAccess(radio, target), /Wait for the current radio action/)
  controller.abort(new Error('Stopped waiting'))
  await assert.rejects(resumed, /Stopped waiting/)
  release()
  session.clearRepeaterAccess(radio, target)
  const beforeRetry = port.commands.filter(([code]) => code === 26).length
  await assert.rejects(session.resumeRepeater(radio, target, route, signal()), /Reconnect/)
  await assert.rejects(session.manageRepeater(radio, target, route, 'status', '', signal()), /Reconnect/)
  assert.equal(port.commands.filter(([code]) => code === 26).length, beforeRetry)
  await session.disconnect()
  await session.connect()
  port = ports[2]
  mode = 'success'
  session.forgetRepeaterPassword(radio, target)
  assert.equal(session.hasRememberedRepeaterPassword(radio, target), false)
  assert.throws(() => session.resumeRepeater(radio, target, route, signal()), /No repeater password/)
  mode = 'reject'
  await assert.rejects(session.manageRepeater(radio, target, route, 'login', 'wrong', signal(), true), /rejected/)
  assert.equal(session.hasRememberedRepeaterPassword(radio, target), false)
  mode = 'hold'
  release = undefined
  const login = session.manageRepeater(radio, target, route, 'login', 'fixture-secret', signal(), true)
  await waitFor(() => release)
  assert.throws(() => session.clearRepeaterAccess(radio, target), /Wait for the current radio action/)
  session.forgetRepeaterPassword(radio, target)
  release()
  await login
  assert.equal(session.hasRememberedRepeaterPassword(radio, target), false)
  session.clearRepeaterAccess(radio, target)
  await assert.rejects(session.manageRepeater(radio, target, route, 'status', '', signal()), /Log in/)
})

test('uncertain repeater logins reject retries and cannot regain a role from a late admin reply', async (t) => {
  for (const outcome of ['cancel-before-confirmation', 'cancel-after-confirmation', 'timeout']) {
    await t.test(outcome, async (t) => {
      const contact = contactInfo()
      contact[33] = 2
      contact[35] = 0
      let confirm
      const port = new FixturePort(([code], serial) => {
        if (code === 22) serial.emit(...deviceInfo())
        else if (code === 1) serial.emit(...selfInfo())
        else if (code === 4) {
          serial.emit(2, 1, 0, 0, 0)
          serial.emit(...contact)
          serial.emit(4, 0, 0, 0, 0)
        } else if (code === 26) {
          confirm = () => serial.emit(6, 0, 0, 0, 0, 0, 0, 0, 0, 0)
          if (outcome !== 'cancel-before-confirmation') confirm()
        } else assert.fail(`Unexpected command ${code}`)
      })
      const session = sessionWith(port)
      await session.connect()
      t.after(() => session.disconnect())
      if (outcome === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] })
      const key = 'ab'.repeat(32)
      const target = 'bc'.repeat(32)
      const route = { pathLength: 0, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
      const controller = new AbortController()
      const pending = session.manageRepeater(key, target, route, 'login', 'fixture', controller.signal)
      const rejected = assert.rejects(pending, outcome === 'timeout' ? /before the timeout/ : /Stopped waiting/)
      for (let i = 0; i < 20 && !confirm; i++) await setImmediate()
      assert.equal(typeof confirm, 'function')
      // Allow the confirmation to be processed and the remote-reply timer to start.
      await setImmediate()
      if (outcome === 'timeout') {
        t.mock.timers.tick(10_000)
      } else {
        controller.abort(new Error('Stopped waiting'))
        if (outcome === 'cancel-before-confirmation') confirm()
      }
      await rejected
      t.mock.timers.reset()
      const commandsBeforeRetry = port.commands.length
      await assert.rejects(session.manageRepeater(key, target, route, 'login', '', new AbortController().signal), /Reconnect/)
      port.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
      await setImmediate()
      await assert.rejects(session.manageRepeater(key, target, route, 'login', '', new AbortController().signal), /Reconnect/)
      await assert.rejects(session.manageRepeater(key, target, route, 'status', '', new AbortController().signal), /Reconnect/)
      assert.equal(port.commands.length, commandsBeforeRetry)
      assert.equal(port.commands.filter(([code]) => code === 26).length, 1)
      assert.equal(port.commands.some(([code]) => code === 27), false)
      assert.equal(session.getSnapshot().phase, 'ready')
    })
  }
})

test('unclassifiable repeater confirmations block retries despite a late admin reply', async (t) => {
  for (const operation of ['login', 'status']) {
    for (const confirmation of [[6, 0], [6, 2, ...new Uint8Array(8)], [0], [1]]) {
      await t.test(`${operation}: ${confirmation.join(',')}`, async (t) => {
        const contact = contactInfo()
        contact[33] = 2
        contact[35] = 0
        let malformed = operation === 'login'
        const port = new FixturePort(([code], serial) => {
          if (code === 22) serial.emit(...deviceInfo())
          else if (code === 1) serial.emit(...selfInfo())
          else if (code === 4) {
            serial.emit(2, 1, 0, 0, 0)
            serial.emit(...contact)
            serial.emit(4, 0, 0, 0, 0)
          } else if (code === 26 || code === 27) {
            if (malformed) serial.emit(...confirmation)
            else {
              serial.emit(6, 0, ...new Uint8Array(8))
              serial.emit(0x85, 0, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
            }
          } else assert.fail(`Unexpected command ${code}`)
        })
        const session = sessionWith(port)
        await session.connect()
        t.after(() => session.disconnect())
        const key = 'ab'.repeat(32)
        const target = 'bc'.repeat(32)
        const route = { pathLength: 0, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
        if (operation === 'status') {
          await session.manageRepeater(key, target, route, 'login', '', new AbortController().signal)
          malformed = true
        }
        await assert.rejects(session.manageRepeater(key, target, route, operation, '', new AbortController().signal), /Reconnect/)
        const dispatched = port.commands.length
        await assert.rejects(session.manageRepeater(key, target, route, 'login', '', new AbortController().signal), /Reconnect/)
        port.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
        await setImmediate()
        await assert.rejects(session.manageRepeater(key, target, route, 'login', '', new AbortController().signal), /Reconnect/)
        await assert.rejects(session.manageRepeater(key, target, route, 'status', '', new AbortController().signal), /Reconnect/)
        assert.equal(port.commands.length, dispatched)
        assert.equal(session.getSnapshot().phase, 'ready')
      })
    }
  }
})

test('definite companion rejection leaves repeater login retryable', async (t) => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 0
  let reject = true
  const port = new FixturePort(([code], serial) => {
    if (code === 22) serial.emit(...deviceInfo())
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) {
      serial.emit(2, 1, 0, 0, 0)
      serial.emit(...contact)
      serial.emit(4, 0, 0, 0, 0)
    } else if (code === 26) {
      if (reject) serial.emit(1, 2)
      else {
        serial.emit(6, 0, ...new Uint8Array(8))
        serial.emit(0x85, 0, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
      }
    } else assert.fail(`Unexpected command ${code}`)
  })
  const session = sessionWith(port)
  await session.connect()
  t.after(() => session.disconnect())
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 0, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  await assert.rejects(session.manageRepeater(key, target, route, 'login', '', new AbortController().signal), /companion rejected/)
  reject = false
  assert.deepEqual(await session.manageRepeater(key, target, route, 'login', '', new AbortController().signal),
    { role: 'guest', route: 'direct' })
  assert.equal(port.commands.filter(([code]) => code === 26).length, 2)
})

test('room read-only policy commands require a current administrator and a uniquely saved room', async (t) => {
  const contact = contactInfo()
  contact[33] = 3
  contact[35] = 1
  contact[36] = 0x45
  let admin = false
  let duplicate = false
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, duplicate ? 2 : 1, 0, 0, 0)
        serial.emit(...contact)
        if (duplicate) {
          const other = contact.slice()
          other[7] = 0xdd
          serial.emit(...other)
        }
        serial.emit(4, 0, 0, 0, 0)
        break
      case 26:
        serial.emit(6, 0, ...new Uint8Array(8))
        serial.emit(0x85, 0, ...contact.slice(1, 7), 1, 0, 0, 0, admin ? 3 : 0, 1)
        break
      case 2: serial.emit(6, 0, ...new Uint8Array(8)); break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  await session.connect()
  t.after(() => session.disconnect())
  const radio = 'ab'.repeat(32)
  const room = 'bc'.repeat(32)
  const signal = () => new AbortController().signal
  const actions = [
    [{ kind: 'read-allow-read-only' }, 'get allow.read.only'],
    [{ kind: 'allow-read-only', enabled: true }, 'set allow.read.only on'],
    [{ kind: 'allow-read-only', enabled: false }, 'set allow.read.only off'],
  ]
  for (const [action] of actions) {
    await assert.rejects(session.administerNode(radio, room, action, signal()), /administrator/)
  }
  await session.loginNode(radio, room, '', signal())
  for (const [action] of actions) {
    await assert.rejects(session.administerNode(radio, room, action, signal()), /administrator/)
  }
  assert.equal(port.commands.some(([code]) => code === 2), false)
  admin = true
  await session.loginNode(radio, room, 'fixture-admin', signal())
  for (const [action, text] of actions) {
    assert.equal(await session.administerNode(radio, room, action, signal()), 'direct')
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(frame[1], 1)
    assert.deepEqual(frame.slice(7, 13), new Array(6).fill(0xbc))
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), text)
  }
  const sent = port.commands.filter(([code]) => code === 2).length
  contact[33] = 4
  for (const [action] of actions) {
    await assert.rejects(session.administerNode(radio, room, action, signal()), /room server/)
  }
  contact[33] = 2
  await assert.rejects(session.administerNode(radio, room, actions[0][0], signal()), /saved room server or sensor/)
  contact[33] = 3
  duplicate = true
  await assert.rejects(session.administerNode(radio, room, actions[0][0], signal()), /unique key prefix/)
  assert.equal(port.commands.filter(([code]) => code === 2).length, sent)
})

test('repeater CLI requires current admin access, a verified route, and confirmed advertisements', async (t) => {
  t.mock.method(globalThis.crypto, 'getRandomValues', (values) => { values[0] = 0; return values })
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 1
  contact[36] = 0x45
  let admin = false
  let duplicate = false
  let malformed = false
  let delayed = false
  let holdAccess = false
  let badAccess = false
  let holdNeighbor = false
  let badNeighbor = false
  let accessTag = 0
  let lateAccess
  let lateNeighbor
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contact)
        if (duplicate) {
          const other = contact.slice()
          other[5] = 0xdd
          serial.emit(...other)
        }
        serial.emit(4, 0, 0, 0, 0)
        break
      case 26:
        serial.emit(6, 0, ...new Uint8Array(8))
        serial.emit(0x85, Number(admin), ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
        break
      case 2:
        if (delayed) break
        if (malformed) serial.emit(6, 0)
        else serial.emit(6, 0, 0, 0, 0, 0, 0xe8, 3, 0, 0)
        break
      case 50: {
        const tag = [++accessTag, 2, 3, 4]
        serial.emit(6, 0, ...tag, 0xe8, 3, 0, 0)
        if (command[33] === 6) {
          const reply = () => serial.emit(0x8c, 0, ...tag, 1, 0, 1, 0,
            ...new Uint8Array(32).fill(0xdd), 42, 0, 0, 0, ...(badNeighbor ? [] : [0xec]))
          if (holdNeighbor) lateNeighbor = reply
          else {
            if (lateNeighbor) { lateNeighbor(); lateNeighbor = undefined }
            reply()
          }
          break
        }
        const reply = () => serial.emit(0x8c, 0, ...tag, ...new Uint8Array(6).fill(0xdd), ...(badAccess ? [] : [3]))
        if (holdAccess) lateAccess = reply
        else {
          if (lateAccess) { lateAccess(); lateAccess = undefined }
          reply()
        }
        break
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  await session.connect()
  t.after(() => session.disconnect())
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 1, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  const signal = () => new AbortController().signal
  const send = (command, confirmed = false) => session.sendRepeaterCommand(key, target, route, command, confirmed, signal())
  const readAccess = () => session.readRepeaterAccessList(key, target, route, signal())
  const readNeighbors = () => session.readRepeaterNeighbors(key, target, route, 0, signal())
  await assert.rejects(readAccess(), /administrator/)
  await assert.rejects(readNeighbors(), /Log in/)
  await assert.rejects(send('ver'), /administrator/)
  await assert.rejects(send('get public.key'), /administrator/)
  await assert.rejects(send('get role'), /administrator/)
  await assert.rejects(send('get bootloader.ver'), /administrator/)
  for (const command of ['get pwrmgt.support', 'get pwrmgt.source', 'get pwrmgt.bootreason', 'get pwrmgt.bootmv']) {
    await assert.rejects(send(command), /administrator/)
  }
  for (const command of ['get bridge.type', 'get bridge.enabled', 'get bridge.delay',
    'get bridge.source', 'get bridge.baud', 'get bridge.channel']) {
    await assert.rejects(send(command), /administrator/)
  }
  for (const command of ['set bridge.enabled on', 'set bridge.enabled off', 'set bridge.source rx', 'set bridge.source tx']) {
    await assert.rejects(send(command, true), /administrator/)
  }
  await assert.rejects(send('set bridge.delay 500', true), /administrator/)
  await assert.rejects(send('set bridge.channel 6', true), /administrator/)
  await assert.rejects(send('set bridge.baud 9600', true), /administrator/)
  await assert.rejects(send('neighbors'), /administrator/)
  await assert.rejects(send('discover.neighbors', true), /administrator/)
  await assert.rejects(send(`neighbor.remove ${'dd'.repeat(32)}`, true), /administrator/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 0`, true), /administrator/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 3`, true), /administrator/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 1`, true), /administrator/)
  await assert.rejects(send('clock sync', true), /administrator/)
  await assert.rejects(send('time 1709210040', true), /administrator/)
  await assert.rejects(send('clear stats', true), /administrator/)
  for (const command of ['log start', 'log stop', 'log erase']) {
    await assert.rejects(send(command, true), /administrator/)
  }
  await assert.rejects(send('set owner.info Public info', true), /administrator/)
  await assert.rejects(send('set name Relay', true), /administrator/)
  await assert.rejects(send('set lat 45', true), /administrator/)
  await assert.rejects(send('set repeat off', true), /administrator/)
  await assert.rejects(send('set af 9', true), /administrator/)
  await assert.rejects(send('set txdelay 0.5', true), /administrator/)
  await assert.rejects(send('set rxdelay 10', true), /administrator/)
  await assert.rejects(send('get adc.multiplier'), /administrator/)
  await assert.rejects(send('set adc.multiplier 1.234', true), /administrator/)
  await assert.rejects(send('set tx 12', true), /administrator/)
  await assert.rejects(send('set radio 910.525,62.5,7,5', true), /administrator/)
  await assert.rejects(send('tempradio 910.525,62.5,7,5,10', true), /administrator/)
  await assert.rejects(send('get radio.rxgain'), /administrator/)
  await assert.rejects(send('set radio.rxgain on', true), /administrator/)
  await assert.rejects(send('set agc.reset.interval 4', true), /administrator/)
  await assert.rejects(send('set multi.acks 1', true), /administrator/)
  await assert.rejects(send('set int.thresh 8', true), /administrator/)
  await assert.rejects(send('set guest.password Guest-123', true), /administrator/)
  await assert.rejects(send('set flood.max 0', true), /administrator/)
  await assert.rejects(send('set loop.detect strict', true), /administrator/)
  await assert.rejects(send('set path.hash.mode 2', true), /administrator/)
  await assert.rejects(send('region'), /administrator/)
  await assert.rejects(send('region list allowed'), /administrator/)
  await assert.rejects(send('region home #North', true), /administrator/)
  await assert.rejects(send('region put #North', true), /administrator/)
  await assert.rejects(send('region remove #North', true), /administrator/)
  await assert.rejects(send('region denyf #North', true), /administrator/)
  await assert.rejects(send('region denyf *', true), /administrator/)
  await assert.rejects(send('region save', true), /administrator/)
  await assert.rejects(send('gps advert'), /administrator/)
  await assert.rejects(send('sensor get gps'), /administrator/)
  await assert.rejects(send('sensor set gps_interval 60', true), /administrator/)
  await assert.rejects(send('gps on', true), /administrator/)
  await assert.rejects(send('gps sync', true), /administrator/)
  await assert.rejects(send('gps setloc', true), /administrator/)
  await assert.rejects(send('gps advert prefs', true), /administrator/)
  await assert.rejects(send('powersaving'), /administrator/)
  await assert.rejects(send('powersaving on', true), /administrator/)
  await assert.rejects(send('set advert.interval 60', true), /administrator/)
  await session.manageRepeater(key, target, route, 'login', '', signal())
  await assert.rejects(readAccess(), /administrator/)
  assert.deepEqual(await readNeighbors(), {
    total: 1, entries: [{ publicKey: 'dd'.repeat(32), secondsAgo: 42, snrDb: -5 }],
  })
  assert.deepEqual(port.commands.filter(([code]) => code === 50).at(-1).slice(33, 40), [6, 0, 3, 0, 0, 0, 32])
  badNeighbor = true
  await assert.rejects(readNeighbors(), /invalid neighbor page/)
  badNeighbor = false
  holdNeighbor = true
  const cancelNeighbor = new AbortController()
  const pendingNeighbor = session.readRepeaterNeighbors(key, target, route, 0, cancelNeighbor.signal)
  await waitFor(() => lateNeighbor !== undefined)
  cancelNeighbor.abort(new Error('Stopped waiting'))
  await assert.rejects(pendingNeighbor, /Stopped waiting/)
  holdNeighbor = false
  assert.deepEqual(await readNeighbors(), {
    total: 1, entries: [{ publicKey: 'dd'.repeat(32), secondsAgo: 42, snrDb: -5 }],
  })
  await assert.rejects(send('ver'), /administrator/)
  await assert.rejects(send('clear stats', true), /administrator/)
  await assert.rejects(send('get public.key'), /administrator/)
  await assert.rejects(send('get role'), /administrator/)
  await assert.rejects(send('get bootloader.ver'), /administrator/)
  for (const command of ['get pwrmgt.support', 'get pwrmgt.source', 'get pwrmgt.bootreason', 'get pwrmgt.bootmv']) {
    await assert.rejects(send(command), /administrator/)
  }
  for (const command of ['get bridge.type', 'get bridge.enabled', 'get bridge.delay',
    'get bridge.source', 'get bridge.baud', 'get bridge.channel']) {
    await assert.rejects(send(command), /administrator/)
  }
  for (const command of ['set bridge.enabled on', 'set bridge.enabled off', 'set bridge.source rx', 'set bridge.source tx']) {
    await assert.rejects(send(command, true), /administrator/)
  }
  await assert.rejects(send('set bridge.delay 500', true), /administrator/)
  await assert.rejects(send('set bridge.channel 6', true), /administrator/)
  await assert.rejects(send('set bridge.baud 9600', true), /administrator/)
  await assert.rejects(send('neighbors'), /administrator/)
  await assert.rejects(send('discover.neighbors', true), /administrator/)
  await assert.rejects(send(`neighbor.remove ${'dd'.repeat(32)}`, true), /administrator/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 0`, true), /administrator/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 3`, true), /administrator/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 2`, true), /administrator/)
  await assert.rejects(send('set owner.info Public info', true), /administrator/)
  await assert.rejects(send('set name Relay', true), /administrator/)
  await assert.rejects(send('set lat 45', true), /administrator/)
  await assert.rejects(send('set repeat on', true), /administrator/)
  await assert.rejects(send('set af 0', true), /administrator/)
  await assert.rejects(send('set direct.txdelay 0.5', true), /administrator/)
  await assert.rejects(send('get rxdelay'), /administrator/)
  await assert.rejects(send('get adc.multiplier'), /administrator/)
  await assert.rejects(send('set adc.multiplier 1.234', true), /administrator/)
  await assert.rejects(send('set tx 12', true), /administrator/)
  await assert.rejects(send('set radio 910.525,62.5,7,5', true), /administrator/)
  await assert.rejects(send('get radio.rxgain'), /administrator/)
  await assert.rejects(send('set radio.rxgain off', true), /administrator/)
  await assert.rejects(send('get agc.reset.interval'), /administrator/)
  await assert.rejects(send('get multi.acks'), /administrator/)
  await assert.rejects(send('get int.thresh'), /administrator/)
  await assert.rejects(send('set int.thresh 0', true), /administrator/)
  await assert.rejects(send('set multi.acks 0', true), /administrator/)
  await assert.rejects(send('set flood.max.unscoped 0', true), /administrator/)
  await assert.rejects(send('get loop.detect'), /administrator/)
  await assert.rejects(send('get path.hash.mode'), /administrator/)
  await assert.rejects(send('region get *'), /administrator/)
  await assert.rejects(send('region list denied'), /administrator/)
  await assert.rejects(send('region home *', true), /administrator/)
  await assert.rejects(send('region remove #North', true), /administrator/)
  await assert.rejects(send('region allowf #North', true), /administrator/)
  await assert.rejects(send('region allowf *', true), /administrator/)
  await assert.rejects(send('gps advert'), /administrator/)
  await assert.rejects(send('sensor get gps'), /administrator/)
  await assert.rejects(send('sensor set gps_interval 60', true), /administrator/)
  await assert.rejects(send('gps off', true), /administrator/)
  await assert.rejects(send('gps sync', true), /administrator/)
  await assert.rejects(send('gps setloc', true), /administrator/)
  await assert.rejects(send('gps advert share', true), /administrator/)
  await assert.rejects(send('powersaving'), /administrator/)
  await assert.rejects(send('powersaving off', true), /administrator/)
  admin = true
  await session.manageRepeater(key, target, route, 'login', '', signal())
  assert.deepEqual(await readAccess(), [{ prefix: 'dd'.repeat(6), permissions: 3, role: 'admin' }])
  assert.deepEqual(port.commands.filter(([code]) => code === 50).at(-1), [50, ...contact.slice(1, 33), 5, 0, 0])
  badAccess = true
  await assert.rejects(readAccess(), /incomplete access list/)
  badAccess = false
  holdAccess = true
  const cancelAccess = new AbortController()
  const pendingAccess = session.readRepeaterAccessList(key, target, route, cancelAccess.signal)
  await waitFor(() => lateAccess !== undefined)
  cancelAccess.abort(new Error('Stopped waiting'))
  await assert.rejects(pendingAccess, /Stopped waiting/)
  holdAccess = false
  assert.deepEqual(await readAccess(), [{ prefix: 'dd'.repeat(6), permissions: 3, role: 'admin' }])
  contact[36] = 0x46
  const changedRoute = { pathLength: 1, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  await assert.rejects(session.readRepeaterAccessList(key, target, changedRoute, signal()), /route changed/)
  await assert.rejects(session.readRepeaterNeighbors(key, target, changedRoute, 0, signal()), /route changed/)
  await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, 'get bootloader.ver', false, signal()), /route changed/)
  await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, 'sensor set gps_interval 60', true, signal()), /route changed/)
  for (const command of ['log start', 'log stop', 'log erase']) {
    await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, command, true, signal()), /route changed/)
  }
  for (const command of ['set bridge.enabled on', 'set bridge.enabled off', 'set bridge.source rx', 'set bridge.source tx']) {
    await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, command, true, signal()), /route changed/)
  }
  await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, 'set bridge.delay 500', true, signal()), /route changed/)
  await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, 'set bridge.channel 6', true, signal()), /route changed/)
  await assert.rejects(session.sendRepeaterCommand(key, target, changedRoute, 'set bridge.baud 9600', true, signal()), /route changed/)
  contact[36] = 0x45
  for (const command of ['get guest.password', 'get bridge.secret', 'set bridge.enabled yes', 'set bridge.source logRx', 'password secret', 'reboot now',
    'get allow.read.only', 'set allow.read.only on', 'set allow.read.only off']) {
    await assert.rejects(send(command, true), /supported repeater CLI command/)
  }
  await assert.rejects(send('advert'), /Confirm/)
  await assert.rejects(send('discover.neighbors'), /Confirm/)
  await assert.rejects(send(`neighbor.remove ${'dd'.repeat(32)}`), /Confirm/)
  await assert.rejects(send('neighbor.remove dddddddd', true), /supported repeater CLI command/)
  await assert.rejects(send('discover.neighbors extra', true), /supported repeater CLI command/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 0`), /Confirm/)
  await assert.rejects(send(`setperm ${key} 0`, true), /connected radio or repeater/)
  await assert.rejects(send(`setperm ${target.toUpperCase()} 0`, true), /connected radio or repeater/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 3`), /Confirm/)
  await assert.rejects(send(`setperm ${key} 3`, true), /connected radio or repeater/)
  await assert.rejects(send(`setperm ${target.toUpperCase()} 3`, true), /connected radio or repeater/)
  for (const role of [1, 2]) {
    await assert.rejects(send(`setperm ${'dd'.repeat(32)} ${role}`), /Confirm/)
    await assert.rejects(send(`setperm ${key.toUpperCase()} ${role}`, true), /connected radio or repeater/)
    await assert.rejects(send(`setperm ${target} ${role}`, true), /connected radio or repeater/)
  }
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 4`, true), /supported repeater CLI command/)
  await assert.rejects(send('clock sync'), /Confirm/)
  await assert.rejects(send('time 1709210040'), /Confirm/)
  await assert.rejects(send('clear stats'), /Confirm/)
  for (const command of ['log start', 'log stop', 'log erase']) {
    await assert.rejects(send(command), /Confirm/)
  }
  for (const command of ['set bridge.enabled on', 'set bridge.enabled off', 'set bridge.source rx', 'set bridge.source tx']) {
    await assert.rejects(send(command), /Confirm/)
  }
  await assert.rejects(send('set bridge.delay 500'), /Confirm/)
  await assert.rejects(send('set bridge.delay 10001', true), /whole bridge delay/)
  await assert.rejects(send('set bridge.channel 6'), /Confirm/)
  await assert.rejects(send('set bridge.channel 15', true), /whole ESP-NOW bridge channel/)
  await assert.rejects(send('set bridge.baud 9600'), /Confirm/)
  await assert.rejects(send('set bridge.baud 115201', true), /whole RS-232 bridge baud rate/)
  await assert.rejects(send('set owner.info Public info'), /Confirm/)
  await assert.rejects(send('set name Relay'), /Confirm/)
  await assert.rejects(send('set lat 45'), /Confirm/)
  await assert.rejects(send('set repeat on'), /Confirm/)
  await assert.rejects(send('set repeat off'), /Confirm/)
  await assert.rejects(send('set af 9'), /Confirm/)
  await assert.rejects(send('set txdelay 0'), /Confirm/)
  await assert.rejects(send('set direct.txdelay 2'), /Confirm/)
  await assert.rejects(send('set rxdelay 10'), /Confirm/)
  await assert.rejects(send('set adc.multiplier 1.234'), /Confirm/)
  await assert.rejects(send('set adc.multiplier 10.001', true), /battery ADC multiplier/)
  await assert.rejects(send('set tx 12'), /Confirm/)
  await assert.rejects(send('set radio 910.525,62.5,7,5'), /Confirm/)
  await assert.rejects(send('tempradio 910.525,62.5,7,5,10'), /Confirm/)
  await assert.rejects(send('tempradio 910.525,62.5,7,5,35792', true), /override duration/)
  await assert.rejects(send('set radio 399,62.5,7,5', true), /Enter frequency 400/)
  await assert.rejects(send('set radio.rxgain on'), /Confirm/)
  await assert.rejects(send('set radio.rxgain off'), /Confirm/)
  await assert.rejects(send('set agc.reset.interval 4'), /Confirm/)
  await assert.rejects(send('set agc.reset.interval 5', true), /AGC reset interval/)
  await assert.rejects(send('set multi.acks 1'), /Confirm/)
  await assert.rejects(send('set multi.acks 0'), /Confirm/)
  await assert.rejects(send('set multi.acks 2', true), /supported repeater CLI command/)
  await assert.rejects(send('set int.thresh 8'), /Confirm/)
  await assert.rejects(send('set int.thresh 256', true), /interference threshold/)
  await assert.rejects(send('set radio.rxgain on extra', true), /supported repeater CLI command/)
  await assert.rejects(send('set guest.password Guest-123'), /Confirm/)
  await assert.rejects(send('set flood.max.advert 0'), /Confirm/)
  await assert.rejects(send('set loop.detect strict'), /Confirm/)
  await assert.rejects(send('set loop.detect extreme', true), /supported repeater CLI command/)
  await assert.rejects(send('set path.hash.mode 2'), /Confirm/)
  await assert.rejects(send('set path.hash.mode 3', true), /supported repeater CLI command/)
  for (const command of ['region allowf *', 'region denyf *', 'region save']) {
    await assert.rejects(send(command), /Confirm/)
  }
  for (const policy of ['none', 'prefs', 'share']) {
    await assert.rejects(send(`gps advert ${policy}`), /Confirm/)
  }
  await assert.rejects(send('gps on'), /Confirm/)
  await assert.rejects(send('sensor set gps_interval 60'), /Confirm/)
  await assert.rejects(send('sensor set gps_interval 3601', true), /whole GPS coordinate-copy interval/)
  await assert.rejects(send('gps off'), /Confirm/)
  await assert.rejects(send('gps sync'), /Confirm/)
  await assert.rejects(send('gps setloc'), /Confirm/)
  for (const command of ['powersaving on', 'powersaving off']) {
    await assert.rejects(send(command), /Confirm/)
  }
  await assert.rejects(send('powersaving off extra', true), /supported repeater CLI command/)
  await assert.rejects(send('gps advert share extra', true), /supported repeater CLI command/)
  await assert.rejects(send('region denyf North'), /Confirm/)
  await assert.rejects(send('region put #North'), /Confirm/)
  await assert.rejects(send('region put North\nregion save', true), /region name or prefix/)
  await assert.rejects(send('region remove #North'), /Confirm/)
  await assert.rejects(send('region remove *', true), /named region/)
  await assert.rejects(send('region remove North\nregion save', true), /region name or prefix/)
  await assert.rejects(send('region allowf North'), /Confirm/)
  await assert.rejects(send('region denyf North\nregion save', true), /region name or prefix/)
  await assert.rejects(send('region home #North'), /Confirm/)
  await assert.rejects(send('region home North\nregion save', true), /region name or prefix/)
  await assert.rejects(send('set flood.max 256', true), /flood hop limit/)
  await assert.rejects(send('set tx 23', true), /transmit power from 1 to 22/)
  await assert.rejects(send('set tx 12\nreboot', true), /transmit power from 1 to 22/)
  await assert.rejects(send('set af 9.01', true), /airtime factor/)
  await assert.rejects(send('set af 1\nreboot', true), /airtime factor/)
  await assert.rejects(send('set txdelay 2.01', true), /retransmission delay factor/)
  await assert.rejects(send('set direct.txdelay 1\nreboot', true), /retransmission delay factor/)
  await assert.rejects(send('set rxdelay 20.01', true), /receive-delay base/)
  await assert.rejects(send('set advert.interval 60'), /Confirm/)
  await assert.rejects(send('set advert.interval 61', true), /even local interval/)
  contact[36] = 0x46
  await assert.rejects(send('ver'), /route changed/)
  await assert.rejects(send('get bridge.type'), /route changed/)
  await assert.rejects(send('set radio 910.525,62.5,7,5', true), /route changed/)
  await assert.rejects(send(`neighbor.remove ${'dd'.repeat(32)}`, true), /route changed/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 3`, true), /route changed/)
  await assert.rejects(send(`setperm ${'dd'.repeat(32)} 1`, true), /route changed/)
  contact[36] = 0x45
  duplicate = true
  await assert.rejects(send('ver'), /shares a response prefix/)
  duplicate = false
  assert.equal(port.commands.some(([code]) => code === 2), false)
  const first = await send('get name')
  assert.equal(first.route, 'direct')
  const firstFrame = port.commands.find(([code]) => code === 2)
  assert.equal(firstFrame[1], 1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(firstFrame.slice(13))), `${first.tag}|get name`)
  const second = await send('advert.zerohop', true)
  assert.notEqual(second.tag, first.tag)
  assert.equal(port.commands.filter(([code]) => code === 2).length, 2)
  malformed = true
  let unconfirmedTag
  await assert.rejects(send('ver'), (error) => {
    unconfirmedTag = error.tag
    return /may have sent/.test(error.message)
  })
  assert.equal(port.commands.filter(([code]) => code === 2).length, 3)
  malformed = false
  const retry = await send('ver')
  assert.equal(unconfirmedTag, '02')
  assert.equal(retry.tag, '03')
  delayed = true
  const pending = send('board')
  await waitFor(() => port.commands.filter(([code]) => code === 2).length === 5)
  assert.throws(() => session.reserveQueuedMessage(key), /contact change/)
  port.emit(6, 0, ...new Uint8Array(8))
  await pending
  delayed = false
  const bridgeType = await send('get bridge.type')
  assert.equal(bridgeType.route, 'direct')
  const bridgeFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(bridgeFrame.slice(13))), `${bridgeType.tag}|get bridge.type`)
  const changed = await send('set flood.advert.interval 3', true)
  const frame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${changed.tag}|set flood.advert.interval 3`)
  const clock = await send('clock sync', true)
  const clockFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(clockFrame.slice(13))), `${clock.tag}|clock sync`)
  const neighbors = await send('neighbors')
  const neighborsFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(neighborsFrame.slice(13))), `${neighbors.tag}|neighbors`)
  const owner = await send('set owner.info Public|info', true)
  const ownerFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(ownerFrame.slice(13))), `${owner.tag}|set owner.info Public|info`)
  const rename = await send('set name Relay 🛰', true)
  const renameFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(renameFrame.slice(13))), `${rename.tag}|set name Relay 🛰`)
  for (const command of ['set lat 90.1', 'set lon -180.1', 'set lat 1.1234567', 'set lon 1e2']) {
    await assert.rejects(send(command, true), /latitude|longitude/)
  }
  const position = await send('set lat 47.123456', true)
  const positionFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(positionFrame.slice(13))),
    `${position.tag}|set lat 47.123456`)
  const policy = await send('gps advert')
  const policyFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(policyFrame.slice(13))), `${policy.tag}|gps advert`)
  for (const command of ['set repeat on', 'set repeat off']) {
    const receipt = await send(command, true)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  const txPower = await send('set tx 14', true)
  const txPowerFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(txPowerFrame.slice(13))), `${txPower.tag}|set tx 14`)
  const radioSettings = await send('set radio 910.525,62.5,7,5', true)
  const radioSettingsFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(radioSettingsFrame.slice(13))),
    `${radioSettings.tag}|set radio 910.525,62.5,7,5`)
  for (const command of ['set txdelay 0.5', 'set direct.txdelay 0.25']) {
    const receipt = await send(command, true)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get rxdelay', false], ['set rxdelay 10.25', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  const airtime = await send('set af 9', true)
  const airtimeFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(airtimeFrame.slice(13))), `${airtime.tag}|set af 9`)
  const guestPassword = await send('set guest.password Guest-123', true)
  const guestPasswordFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(guestPasswordFrame.slice(13))),
    `${guestPassword.tag}|set guest.password Guest-123`)
  const regionPut = await send('region put #North', true)
  const regionPutFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(regionPutFrame.slice(13))), `${regionPut.tag}|region put #North`)
  const regionRemove = await send('region remove #North', true)
  const regionRemoveFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(regionRemoveFrame.slice(13))), `${regionRemove.tag}|region remove #North`)
  for (const command of ['region list allowed', 'region list denied']) {
    const receipt = await send(command)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  const receiverGain = await send('set radio.rxgain on', true)
  const receiverGainFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(receiverGainFrame.slice(13))), `${receiverGain.tag}|set radio.rxgain on`)
  const bootloader = await send('get bootloader.ver')
  const bootloaderFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(bootloaderFrame.slice(13))), `${bootloader.tag}|get bootloader.ver`)
  for (const command of ['sensor set gps_interval 1', 'sensor set gps_interval 3600']) {
    const receipt = await send(command, true)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get bridge.delay', false], ['set bridge.delay 0', true], ['set bridge.delay 10000', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get bridge.channel', false], ['set bridge.channel 1', true], ['set bridge.channel 14', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get bridge.baud', false], ['set bridge.baud 9600', true], ['set bridge.baud 115200', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get agc.reset.interval', false], ['set agc.reset.interval 16', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get multi.acks', false], ['set multi.acks 1', true], ['set multi.acks 0', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  for (const [command, confirmed] of [['get int.thresh', false], ['set int.thresh 8', true], ['set int.thresh 0', true]]) {
    const receipt = await send(command, confirmed)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  }
  const discovery = await send('discover.neighbors', true)
  const discoveryFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(discoveryFrame.slice(13))), `${discovery.tag}|discover.neighbors`)
  const neighborRemoval = await send(`neighbor.remove ${'dd'.repeat(32)}`, true)
  const neighborRemovalFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(neighborRemovalFrame.slice(13))), `${neighborRemoval.tag}|neighbor.remove ${'dd'.repeat(32)}`)
  const removal = await send(`setperm ${'dd'.repeat(32)} 0`, true)
  const removalFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(removalFrame.slice(13))), `${removal.tag}|setperm ${'dd'.repeat(32)} 0`)
  const grant = await send(`setperm ${'dd'.repeat(32)} 3`, true)
  const grantFrame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(grantFrame.slice(13))), `${grant.tag}|setperm ${'dd'.repeat(32)} 3`)
  for (const role of [1, 2]) {
    const receipt = await send(`setperm ${'dd'.repeat(32)} ${role}`, true)
    const frame = port.commands.filter(([code]) => code === 2).at(-1)
    assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|setperm ${'dd'.repeat(32)} ${role}`)
  }
})

for (const command of ['reboot', 'clkreboot']) test(`${command} invalidates repeater access after acceptance or uncertain dispatch`, async (t) => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 0
  let admin = false
  let confirmation = [6, 0, ...new Uint8Array(8)]
  const port = new FixturePort((command, serial) => {
    if (command[0] === 22) serial.emit(...deviceInfo())
    else if (command[0] === 1) serial.emit(...selfInfo())
    else if (command[0] === 4) {
      serial.emit(2, 1, 0, 0, 0)
      serial.emit(...contact)
      serial.emit(4, 0, 0, 0, 0)
    } else if (command[0] === 26) {
      serial.emit(6, 0, ...new Uint8Array(8))
      serial.emit(0x85, Number(admin), ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
    } else if (command[0] === 2) serial.emit(...confirmation)
    else assert.fail(`Unexpected command ${command[0]}`)
  })
  const session = sessionWith(port)
  await session.connect()
  t.after(() => session.disconnect())
  const radio = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 0, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  const signal = () => new AbortController().signal
  const send = (command, confirmed = false) => session.sendRepeaterCommand(radio, target, route, command, confirmed, signal())
  await assert.rejects(send(command), /Confirm/)
  await assert.rejects(send(command, true), /administrator/)
  await session.manageRepeater(radio, target, route, 'login', '', signal())
  await assert.rejects(send(command, true), /administrator/)
  assert.equal(port.commands.some(([code]) => code === 2), false)
  admin = true
  await session.manageRepeater(radio, target, route, 'login', '', signal())
  contact[35] = 1
  await assert.rejects(send(command, true), /route changed/)
  assert.equal(port.commands.some(([code]) => code === 2), false)
  contact[35] = 0
  confirmation = [1, 2]
  await assert.rejects(send(command, true), { code: 'device-error' })
  confirmation = [6, 0, ...new Uint8Array(8)]
  await send('ver')
  confirmation = [6, 0]
  await assert.rejects(send(command, true), /may have sent/)
  await assert.rejects(send('ver'), /administrator/)
  await assert.rejects(session.manageRepeater(radio, target, route, 'status', '', signal()), /Log in/)
  await session.manageRepeater(radio, target, route, 'login', '', signal())
  confirmation = [6, 0, ...new Uint8Array(8)]
  const receipt = await send(command, true)
  const frame = port.commands.filter(([code]) => code === 2).at(-1)
  assert.equal(new TextDecoder().decode(Uint8Array.from(frame.slice(13))), `${receipt.tag}|${command}`)
  await assert.rejects(send('ver'), /administrator/)
  await assert.rejects(session.manageRepeater(radio, target, route, 'status', '', signal()), /Log in/)
})

test('repeater CLI does not reuse reply tags after reconnecting', async (t) => {
  t.mock.method(globalThis.crypto, 'getRandomValues', (values) => { values[0] = 0; return values })
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 0
  const fixture = () => new FixturePort(([code], serial) => {
    if (code === 22) serial.emit(...deviceInfo())
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) {
      serial.emit(2, 1, 0, 0, 0)
      serial.emit(...contact)
      serial.emit(4, 0, 0, 0, 0)
    } else if (code === 26) {
      serial.emit(6, 0, ...new Uint8Array(8))
      serial.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
    } else if (code === 2) serial.emit(6, 0, ...new Uint8Array(8))
    else assert.fail(`Unexpected command ${code}`)
  })
  const ports = [fixture(), fixture()]
  const session = sessionWith(ports[0], 1000, {
    environment: { secureContext: true, serial: { requestPort: async () => ports.shift(), getPorts: async () => [] } },
  })
  t.after(() => session.disconnect())
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 0, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  const signal = () => new AbortController().signal
  const sendAfterLogin = async () => {
    await session.connect()
    await session.manageRepeater(key, target, route, 'login', '', signal())
    return session.sendRepeaterCommand(key, target, route, 'ver', false, signal())
  }
  const first = await sendAfterLogin()
  await session.disconnect()
  const second = await sendAfterLogin()
  assert.equal(first.tag, '00')
  assert.equal(second.tag, '01')
})

test('repeater CLI respects uncertain login state and an active message lease', async (t) => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 0
  let reply = true
  const port = new FixturePort(([code], serial) => {
    if (code === 22) serial.emit(...deviceInfo())
    else if (code === 1) serial.emit(...selfInfo())
    else if (code === 4) {
      serial.emit(2, 1, 0, 0, 0)
      serial.emit(...contact)
      serial.emit(4, 0, 0, 0, 0)
    } else if (code === 26) {
      serial.emit(6, 0, ...new Uint8Array(8))
      if (reply) serial.emit(0x85, 1, ...contact.slice(1, 7), 1, 0, 0, 0, 1, 2)
    } else if (code === 2) serial.emit(6, 0, ...new Uint8Array(8))
    else assert.fail(`Unexpected command ${code}`)
  })
  const session = sessionWith(port)
  await session.connect()
  t.after(() => session.disconnect())
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const route = { pathLength: 0, pathHex: Buffer.from(contact.slice(36, 100)).toString('hex') }
  const signal = () => new AbortController().signal
  await session.manageRepeater(key, target, route, 'login', '', signal())
  const lease = session.reserveQueuedMessage(key)
  await assert.rejects(session.sendRepeaterCommand(key, target, route, 'ver', false, signal()), /message sync/)
  lease.release()
  reply = false
  const controller = new AbortController()
  const pending = session.manageRepeater(key, target, route, 'login', '', controller.signal)
  await waitFor(() => port.commands.filter(([code]) => code === 26).length === 2)
  controller.abort(new Error('Stopped waiting'))
  await assert.rejects(pending, /Stopped waiting/)
  await assert.rejects(session.sendRepeaterCommand(key, target, route, 'ver', false, signal()), /Reconnect/)
  assert.equal(port.commands.some(([code]) => code === 2), false)
})

test('repeater details verify the current contact and direct route before sending', async () => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 0
  let holdRead = false
  let rejectDetails = false
  let lookupError = false
  let finishRead
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contact)
        serial.emit(4, 0, 0, 0, 0)
        break
      case 30: {
        const reply = () => {
          if (lookupError) serial.emit(1, 1)
          else if (command[1] !== 0xbc) serial.emit(1, 2)
          else serial.emit(...contact)
        }
        if (holdRead) finishRead = reply
        else reply()
        break
      }
      case 57: {
        if (rejectDetails) {
          serial.emit(1, 1)
          break
        }
        const body = command[33] === 1 ? '*,local' : 'Relay\nOperator'
        serial.emit(0x8c, 0, 1, 2, 3, 4, 9, 0, 0, 0, ...encode(body))
        serial.emit(6, 0, 1, 2, 3, 4, 0xe8, 3, 0, 0)
        break
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  await session.connect()
  assert.deepEqual(await session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    { kind: 'regions', regions: ['*', 'local'] })
  assert.deepEqual(port.commands.at(-1), [57, ...new Uint8Array(32).fill(0xbc), 1, 0])
  assert.deepEqual(await session.discoverRepeaterDetails(key, target, 'owner', new AbortController().signal, () => {}),
    { kind: 'owner', name: 'Relay', owner: 'Operator' })
  assert.deepEqual(port.commands.at(-1), [57, ...new Uint8Array(32).fill(0xbc), 2, 0])

  rejectDetails = true
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    { code: 'unsupported-firmware' })
  assert.equal(session.getSnapshot().phase, 'ready')
  rejectDetails = false
  let sent = port.commands.filter(([code]) => code === 57).length
  contact[35] = 0xff
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    /saved repeater or its route changed/)
  contact[35] = 1
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    /saved repeater or its route changed/)
  contact[35] = 0
  contact[33] = 1
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    /saved repeater/)
  contact[33] = 2
  await assert.rejects(session.discoverRepeaterDetails(key, 'cd'.repeat(32), 'regions', new AbortController().signal, () => {}),
    /saved repeater/)
  contact[33] = 0
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    /temporary contact instead of the saved repeater/)
  contact[33] = 2
  lookupError = true
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}),
    /could not read this contact/)
  lookupError = false
  assert.equal(port.commands.filter(([code]) => code === 57).length, sent)

  contact[35] = 0x42
  contact.set([0x12, 0x34, 0x56, 0x78], 36)
  const options = { expectedRoute: { pathLength: 0x42, pathHex: '12345678' }, replyPath: { width: 2, text: '5678 1234' } }
  assert.deepEqual(await session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    { kind: 'regions', regions: ['*', 'local'] })
  assert.deepEqual(port.commands.at(-1), [57, ...new Uint8Array(32).fill(0xbc), 1, 0x42, 0x56, 0x78, 0x12, 0x34])
  sent++
  contact[36] = 0xaa
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    /saved repeater or its route changed/)
  contact[36] = 0x12
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {},
    { ...options, replyPath: { width: 2, text: '123' } }), /complete 2-byte hex hashes/)
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {},
    { ...options, expectedRoute: { pathLength: 0xff, pathHex: '' } }), /saved repeater or its route changed/)
  assert.equal(port.commands.filter(([code]) => code === 57).length, sent)

  contact[35] = 0
  holdRead = true
  const controller = new AbortController()
  const cancelled = session.discoverRepeaterDetails(key, target, 'regions', controller.signal, () => {})
  await waitFor(() => typeof finishRead === 'function')
  controller.abort(new Error('Cancelled before transmission'))
  finishRead()
  await assert.rejects(cancelled, /Cancelled before transmission/)
  assert.equal(port.commands.filter(([code]) => code === 57).length, sent)
  await session.disconnect()
})

test('unsaved repeater requests require v13 and verify any temporary contact route', async () => {
  let version = 14
  let temporary = false
  let holdReply = false
  const contact = contactInfo()
  contact.fill(0xcd, 1, 33)
  contact[33] = 0
  contact[35] = 0
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: { const info = deviceInfo(); info[1] = version; serial.emit(...info); break }
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 30: if (temporary) serial.emit(...contact); else serial.emit(1, 2); break
      case 57:
        temporary = true
        if (!holdReply) serial.emit(0x8c, 0, 1, 2, 3, 4, 9, 0, 0, 0, ...encode('*,local'))
        serial.emit(6, 0, 1, 2, 3, 4, 0xe8, 3, 0, 0)
        break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  const target = 'cd'.repeat(32)
  const options = { expectedRoute: null, replyPath: { width: 1, text: '' } }
  await session.connect()
  assert.deepEqual(await session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    { kind: 'regions', regions: ['*', 'local'] })
  assert.deepEqual(port.commands.at(-1), [57, ...new Uint8Array(32).fill(0xcd), 1, 0])
  assert.deepEqual(await session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    { kind: 'regions', regions: ['*', 'local'] })
  let sent = port.commands.filter(([code]) => code === 57).length
  contact[35] = 1
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    /repeater changed on the radio/)
  contact[35] = 0
  contact[33] = 2
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    /repeater changed on the radio/)
  assert.equal(port.commands.filter(([code]) => code === 57).length, sent)
  contact[33] = 0
  holdReply = true
  const controller = new AbortController()
  let waiting = false
  const pending = session.discoverRepeaterDetails(key, target, 'regions', controller.signal, () => { waiting = true }, options)
  await waitFor(() => waiting)
  controller.abort(new Error('Stopped waiting'))
  await assert.rejects(pending, /Stopped waiting/)
  sent++
  assert.equal(port.commands.filter(([code]) => code === 57).length, sent)
  assert.equal(port.commands.some(([code]) => code === 9), false)
  await session.disconnect()

  version = 12
  const oldPort = new FixturePort((command, serial) => {
    if (command[0] === 22) { const info = deviceInfo(); info[1] = version; serial.emit(...info) }
    else if (command[0] === 1) serial.emit(...selfInfo())
    else if (command[0] === 4) { serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0) }
    else assert.fail(`Unexpected command ${command[0]}`)
  })
  const oldSession = sessionWith(oldPort)
  await oldSession.connect()
  await assert.rejects(oldSession.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    { code: 'unsupported-firmware' })
  assert.equal(oldPort.commands.some(([code]) => code === 57), false)
  await oldSession.disconnect()
})

test('older firmware rejects unsupported saved and reply path widths before transmission', async () => {
  const contact = contactInfo()
  contact[33] = 2
  contact[35] = 0x41
  contact.set([0x12, 0x34], 36)
  const port = new FixturePort((command, serial) => {
    if (command[0] === 22) { const info = deviceInfo(); info[1] = 9; serial.emit(...info) }
    else if (command[0] === 1) serial.emit(...selfInfo())
    else if (command[0] === 4) { serial.emit(2, 1, 0, 0, 0); serial.emit(...contact); serial.emit(4, 0, 0, 0, 0) }
    else if (command[0] === 30) serial.emit(...contact)
    else assert.fail(`Unexpected command ${command[0]}`)
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const options = { expectedRoute: { pathLength: 0x41, pathHex: '1234' }, replyPath: { width: 1, text: '' } }
  await session.connect()
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {}, options),
    /does not support that saved path hash width/)
  await assert.rejects(session.discoverRepeaterDetails(key, target, 'regions', new AbortController().signal, () => {},
    { ...options, replyPath: { width: 2, text: '1234' } }), /does not support that reply path hash width/)
  assert.equal(port.commands.some(([code]) => code === 57), false)
  await session.disconnect()
})

function contactInfo() {
  const frame = Uint8Array.of(3, ...new Uint8Array(32).fill(0xbc), 1, 2, 0xff, ...new Uint8Array(112))
  frame.set(encode('Contact'), 100)
  const data = new DataView(frame.buffer)
  data.setUint32(132, 123, true)
  data.setInt32(136, -123000000, true)
  data.setUint32(144, 456, true)
  return frame
}

test('validates changes before writing and preserves successful settings across a rejected write', async (t) => {
  const key = 'ab'.repeat(32)
  const writes = []
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: {
        const self = selfInfo()
        self.set([7, 20], 2)
        self.set([1, 0x91], 46)
        const data = new DataView(self.buffer)
        data.setUint32(48, 915000, true)
        data.setUint32(52, 62500, true)
        self.set([7, 5], 56)
        serial.emit(...self)
        break
      }
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 60: {
        const frame = new Uint8Array(9)
        frame[0] = 26
        const data = new DataView(frame.buffer)
        data.setUint32(1, 918000, true)
        data.setUint32(5, 918000, true)
        serial.emit(...frame)
        break
      }
      default: {
        writes.push(command)
        if (command[0] === 12) serial.emit(1, 6)
        else serial.emit(0)
      }
    }
  })
  const session = sessionWith(port)
  t.after(() => session.disconnect())
  await session.connect()
  await assert.rejects(session.saveDevicePreferences(key, { name: 'Would write', txPower: 50 }), /must be between/)
  await assert.rejects(session.saveDevicePreferences(key, { name: 'Would write' }, { pin: '01' }), /six-digit BLE PIN/)
  assert.deepEqual(writes, [])
  const results = await session.saveDevicePreferences(key, {
    name: 'New Pigeon', position: { latitude: -34.25, longitude: 151.125 }, txPower: 16, pathWidth: 3,
    telemetry: { environment: 2 }, extraAcknowledgements: true,
  })
  assert.deepEqual(results.map(({ status }) => status), ['saved', 'saved', 'failed', 'saved', 'saved'])
  assert.deepEqual(writes.map(([code]) => code), [8, 14, 12, 61, 38])
  const position = Buffer.from(writes[1])
  assert.equal(position.readInt32LE(1), -34_250_000)
  assert.equal(position.readInt32LE(5), 151_125_000)
  assert.deepEqual(writes.at(-1), [38, 0x91, 33, 0, 1])
  const device = session.getSnapshot().device
  assert.equal(device.name, 'New Pigeon')
  assert.equal(device.preferences.txPowerDbm, 7)
  assert.equal(device.preferences.latitude, -34.25)
  assert.equal(device.capabilities.pathHashMode, 2)
  assert.deepEqual((await session.saveDevicePreferences(key, { repeat: true })).map(({ status }) => status), ['failed'])
  assert.ok(!writes.some(([code]) => code === 11))
})

test('reports an unconfirmed setting and stops writes after a disconnect', async (t) => {
  const key = 'ab'.repeat(32)
  const writes = []
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: {
        const device = selfInfo()
        device.set([7, 20], 2)
        serial.emit(...device)
        break
      }
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 8: writes.push(8); serial.emit(0); break
      case 12: writes.push(12); serial.dispatchEvent(new Event('disconnect')); break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  t.after(() => session.disconnect())
  await session.connect()
  const changes = await session.saveDevicePreferences(key, { name: 'Saved name', txPower: 15, pathWidth: 3 })
  assert.deepEqual(changes.map(({ status }) => status), ['saved', 'uncertain', 'skipped'])
  assert.deepEqual(writes, [8, 12])
})

test('reads local and remote telemetry and ignores pushes outside the selected request', async (t) => {
  const key = 'ab'.repeat(32)
  const contact = 'bc'.repeat(32)
  const data = [1, 116, 1, 132]
  const remoteData = [1, 116, 1, 122]
  const sent = response(6, 0, 1, 0, 0, 0, 0xf0, 0x49, 2, 0)
  const telemetry = (byte, lpp) => response(0x8b, 0, ...Array(6).fill(byte), ...lpp)
  let responseMode = 'normal'
  let collision = false
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: {
        serial.emit(2, collision ? 2 : 1, 0, 0, 0)
        const record = contactInfo()
        serial.emit(...record)
        if (collision) {
          record[7] = 0x91
          serial.emit(...record)
        }
        serial.emit(4, 0, 0, 0, 0)
        break
      }
      case 39: {
        if (command.length === 4) {
          assert.deepEqual(command, [39, 0, 0, 0])
          if (responseMode === 'unsupported') {
            serial.emit(1, 1)
          } else {
            serial.incoming.enqueue(Uint8Array.of(...telemetry(0xbc, remoteData), ...telemetry(0xab, data)))
          }
        } else {
          assert.deepEqual(command, [39, 0, 0, 0, ...Array(32).fill(0xbc)])
          const frames = [telemetry(0xbc, [1, 116, 0, 1]), sent, telemetry(0xab, data)]
          if (responseMode === 'normal') frames.push(telemetry(0xbc, remoteData))
          serial.incoming.enqueue(Uint8Array.of(...frames.flatMap((frame) => [...frame])))
        }
        break
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  t.after(() => session.disconnect())
  await session.connect()
  const signal = new AbortController().signal
  const pushed = []
  const stop = session.subscribeToPushes(({ code }) => pushed.push(code))
  t.after(stop)
  assert.deepEqual([...await session.readTelemetry(key, null, signal)], data)
  assert.deepEqual([...await session.readTelemetry(key, contact, signal)], remoteData)
  assert.equal(pushed.filter((code) => code === 0x8b).length, 5)

  responseMode = 'hold'
  const controller = new AbortController()
  const remote = session.readTelemetry(key, contact, controller.signal)
  await waitFor(() => port.commands.filter(([code]) => code === 39).length === 3)
  controller.abort(new Error('Stopped waiting'))
  await assert.rejects(remote, /Stopped waiting/)
  collision = true
  await assert.rejects(session.readTelemetry(key, contact, signal), /shares a telemetry reply prefix/)
  assert.equal(port.commands.filter(([code]) => code === 39).length, 3)
  responseMode = 'unsupported'
  await assert.rejects(session.readTelemetry(key, null, signal), /firmware does not support telemetry/)
  assert.equal(session.getSnapshot().phase, 'ready')
})

function scopeFixture(options = {}) {
  const factory = options.factory ?? new IDBFactory()
  const key = (options.key ?? 'ab').repeat(32)
  const events = []
  let scopeCommands = 0
  const port = new FixturePort(async (command, serial) => {
    events.push(['command', ...command])
    switch (command[0]) {
      case 22: {
        const info = deviceInfo(1)
        info[1] = options.version ?? 14
        serial.emit(...info)
        break
      }
      case 1: {
        const info = selfInfo()
        info.set(Buffer.from(key, 'hex'), 4)
        serial.emit(...info)
        break
      }
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 31: {
        const slot = new Uint8Array(48)
        slot.set(encode('Public'))
        slot.fill(1, 32)
        serial.emit(18, 0, ...slot)
        break
      }
      case 54:
        scopeCommands++
        if (options.onScope) await options.onScope(command, serial, scopeCommands)
        else serial.emit(0)
        break
      case 3:
        if (options.onSend) await options.onSend(command, serial)
        else serial.emit(0)
        break
      default: assert.fail(`Unexpected scope fixture command ${command[0]}`)
    }
  })
  const openScopeStorage = async () => {
    if (options.storageOpenFailure) throw new Error('Storage open unavailable')
    const storage = await openRadioStorage(factory)
    const wrapped = {
      ...storage,
      update: async (radio, update) => {
        await storage.update(radio, update)
        if (update.scopeRecovery !== undefined) events.push(['marker', update.scopeRecovery])
      },
    }
    return options.wrapStorage ? options.wrapStorage(wrapped) : wrapped
  }
  const session = sessionWith(port, options.timeoutMs ?? 1000, {
    locks: options.locks ?? fixtureLocks(),
    environment: { secureContext: true, serial: {
      requestPort: async () => options.selectPort?.() ?? port, getPorts: async () => [],
    } },
    openScopeStorage,
  })
  return {
    factory, key, session, port, events,
    send: (scope = { mode: 'region', name: '#North' }) => session.sendChannel(key, 0, 'Public', 'Pigeon', 123, 'Hello', scope),
    marker: async () => {
      const storage = await openRadioStorage(factory)
      try { return (await storage.read(radioKeyFromPublicKey(key)))?.scopeRecovery }
      finally { storage.close() }
    },
  }
}

test('scope commands use exact case-sensitive hashtag hashes and enforce firmware gates', async () => {
  const hash = (await import('node:crypto')).createHash('sha256').update('#North').digest().subarray(0, 16)
  assert.deepEqual([...await channelScopeCommand({ mode: 'region', name: 'North' })], [54, 0, ...hash])
  assert.notDeepEqual(await channelScopeCommand({ mode: 'region', name: '#north' }), Uint8Array.of(54, 0, ...hash))
  assert.deepEqual([...await channelScopeCommand({ mode: 'unscoped' })], [54, 1])
  assert.deepEqual([...await channelScopeCommand({ mode: 'default' })], [54, 0])
  for (const name of ['', '#', '   ', '#\0bad', '#\nname', '#\ud800']) {
    assert.throws(() => validateChannelScope({ mode: 'region', name }), /Region names/)
  }
  assert.throws(() => assertScopeSupported({ mode: 'region', name: '#North' }, 7), /v8/)
  assert.throws(() => assertScopeSupported({ mode: 'unscoped' }, 11), /v12/)
  assert.throws(() => assertScopeSupported({ mode: 'default' }, NaN), /protocol version/)
})

test('scope journaling commits before apply and excludes all other commands until reset', async () => {
  let sendEntered = false
  const fixture = scopeFixture({ onSend: (_command, port) => { sendEntered = true; fixture.respond = () => port.emit(0) } })
  await fixture.session.connect()
  const sent = fixture.send()
  await waitFor(() => sendEntered)
  assert.equal(await fixture.marker(), true)
  await assert.rejects(fixture.send(), /already in progress/)
  await assert.rejects(fixture.session.readChannelShareKey(fixture.key, 0, 'Public'), /already in progress/)
  await assert.rejects(fixture.session.sendDirect(fixture.key, 'bc'.repeat(32), 124, 0, 'Other'), /in progress/)
  assert.throws(() => fixture.session.reserveQueuedMessage(fixture.key), /finish before syncing/)
  fixture.respond()
  await sent
  const command = [...await channelScopeCommand({ mode: 'region', name: '#North' })]
  assert.deepEqual(fixture.events.filter((event) => event[0] === 'marker' || [54, 3].includes(event[1])), [
    ['marker', true], ['command', ...command],
    ['command', 3, 0, 0, 123, 0, 0, 0, ...encode('Hello')], ['command', 54, 0], ['marker', false],
  ])
  assert.equal(await fixture.marker(), false)
  await fixture.session.disconnect()
})

test('default, region and unscoped sends are firmware-gated and restore the radio default', async (t) => {
  for (const [version, scope, supported] of [
    [7, { mode: 'default' }, true], [7, { mode: 'region', name: '#North' }, false],
    [8, { mode: 'region', name: '#North' }, true], [11, { mode: 'unscoped' }, false],
    [12, { mode: 'unscoped' }, true], [14, { mode: 'default' }, true],
  ]) await t.test(`${version} ${scope.mode}`, async () => {
    const fixture = scopeFixture({ version })
    await fixture.session.connect()
    if (supported) await fixture.send(scope)
    else await assert.rejects(fixture.send(scope), /requires companion protocol/)
    assert.equal(fixture.port.commands.filter(([code]) => code === 3).length, supported ? 1 : 0)
    assert.equal(fixture.port.commands.filter(([code]) => code === 54).length, supported && version >= 8 ? 2 : 0)
    if (supported && version >= 8) assert.deepEqual(fixture.port.commands.at(-1), [54, 0])
    await fixture.session.disconnect()
  })
})

test('explicit apply/send rejection still resets and preserves the original error', async (t) => {
  for (const stage of ['apply', 'send']) await t.test(stage, async () => {
    const fixture = scopeFixture({
      onScope: (_command, port, count) => port.emit(...(stage === 'apply' && count === 1 ? [1, 2] : [0])),
      onSend: (_command, port) => port.emit(1, 2),
    })
    await fixture.session.connect()
    await assert.rejects(fixture.send(), { code: 'device-error' })
    assert.equal(await fixture.marker(), false)
    assert.equal(fixture.session.getSnapshot().phase, 'ready')
    assert.equal(fixture.port.commands.filter(([code]) => code === 3).length, stage === 'apply' ? 0 : 1)
    assert.deepEqual(fixture.port.commands.at(-1), [54, 0])
    await fixture.session.disconnect()
  })
})

test('disconnect at apply, send or reset leaves a durable marker recovered by a new session', async (t) => {
  for (const stage of ['apply', 'send', 'reset']) await t.test(stage, async () => {
    let waiting = false
    const fixture = scopeFixture({
      onScope: (_command, port, count) => {
        if ((stage === 'apply' && count === 1) || (stage === 'reset' && count === 2)) waiting = true
        else port.emit(0)
      },
      onSend: (_command, port) => { if (stage === 'send') waiting = true; else port.emit(0) },
    })
    await fixture.session.connect()
    const stopped = assert.rejects(fixture.send(), { code: 'scope-recovery' })
    await waitFor(() => waiting)
    await fixture.session.disconnect()
    await stopped
    assert.equal(await fixture.marker(), true)
    const reloaded = scopeFixture({ factory: fixture.factory })
    await reloaded.session.connect()
    assert.equal(reloaded.session.getSnapshot().phase, 'ready')
    assert.deepEqual(reloaded.port.commands.map(([code]) => code), [22, 1, 54, 4, 31])
    assert.equal(await reloaded.marker(), false)
    await reloaded.session.disconnect()
  })
})

test('storage failures and rejected or missing reset acknowledgements fail closed and can be retried', async (t) => {
  for (const failure of ['open', 'read', 'mark', 'clear', 'reset', 'reset-timeout', 'invalid-marker']) await t.test(failure, async () => {
    const fixture = scopeFixture({
      timeoutMs: 40,
      storageOpenFailure: failure === 'open',
      wrapStorage: (storage) => ({
        ...storage,
        read: async (radio) => {
          if (failure === 'read') throw new Error('Storage read unavailable')
          if (failure === 'invalid-marker') return { scopeRecovery: 'invalid' }
          return storage.read(radio)
        },
        update: async (radio, update) => {
          if ((failure === 'mark' && update.scopeRecovery === true) || (failure === 'clear' && update.scopeRecovery === false)) {
            throw new Error('Storage write unavailable')
          }
          return storage.update(radio, update)
        },
      }),
      onScope: (_command, port, count) => {
        if (count !== 2) port.emit(0)
        else if (failure === 'reset') port.emit(1, 2)
        else if (failure !== 'reset-timeout') port.emit(0)
      },
    })
    if (['open', 'read', 'invalid-marker'].includes(failure)) {
      const storage = await openRadioStorage(fixture.factory)
      await storage.update(radioKeyFromPublicKey(fixture.key), { scopeRecovery: true })
      storage.close()
    }
    await fixture.session.connect()
    if (!['open', 'read', 'invalid-marker'].includes(failure)) await assert.rejects(fixture.send(), { code: 'scope-recovery' })
    await waitFor(() => fixture.session.getSnapshot().phase === 'error')
    assert.equal(fixture.session.getSnapshot().error.code, 'scope-recovery')
    if (['clear', 'reset', 'reset-timeout'].includes(failure)) assert.equal(await fixture.marker(), true)
    if (['open', 'read', 'mark', 'invalid-marker'].includes(failure)) assert.equal(fixture.port.commands.some(([code]) => code === 3 || code === 54), false)
    await fixture.session.disconnect()
    const retry = scopeFixture({ factory: fixture.factory })
    await retry.session.connect()
    await retry.send()
    assert.equal(await retry.marker(), false)
    await retry.session.disconnect()
  })
})

test('pending recovery is isolated by radio and cannot proceed on unsupported firmware', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const radio = radioKeyFromPublicKey('ab'.repeat(32))
  await storage.update(radio, { scopeRecovery: true })
  const other = scopeFixture({ factory, key: 'cd' })
  await other.session.connect()
  assert.equal(other.port.commands.some(([code]) => code === 54), false)
  assert.equal((await storage.read(radio)).scopeRecovery, true)
  await other.session.disconnect()
  const old = scopeFixture({ factory, version: 7 })
  await old.session.connect()
  assert.equal(old.session.getSnapshot().error.code, 'scope-recovery')
  assert.deepEqual(old.port.commands.map(([code]) => code), [22, 1])
  assert.equal((await storage.read(radio)).scopeRecovery, true)
  await old.session.disconnect()
  const retry = scopeFixture({ factory })
  await retry.session.connect()
  assert.equal(await retry.marker(), false)
  await retry.session.disconnect()
  storage.close()
})

test('failed reconnect resets retain the marker and block sync and sends until repaired', async (t) => {
  for (const failure of ['reset', 'reset-timeout', 'clear']) await t.test(failure, async () => {
    const fixture = scopeFixture({
      timeoutMs: 40,
      onScope: (_command, port) => {
        if (failure === 'reset') port.emit(1, 2)
        else if (failure !== 'reset-timeout') port.emit(0)
      },
      wrapStorage: (storage) => ({
        ...storage,
        update: async (radio, update) => {
          if (failure === 'clear' && update.scopeRecovery === false) throw new Error('Storage write unavailable')
          return storage.update(radio, update)
        },
      }),
    })
    const storage = await openRadioStorage(fixture.factory)
    await storage.update(radioKeyFromPublicKey(fixture.key), { scopeRecovery: true })
    storage.close()
    await fixture.session.connect()
    await waitFor(() => fixture.session.getSnapshot().phase === 'error')
    assert.equal(fixture.session.getSnapshot().error.code, 'scope-recovery')
    assert.deepEqual(fixture.port.commands.map(([code]) => code), [22, 1, 54])
    assert.equal(await fixture.marker(), true)
    await assert.rejects(fixture.send(), /Connect the selected radio/)
    await fixture.session.disconnect()
    const retry = scopeFixture({ factory: fixture.factory })
    await retry.session.connect()
    assert.equal(await retry.marker(), false)
    await retry.session.disconnect()
  })
})

test('scope marker clears retain cross-tab ownership during disconnect and failure', async (t) => {
  for (const operation of ['send', 'recovery']) {
    for (const termination of ['disconnect', 'failure']) {
      for (const clearResult of ['commit', 'reject']) await t.test(`${operation}, ${termination}, ${clearResult}`, async () => {
        const factory = new IDBFactory()
        const locks = fixtureLocks()
        let releaseClear
        let notifyClear
        const clearGate = new Promise((resolve) => { releaseClear = resolve })
        const clearStarted = new Promise((resolve) => { notifyClear = resolve })
        let notifySend
        let releaseSend
        const sendStarted = new Promise((resolve) => { notifySend = resolve })
        const first = scopeFixture({
          factory, locks,
          wrapStorage: (storage) => ({
            ...storage,
            update: async (radio, update) => {
              if (update.scopeRecovery === false) {
                notifyClear()
                await clearGate
                if (clearResult === 'reject') throw new Error('Delayed marker clear failed')
              }
              return storage.update(radio, update)
            },
          }),
        })
        const second = scopeFixture({
          factory, locks,
          onSend: (_command, port) => { releaseSend = () => port.emit(0); notifySend() },
        })
        let firstWork
        let closing
        let secondSend
        try {
          if (operation === 'recovery') {
            const storage = await openRadioStorage(factory)
            await storage.update(radioKeyFromPublicKey(first.key), { scopeRecovery: true })
            storage.close()
            firstWork = first.session.connect()
          } else {
            await first.session.connect()
            firstWork = first.send().then(() => null, (error) => error)
          }
          await clearStarted
          assert.equal(await first.marker(), true)
          if (termination === 'disconnect') closing = first.session.disconnect()
          else first.port.dispatchEvent(new Event('disconnect'))
          await waitFor(() => first.port.closed)
          assert.equal(first.session.getSnapshot().phase, 'closing')
          if (termination === 'failure') assert.equal(first.session.getSnapshot().error?.code, 'scope-recovery')

          await second.session.connect()
          assert.equal(second.session.getSnapshot().error?.code, 'ownership')
          assert.equal(second.port.commands.length, 0)

          releaseClear()
          if (closing) await closing
          else await waitFor(() => first.session.getSnapshot().phase === 'error')
          const outcome = await firstWork
          if (operation === 'send') {
            if (clearResult === 'reject') assert.equal(outcome.code, 'scope-recovery')
            else assert.match(outcome.message, /disconnected/)
          }
          assert.equal(await first.marker(), clearResult === 'reject')

          await second.session.connect()
          assert.equal(second.session.getSnapshot().phase, 'ready')
          if (clearResult === 'reject') assert.deepEqual(second.port.commands.slice(0, 3).map(([code]) => code), [22, 1, 54])
          secondSend = second.send()
          await sendStarted
          assert.equal(await second.marker(), true)
          await setImmediate()
          assert.equal(await second.marker(), true)
          releaseSend()
          await secondSend
          assert.equal(await second.marker(), false)
        } finally {
          releaseClear()
          releaseSend?.()
          await Promise.allSettled([firstWork, closing, secondSend].filter(Boolean))
          await first.session.disconnect()
          await second.session.disconnect()
        }
      })
    }
  }
})

test('reconnect waits for old delayed marker writes before recovery or another scoped send', async (t) => {
  for (const delayedValue of [true, false]) await t.test(`delayed ${delayedValue}`, async () => {
    let waiting = false
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let selected
    const fixture = scopeFixture({
      selectPort: () => selected,
      wrapStorage: (storage) => ({
        ...storage,
        update: async (radio, update) => {
          if (!waiting && update.scopeRecovery === delayedValue) { waiting = true; await gate }
          return storage.update(radio, update)
        },
      }),
    })
    let stopped
    let closing
    try {
      await fixture.session.connect()
      stopped = assert.rejects(fixture.send(), delayedValue ? { code: 'scope-recovery' } : /disconnected/)
      await waitFor(() => waiting)
      closing = fixture.session.disconnect()
      await waitFor(() => fixture.port.closed)
      assert.equal(fixture.session.getSnapshot().phase, 'closing')
      const reconnect = scopeFixture({ factory: fixture.factory })
      selected = reconnect.port
      await fixture.session.connect()
      assert.equal(reconnect.port.commands.length, 0)
      release()
      await Promise.all([stopped, closing])
      await fixture.session.connect()
      assert.equal(fixture.session.getSnapshot().phase, 'ready')
      assert.equal(await fixture.marker(), false)
      await fixture.send()
      assert.equal(await fixture.marker(), false)
    } finally {
      release()
      await Promise.allSettled([stopped, closing].filter(Boolean))
      await fixture.session.disconnect()
    }
  })
})

test('channel management rechecks slots, preserves keys on rename, and refuses full or stale slots', async () => {
  const slots = [new Uint8Array(48), new Uint8Array(48)]
  slots[0].set(encode('Public'))
  const publicSecret = Uint8Array.from(Buffer.from('8b3387e9c5cdea6ac9e5edbaa115cd72', 'hex'))
  slots[0].set(publicSecret, 32)
  let rejectWrite = false
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo(2)); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 31: serial.emit(18, command[1], ...slots[command[1]]); break
      case 32:
        if (rejectWrite) serial.emit(1, 5)
        else { slots[command[1]].set(command.slice(2)); serial.emit(0) }
        break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  await session.connect()
  const hold = session.reserveQueuedMessage(key)
  await assert.rejects(session.createChannel(key, { kind: 'public', name: 'Other', secret: '' }), /Finish message sync/)
  hold.release()
  await assert.rejects(session.createChannel(key, { kind: 'public', name: 'Other', secret: '' }), /key already exists/)
  assert.equal(port.commands.at(-1)[0], 31)
  assert.equal(await session.readChannelShareKey(key, 0, 'Public'), Buffer.from(publicSecret).toString('hex'))
  assert.equal('secret' in session.getSnapshot().channels[0], false)
  await assert.rejects(session.readChannelShareKey(key, 0, 'Wrong name'), /changed on the radio/)
  await session.createChannel(key, { kind: 'hashtag', name: '#test', secret: '' })
  assert.deepEqual(session.getSnapshot().channels.map(({ name }) => name), ['Public', '#test'])
  assert.equal(Buffer.from(slots[1].slice(32)).toString('hex'), '9cd8fcf22a47333b591d96a2b848b73f')
  await assert.rejects(session.createChannel(key, { kind: 'join', name: 'Other', secret: '23'.repeat(16) }), /No empty channel slot/)
  await assert.rejects(session.changeChannel(key, 1, '#test', '#other'), /cannot be renamed/)
  await session.changeChannel(key, 0, 'Public', 'General', async () => {
    assert.equal(new TextDecoder().decode(slots[0].slice(0, 7)), 'General')
    assert.equal(session.getSnapshot().channels[0].name, 'Public')
  })
  assert.deepEqual([...slots[0].slice(32)], [...publicSecret])
  await assert.rejects(session.changeChannel(key, 0, 'Public', null), /changed on the radio/)
  await assert.rejects(session.changeChannel(key, 0, 'General', 'Updated', async () => {
    throw new Error('Storage unavailable')
  }), /Storage unavailable/)
  assert.equal(session.getSnapshot().channels[0].name, 'Updated')
  rejectWrite = true
  await assert.rejects(session.changeChannel(key, 0, 'Updated', null), /device error 5/)
  assert.equal(session.getSnapshot().channels[0].name, 'Updated')
  rejectWrite = false
  await session.changeChannel(key, 1, '#test', null)
  assert.ok(slots[1].every((byte) => byte === 0))
  const privateSecret = '12'.repeat(16)
  await session.createChannel(key, { kind: 'join', name: 'Private', secret: privateSecret })
  await assert.rejects(session.createChannel(key, { kind: 'join', name: 'Other private', secret: privateSecret }), /key already exists/)
  assert.equal(port.commands.at(-1)[0], 31)
  await session.disconnect()
})

test('applies the setup preset and hash width to the chosen radio, preserving repeat mode', async () => {
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 11: serial.emit(0); break
      case 61: serial.emit(command[2] === 0 ? 1 : 0); break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const key = 'ab'.repeat(32)
  const session = sessionWith(port)
  await session.connect()
  const settings = { frequencyMHz: 910.525, bandwidthKHz: 62.5, spreadingFactor: 7, codingRate: 5 }
  await assert.rejects(session.setSetupRadioSettings('12'.repeat(32), settings), /Connect the selected radio/)
  await session.setSetupRadioSettings(key, settings)
  const command = Uint8Array.from(port.commands.at(-1))
  const data = new DataView(command.buffer)
  assert.equal(data.getUint32(1, true), 910525)
  assert.equal(data.getUint32(5, true), 62500)
  assert.deepEqual([...command.slice(9)], [7, 5, 1])
  assert.deepEqual(session.getSnapshot().device.radioParameters, settings)
  await session.setSetupPathWidth(key, 2)
  assert.deepEqual(port.commands.at(-1), [61, 0, 1])
  await assert.rejects(session.setSetupPathWidth(key, 1), /rejected the command/)
  assert.equal(session.getSnapshot().device.capabilities.pathHashMode, 1)
  await session.disconnect()
})

test('edits saved routes and permissions with a fresh contact record, preserving other radio fields', async () => {
  const contact = contactInfo()
  contact[34] = 0xe1
  const original = contact.slice()
  const record = new DataView(contact.buffer)
  const oldTimestamp = record.getUint32(144, true)
  const oldSyncCursor = oldTimestamp + 3
  let clock = oldSyncCursor
  let clockReads = 0
  let freezeClock = false
  function handleCommand(command, serial) {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: {
        const since = command.length === 5 ? new DataView(Uint8Array.from(command).buffer).getUint32(1, true) : 0
        serial.emit(2, 1, 0, 0, 0)
        if (record.getUint32(144, true) > since) serial.emit(...contact)
        serial.emit(4, 0, 0, 0, 0)
        break
      }
      case 30: assert.deepEqual(command.slice(1), Array(32).fill(0xbc)); serial.emit(...contact); break
      case 5: {
        clockReads++
        if (!freezeClock && clockReads % 4 === 0) clock++
        const time = Uint8Array.of(9, 0, 0, 0, 0)
        new DataView(time.buffer).setUint32(1, clock, true)
        serial.emit(...time)
        break
      }
      case 9:
        assert.equal(command.length, 144)
        assert.equal(clockReads % 4, 0)
        assert.ok(clockReads > 0, 'the edit waited for an actual radio clock tick')
        contact.set(command.slice(1), 1)
        record.setUint32(144, clock, true)
        serial.emit(0)
        break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  }
  const port = new FixturePort(handleCommand)
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  const session = sessionWith(port)
  await session.connect()
  await session.saveContactPath(key, target, 2, '0102 aabb')
  assert.equal(contact[35], 0x42)
  assert.deepEqual([...contact.slice(36, 42)], [1, 2, 0xaa, 0xbb, 0, 0])
  assert.deepEqual(contact.slice(0, 35), original.slice(0, 35))
  assert.deepEqual(contact.slice(100, 144), original.slice(100, 144))
  assert.equal(session.getSnapshot().contacts[0].lastModifiedAt, oldSyncCursor + 1)
  await session.saveContactPermissions(key, target, { telemetry: true, location: false, remoteCli: true })
  assert.equal(contact[34], 0xf3)
  assert.equal(session.getSnapshot().contacts[0].flags, 0xf3)
  assert.equal(session.getSnapshot().contacts[0].pathLength, 0x42)
  assert.equal(session.getSnapshot().contacts[0].lastModifiedAt, oldSyncCursor + 2)
  await session.resetContactPath(key, target)
  assert.equal(session.getSnapshot().contacts[0].pathLength, 0xff)
  assert.equal(contact[34], 0xf3)
  assert.equal(session.getSnapshot().contacts[0].lastModifiedAt, oldSyncCursor + 3)
  assert.deepEqual(port.commands.slice(3).map(([code]) => code).filter((code) => code !== 5),
    [30, 9, 30, 30, 9, 30, 30, 9, 30])
  freezeClock = true
  await assert.rejects(session.saveContactPath(key, target, 1, 'ab'), /clock did not advance/)
  assert.equal(port.commands.filter(([code]) => code === 9).length, 3)
  assert.equal(session.getSnapshot().contacts[0].lastModifiedAt, oldSyncCursor + 3)
  await session.disconnect()

  const secondClient = new SerialLink(new FixturePort(handleCommand), 1000, () => {}, assert.fail)
  const incremental = Uint8Array.of(4, 0, 0, 0, 0)
  new DataView(incremental.buffer).setUint32(1, oldSyncCursor, true)
  const unseen = []
  try {
    await secondClient.request(incremental, (frame) => {
      if (frame[0] === 4) return { value: undefined }
      if (frame[0] === 3) unseen.push(frame)
    })
    assert.deepEqual(unseen, [contact])
  } finally {
    await secondClient.close()
  }
})

test('refuses ambiguous pings, correlates the trace response and cancels without a retry', async () => {
  const first = contactInfo()
  first[33] = 2
  const second = first.slice()
  second[2] = 0x09
  let answerPing = true
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 2, 0, 0, 0); serial.emit(...first); serial.emit(...second); serial.emit(4, 0, 0, 0, 0); break
      case 36: {
        const prefix = command.slice(10)
        assert.deepEqual(prefix, [0xbc, 0xbc])
        const tag = command.slice(1, 5)
        if (answerPing) {
          serial.emit(0x89, 0, 2, 1, ...tag, 0, 0, 0, 0, prefix[0], 0x00, 99, 99)
          serial.emit(0x89, 0, 2, 1, ...tag, 0, 0, 0, 0, ...prefix, 0xfa, 28)
        }
        serial.emit(6, 0, ...tag, 100, 0, 0, 0)
        break
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  const target = 'bc'.repeat(32)
  await session.connect()
  await assert.rejects(session.pingContact(key, target, 1, new AbortController().signal), /more than one known radio/)
  assert.equal(port.commands.filter(([code]) => code === 36).length, 0)
  const reply = await session.pingContact(key, target, 2, new AbortController().signal)
  assert.equal(reply.outboundSnrDb, -1.5)
  assert.equal(reply.returnSnrDb, 7)
  answerPing = false
  const controller = new AbortController()
  const waiting = session.pingContact(key, target, 2, controller.signal)
  await waitFor(() => port.commands.filter(([code]) => code === 36).length === 2)
  controller.abort(new Error('Stopped waiting for the ping.'))
  await assert.rejects(waiting, /Stopped waiting/)
  assert.equal(port.commands.filter(([code]) => code === 36).length, 2)
  await session.disconnect()
})

test('a delayed channel rename cannot publish into a different radio session', async () => {
  function channelPort(key, name) {
    const slot = new Uint8Array(48)
    slot.set(encode(name))
    slot.fill(1, 32)
    return new FixturePort((command, serial) => {
      switch (command[0]) {
        case 22: serial.emit(...deviceInfo(1)); break
        case 1: {
          const info = selfInfo()
          info.fill(key, 4, 36)
          serial.emit(...info)
          break
        }
        case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
        case 31: serial.emit(18, command[1], ...slot); break
        case 32: slot.set(command.slice(2)); serial.emit(0); break
        default: assert.fail(`Unexpected command ${command[0]}`)
      }
    })
  }
  const ports = [channelPort(0xab, 'Public'), channelPort(0xcd, 'Other')]
  const session = new CompanionSession({
    environment: { secureContext: true, serial: { requestPort: async () => ports.shift(), getPorts: async () => [] } },
    timeoutMs: 1000, locks: fixtureLocks(),
  })
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const secondKey = radioKeyFromPublicKey('cd'.repeat(32))
  await storage.update(secondKey, {
    channels: [{ index: 0, name: 'Other' }],
    channelRetention: { index: 0, channelName: 'Other', days: 30 },
  })
  const cache = new SessionCache(session, () => openRadioStorage(factory))
  await session.connect()
  let release
  let entered
  const blocked = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const rename = assert.rejects(session.changeChannel('ab'.repeat(32), 0, 'Public', 'Renamed', async () => {
    entered()
    await blocked
  }), /radio disconnected/)
  await started
  await session.disconnect()
  await session.connect()
  await waitFor(() => cache.getSnapshot().pending === 0 && !cache.getSnapshot().saving)
  release()
  await rename
  await waitFor(() => cache.getSnapshot().pending === 0 && !cache.getSnapshot().saving)
  assert.equal(session.getSnapshot().device.publicKey, secondKey)
  assert.deepEqual(session.getSnapshot().channels, [{ index: 0, name: 'Other' }])
  const data = await storage.read(secondKey)
  assert.deepEqual(data.channels, [{ index: 0, name: 'Other' }])
  assert.deepEqual(data.channelRetention, [{ index: 0, channelName: 'Other', days: 30 }])
  await session.disconnect()
  storage.close()
})

test('channel observation refuses duplicate slot keys before returning a transient key', async () => {
  const slots = ['Public', 'Other'].map((name) => {
    const slot = new Uint8Array(48)
    slot.set(encode(name))
    slot.fill(1, 32)
    return slot
  })
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo(2)); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 31: serial.emit(18, command[1], ...slots[command[1]]); break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  await session.connect()
  await assert.rejects(session.readChannelObservationKey('ab'.repeat(32), 0, 'Public'), /same key/)
  slots[1].fill(2, 32)
  const key = await session.readChannelObservationKey('ab'.repeat(32), 0, 'Public')
  assert.deepEqual([...key], Array(16).fill(1))
  key.fill(0)
  await assert.rejects(session.readChannelObservationKey('ab'.repeat(32), 0, 'Wrong'), /channel changed/)
  assert(port.commands.every(([command]) => [22, 1, 4, 31].includes(command)))
  await session.disconnect()
})

test('channel sending rechecks the radio slot and treats OK as acceptance, not delivery', async () => {
  const slot = new Uint8Array(48)
  slot.set(encode('Public'))
  slot.fill(1, 32)
  let reject = false
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo(1)); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 31: serial.emit(18, command[1], ...slot); break
      case 3: serial.emit(...(reject ? [1, 2] : [0])); break
      case 54: serial.emit(0); break
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const session = sessionWith(port)
  const key = 'ab'.repeat(32)
  await session.connect()
  await session.sendChannel(key, 0, 'Public', 'Pigeon', 0x12345678, 'Hello')
  assert.deepEqual(port.commands.at(-2), [3, 0, 0, 0x78, 0x56, 0x34, 0x12, ...encode('Hello')])
  assert.deepEqual(port.commands.at(-1), [54, 0])
  await assert.rejects(session.sendChannel(key, 0, 'Wrong', 'Pigeon', 1, 'Hello'), /channel changed/)
  assert.equal(port.commands.at(-1)[0], 31)
  await assert.rejects(session.sendChannel(key, 0, 'Public', 'Wrong', 1, 'Hello'), /sender name changed/)
  assert.equal(port.commands.at(-1)[0], 31)
  reject = true
  await assert.rejects(session.sendChannel(key, 0, 'Public', 'Pigeon', 1, 'Hello'), /radio rejected.*device error 2/)
  assert.equal(session.getSnapshot().phase, 'ready')
  await session.disconnect()
})

test('USB framing tolerates split headers, noise and multiple packets per read', () => {
  const decoder = new SerialFrameDecoder()
  assert.deepEqual([...decoder.read(Uint8Array.of(0, 0x3e, 0, 0, 0x3e, 177, 0, 0x3e))], [])
  assert.deepEqual([...decoder.read(Uint8Array.of(2, 0, 7))], [])
  const frames = [...decoder.read(Uint8Array.of(0x3e, ...response(10)))]
  assert.deepEqual(frames.map((frame) => [...frame]), [[7, 0x3e], [10]])
})

test('reports support, chooser cancellation and permission failure distinctly', async () => {
  assert.equal(getWebSerialSupport({ secureContext: false }).error.code, 'insecure-context')
  assert.equal(getWebSerialSupport({ secureContext: true }).error.code, 'unsupported-browser')
  const make = (name) => new CompanionSession({
    environment: {
      secureContext: true,
      serial: { requestPort: async () => { throw new DOMException('fixture', name) } },
    },
  })
  const cancelled = make('NotFoundError')
  await cancelled.connect()
  assert.equal(cancelled.getSnapshot().phase, 'idle')
  assert.equal(cancelled.getSnapshot().error, null)
  const denied = make('SecurityError')
  await denied.connect()
  assert.equal(denied.getSnapshot().phase, 'error')
  assert.equal(denied.getSnapshot().error.code, 'chooser-failed')
})

test('writes contacts only to the selected ready radio and keeps rejected writes recoverable', async () => {
  let addReply = [1, 3]
  let contactDiscovered = false
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, Number(contactDiscovered), 0, 0, 0)
        if (contactDiscovered) serial.emit(...contactInfo())
        serial.emit(4, 0, 0, 0, 0)
        break
      case 9: serial.emit(...addReply); break
      case 15: serial.emit(0); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
  const session = sessionWith(port)
  const radioKey = 'ab'.repeat(32)
  const contact = { publicKey: 'cb'.repeat(32), name: 'Relay 📡', type: 2 }
  await session.connect()
  await assert.rejects(session.addContact('cc'.repeat(32), contact), /Connect the selected radio/)
  await assert.rejects(session.addContact(radioKey, { ...contact, name: '📡'.repeat(8) }), /31 UTF-8/)
  assert.deepEqual(port.commands.map(([code]) => code), [22, 1, 4])

  await assert.rejects(session.addContact(radioKey, contact), /storage is full/)
  assert.equal(session.getSnapshot().phase, 'ready')
  assert.deepEqual(session.getSnapshot().contacts, [])
  addReply = [0]
  await session.addContact(radioKey, contact)
  await assert.rejects(session.addContact(radioKey, contact), /already exists/)
  const add = port.commands.at(-1)
  assert.equal(add.length, 144)
  assert.deepEqual(add.slice(33, 36), [2, 0, 0xff])
  assert.deepEqual(add.slice(100, 100 + encode(contact.name).length), [...encode(contact.name)])
  assert.deepEqual(session.getSnapshot().contacts.map(({ publicKey }) => publicKey), [contact.publicKey])

  await session.removeContact(radioKey, contact.publicKey)
  assert.deepEqual(port.commands.at(-1), [15, ...Array(32).fill(0xcb)])
  assert.deepEqual(session.getSnapshot().contacts, [])
  contactDiscovered = true
  await assert.rejects(session.addContact(radioKey, { ...contact, publicKey: 'bc'.repeat(32) }), /already exists/)
  assert.equal(port.commands.at(-1)[0], 4)
  assert.equal(session.getSnapshot().contacts[0].publicKey, 'bc'.repeat(32))
  await session.disconnect()
  await assert.rejects(session.removeContact(radioKey, contact.publicKey), /Connect the selected radio/)
})

test('contact writes and queued message requests do not interrupt one another', async () => {
  let contactReads = 0
  let finishContactRead
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 0, 0, 0, 0)
        if (++contactReads === 1) serial.emit(4, 0, 0, 0, 0)
        else finishContactRead = () => serial.emit(4, 0, 0, 0, 0)
        break
      case 9:
      case 15: serial.emit(0); break
      case 10: serial.emit(10); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })

  const session = sessionWith(port)
  const radioKey = 'ab'.repeat(32)
  const contact = { publicKey: 'cb'.repeat(32), name: 'Relay', type: 2 }
  const sync = new MessageSync(session, () => openRadioStorage(new IDBFactory()))
  await session.connect()
  const adding = session.addContact(radioKey, contact)
  await waitFor(() => typeof finishContactRead === 'function')
  await sync.sync()
  assert.match(sync.getSnapshot().error, /contact change/)
  assert.equal(port.commands.some(([code]) => code === 10), false)
  finishContactRead()
  await adding
  assert.equal(session.getSnapshot().contacts[0].publicKey, contact.publicKey)

  const lease = session.reserveQueuedMessage(radioKey)
  try {
    await assert.rejects(session.removeContact(radioKey, contact.publicKey), /message sync/)
    assert.equal(port.commands.some(([code]) => code === 15), false)
    assert.equal(await lease.request(() => assert.fail('Queue should be empty')), false)
  } finally {
    lease.release()
  }
  await session.removeContact(radioKey, contact.publicKey)
  assert.deepEqual(session.getSnapshot().contacts, [])
  await sync.sync()
  assert.equal(sync.getSnapshot().error, null)
  await session.disconnect()
})

test('direct commands refresh and validate recipients without interrupting receipt ownership', async () => {
  let duplicate = false
  let finishSend
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: {
        serial.emit(2, duplicate ? 2 : 1, 0, 0, 0)
        serial.emit(...contactInfo())
        if (duplicate) {
          const other = contactInfo()
          other[7] = 0xcc
          serial.emit(...other)
        }
        serial.emit(4, 0, 0, 0, 0)
        break
      }
      case 2:
        finishSend = () => serial.emit(6, 0, 1, 2, 3, 4, 0xe8, 3, 0, 0)
        break
      case 13: serial.emit(0); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
  const session = sessionWith(port)
  const radioKey = 'ab'.repeat(32)
  const contactKey = 'bc'.repeat(32)
  await session.connect()
  const lease = session.reserveQueuedMessage(radioKey)
  await assert.rejects(session.sendDirect(radioKey, contactKey, 123, 0, 'Hello'), /pending receipt/)
  lease.release()

  duplicate = true
  await assert.rejects(session.sendDirect(radioKey, contactKey, 123, 0, 'Hello'), /ambiguous/)
  assert.equal(port.commands.some(([code]) => code === 2), false)
  duplicate = false
  const sending = session.sendDirect(radioKey, contactKey, 123, 0, 'Hello')
  await waitFor(() => typeof finishSend === 'function')
  assert.throws(() => session.reserveQueuedMessage(radioKey), /direct-message command/)
  await assert.rejects(session.removeContact(radioKey, contactKey), /direct-message command/)
  finishSend()
  assert.deepEqual(await sending, { route: 'direct', expectedAck: '01020304', timeoutMs: 1000 })
  assert.deepEqual(port.commands.at(-1), [2, 0, 0, 123, 0, 0, 0, ...Array(6).fill(0xbc), ...encode('Hello')])

  await session.resetDirectPath(radioKey, contactKey)
  assert.deepEqual(port.commands.at(-1), [13, ...Array(32).fill(0xbc)])
  await session.disconnect()
})

test('cancellation during the contact refresh prevents a send or route reset', async () => {
  let reads = 0
  let finishRead
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contactInfo())
        if (++reads === 1) serial.emit(4, 0, 0, 0, 0)
        else finishRead = () => serial.emit(4, 0, 0, 0, 0)
        break
      default: assert.fail(`Cancelled command ${code} reached the radio`)
    }
  })
  const session = sessionWith(port)
  await session.connect()
  for (const action of ['send', 'reset']) {
    finishRead = undefined
    const controller = new AbortController()
    const promise = action === 'send'
      ? session.sendDirect('ab'.repeat(32), 'bc'.repeat(32), 123, 0, 'Hello', controller.signal)
      : session.resetDirectPath('ab'.repeat(32), 'bc'.repeat(32), controller.signal)
    await waitFor(() => typeof finishRead === 'function')
    controller.abort()
    finishRead()
    await assert.rejects(promise, /cancelled before transmission/)
  }
  assert.equal(port.commands.some(([code]) => code === 2 || code === 13), false)
  await session.disconnect()
})

test('a mocked USB send persists and delivers an acknowledgement arriving before the send response', async () => {
  const radioKey = 'ab'.repeat(32)
  const contactKey = 'bc'.repeat(32)
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contactInfo())
        serial.emit(4, 0, 0, 0, 0)
        break
      case 2: {
        const timestamp = new DataView(Uint8Array.from(command).buffer).getUint32(3, true)
        const text = new TextDecoder().decode(Uint8Array.from(command.slice(13)))
        return expectedDirectAck(radioKey, timestamp, command[2], text).then((code) => {
          const bytes = [...Buffer.from(code, 'hex')]
          serial.emit(0x82, ...bytes, 12, 0, 0, 0)
          serial.emit(6, 0, ...bytes, 0xe8, 3, 0, 0)
        })
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const factory = new IDBFactory()
  const open = () => openRadioStorage(factory)
  const session = sessionWith(port)
  new SessionCache(session, open)
  const direct = new DirectMessages(session, open, () => 10)
  await session.connect()
  await direct.load(radioKey)
  const key = radioKeyFromPublicKey(radioKey)
  const text = 'é'.repeat(79)
  assert.equal(await direct.send(key, contactKey, text, { directAttempts: 1, floodAttempts: 0 }), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  const storage = await open()
  const data = await storage.read(key)
  assert.equal(data.messages[0].outgoing.status, 'delivered')
  assert.equal(data.messages[0].outgoing.roundTripMs, 12)
  assert.deepEqual(data.drafts, [])
  const sends = port.commands.filter(([code]) => code === 2)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].length, 171)
  assert.equal(new TextDecoder().decode(Uint8Array.from(sends[0].slice(13))), text)
  assert.equal(port.commands.some(([code]) => code === 10), false)
  storage.close()
  await session.disconnect()
})

test('a late ACK during the next contact refresh prevents a duplicate transmission', async () => {
  const radioKey = 'ab'.repeat(32)
  let reads = 0
  let finishRead
  let ackCode
  const port = new FixturePort((command, serial) => {
    switch (command[0]) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 1, 0, 0, 0)
        serial.emit(...contactInfo())
        if (++reads === 3) finishRead = () => serial.emit(4, 0, 0, 0, 0)
        else serial.emit(4, 0, 0, 0, 0)
        break
      case 2: {
        const timestamp = new DataView(Uint8Array.from(command).buffer).getUint32(3, true)
        const text = new TextDecoder().decode(Uint8Array.from(command.slice(13)))
        return expectedDirectAck(radioKey, timestamp, command[2], text).then((code) => {
          ackCode = [...Buffer.from(code, 'hex')]
          serial.emit(6, 0, ...ackCode, 1, 0, 0, 0)
        })
      }
      default: assert.fail(`Unexpected command ${command[0]}`)
    }
  })
  const factory = new IDBFactory()
  const open = () => openRadioStorage(factory)
  const session = sessionWith(port)
  const direct = new DirectMessages(session, open, () => 5)
  await session.connect()
  await direct.load(radioKey)
  await direct.send(radioKeyFromPublicKey(radioKey), 'bc'.repeat(32), 'Only once', { directAttempts: 2, floodAttempts: 0 })
  await waitFor(() => typeof finishRead === 'function')
  port.emit(0x82, ...ackCode, 12, 0, 0, 0)
  await waitFor(() => direct.getSnapshot().data?.messages[0]?.outgoing?.status === 'delivered')
  finishRead()
  await waitFor(() => direct.getSnapshot().activeId === null)
  assert.equal(port.commands.filter(([code]) => code === 2).length, 1)
  await session.disconnect()
})

test('handshakes and syncs advertised slots without dequeuing messages', async () => {
  const pendingMessages = [
    [16, 0xf6, 0, 0, 1, 2, 3, 4, 5, 6, 0xff, 2, 42, 0, 0, 0, 7, 8, 9, 10, ...encode('hello')],
    [8, 2, 1, 0, 43, 0, 0, 0, ...encode('group')],
    [27, 8, 0, 0, 2, 1, 0x34, 0x12, 2, 0xde, 0xad],
  ]
  const port = new FixturePort(([code, arg], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo(3)); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.incoming.enqueue(Uint8Array.of(
          ...response(2, 1, 0, 0, 0),
          ...response(0x81, 9),
          ...response(0x83),
          ...response(...contactInfo()),
          ...response(4, 200, 1, 0, 0),
        ))
        break
      case 31:
        if (arg === 1) serial.emit(1, 2)
        else {
          const name = new Uint8Array(32)
          name.set(encode(arg === 0 ? 'Public' : 'Other'))
          serial.emit(18, arg, ...name, ...new Uint8Array(16).fill(0xff))
        }
        break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })

  const session = sessionWith(port)
  const pushes = []
  const progress = []
  const unpush = session.subscribeToPushes((push) => pushes.push([push.code, ...push.payload]))
  const unsubscribe = session.subscribe(() => {
    if (session.getSnapshot().progress) progress.push(session.getSnapshot().progress)
  })
  await session.connect()
  const snapshot = session.getSnapshot()
  assert.equal(snapshot.phase, 'ready')
  assert.equal(snapshot.device.publicKey, 'ab'.repeat(32))
  assert.equal(snapshot.device.name, 'Pigeon')
  assert.deepEqual(snapshot.device.capabilities, {
    firmwareProtocolVersion: 14, maxContacts: 200, maxChannels: 3, firmwareBuildDate: '20 Nov 2026',
    manufacturer: 'Test Companion', firmwareVersion: '1.14.0', repeatEnabled: true, pathHashMode: 2,
  })
  assert.equal(snapshot.contacts[0].publicKey, 'bc'.repeat(32))
  assert.equal(snapshot.contacts[0].lastModifiedAt, 456)
  assert.equal(snapshot.contacts[0].latitude, -123)
  assert.deepEqual(snapshot.channels, [{ index: 0, name: 'Public' }, { index: 2, name: 'Other' }])
  assert.deepEqual(snapshot.messages, [])
  assert.deepEqual(pushes, [[0x81, 9], [0x83]])
  assert.ok(progress.some(({ stage, completed, total }) => stage === 'contacts' && completed === 1 && total === 1))
  assert.ok(progress.some(({ stage, completed, total }) => stage === 'channels' && completed === 3 && total === 3))
  assert.deepEqual(port.commands, [
    [22, 3], [1, ...new Uint8Array(7), ...encode('Packet Pigeon')], [4], [31, 0], [31, 1], [31, 2],
  ])

  port.incoming.enqueue(Uint8Array.of(...response(0x83), ...response(0x83)))
  await setImmediate()
  assert.equal(pendingMessages.length, 3)
  assert.deepEqual(session.getSnapshot().messages, [])
  assert.equal(port.commands.some(([code]) => code === 10), false)
  assert.equal(session.getSnapshot().progress, null)
  assert.deepEqual(pushes, [[0x81, 9], [0x83], [0x83], [0x83]])
  unpush()
  unsubscribe()
  await session.disconnect()
  assert.equal(port.closed, true)
  assert.equal(session.getSnapshot().phase, 'idle')
})

test('only manually requests queued messages from the selected ready radio', async () => {
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 10: serial.emit(0x55, 1, 2); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
  const session = sessionWith(port)
  await session.connect()
  assert.throws(() => session.reserveQueuedMessage('cd'.repeat(32)), { code: 'disconnected' })
  assert.equal(port.commands.some(([code]) => code === 10), false)
  const lease = session.reserveQueuedMessage('ab'.repeat(32))
  let received
  try {
    assert.throws(() => session.reserveQueuedMessage('ab'.repeat(32)), /Save the previous/)
    assert.equal(await lease.request((frame) => { received = frame }), true)
    assert.deepEqual([...received], [0x55, 1, 2])
    assert.throws(() => session.reserveQueuedMessage('ab'.repeat(32)), /Save the previous/)
  } finally {
    lease.release()
  }
  await session.disconnect()
  assert.throws(() => session.reserveQueuedMessage('ab'.repeat(32)), { code: 'disconnected' })
})

test('an unsaved receipt keeps USB ownership across disconnect until it is saved', async () => {
  const locks = fixtureLocks()
  const factory = new IDBFactory()
  const receipt = [7, 1, 2, 3, 4, 5, 6, 0, 0, 42, 0, 0, 0, ...encode('hello')]
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 10: serial.emit(...receipt); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
  const otherPort = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
      case 10: serial.emit(10); break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
  const session = sessionWith(port, 1000, { locks })
  const other = sessionWith(otherPort, 1000, { locks })
  let fail = true
  const sync = new MessageSync(session, async () => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      update: async (key, update) => {
        if (fail) { fail = false; throw new Error('Disk unavailable') }
        await storage.update(key, update)
      },
    }
  })
  const otherSync = new MessageSync(other, () => openRadioStorage(factory))
  let disconnection
  try {
    await session.connect()
    await sync.sync()
    assert.equal(sync.getSnapshot().pending, true)
    disconnection = session.disconnect()
    await waitFor(() => port.closed)
    await other.connect()
    await otherSync.sync()
    assert.equal(otherPort.commands.some(([code]) => code === 10), false)
    assert.equal(other.getSnapshot().error?.code, 'ownership')

    await sync.sync()
    await disconnection
    assert.equal(sync.getSnapshot().pending, false)
    const storage = await openRadioStorage(factory)
    const data = await storage.read(radioKeyFromPublicKey('ab'.repeat(32)))
    storage.close()
    assert.equal(data.messages[0].text, 'hello')

    await other.connect()
    await otherSync.sync()
    assert.equal(otherPort.commands.filter(([code]) => code === 10).length, 1)
  } finally {
    if (sync.getSnapshot().pending) await sync.sync()
    if (disconnection) await disconnection
    await session.disconnect()
    await other.disconnect()
  }
})

test('saves a complete queue response received before a delayed write fails', async (t) => {
  for (const failure of ['disconnect', 'write']) {
    await t.test(failure, async () => {
      const factory = new IDBFactory()
      let settleWrite
      let rejectWrite
      const receipt = [7, 1, 2, 3, 4, 5, 6, 0, 0, 42, 0, 0, 0, ...encode('hello')]
      const port = new FixturePort(([code], serial) => {
        switch (code) {
          case 22: serial.emit(...deviceInfo()); break
          case 1: serial.emit(...selfInfo()); break
          case 4: serial.emit(2, 0, 0, 0, 0); serial.emit(4, 0, 0, 0, 0); break
          case 10:
            serial.emit(...receipt)
            return new Promise((resolve, reject) => { settleWrite = resolve; rejectWrite = reject })
          default: assert.fail(`Unexpected command ${code}`)
        }
      })
      const session = sessionWith(port, 1000, { retryDelays: [] })
      const sync = new MessageSync(session, () => openRadioStorage(factory))
      try {
        await session.connect()
        const syncing = sync.sync()
        await waitFor(() => typeof settleWrite === 'function')
        await setImmediate()
        const capturedBeforeFailure = sync.getSnapshot().pending
        if (failure === 'disconnect') port.dispatchEvent(new Event('disconnect'))
        else rejectWrite(new Error('Write failed'))
        await syncing
        const storage = await openRadioStorage(factory)
        const data = await storage.read(radioKeyFromPublicKey('ab'.repeat(32)))
        storage.close()
        assert.equal(capturedBeforeFailure, true)
        assert.equal(data.messages.length, 1)
        assert.equal(data.messages[0].text, 'hello')
        assert.match(sync.getSnapshot().error, failure === 'disconnect' ? /disconnected/ : /write/)
        assert.equal(port.commands.filter(([code]) => code === 10).length, 1)
      } finally {
        settleWrite?.()
        await session.disconnect()
      }
    })
  }
})

test('timeout closes the port and prevents any further write', async () => {
  const port = new FixturePort(() => {})
  const session = sessionWith(port, 25)
  await session.connect()
  assert.equal(session.getSnapshot().error.code, 'timeout')
  await setImmediate()
  assert.equal(port.closed, true)
  assert.deepEqual(port.commands, [[22, 3]])
})

test('physical removal interrupts a pending command', async () => {
  const port = new FixturePort(() => {})
  const session = sessionWith(port)
  const wrote = once(port, 'command')
  const connection = session.connect()
  await wrote
  port.dispatchEvent(new Event('disconnect'))
  await connection
  await setImmediate()
  assert.equal(session.getSnapshot().error.code, 'disconnected')
  assert.equal(port.closed, true)
  assert.deepEqual(port.commands, [[22, 3]])
})

test('storage failure and message-waiting pushes never dequeue a receipt', async () => {
  const port = new FixturePort(([code], serial) => {
    switch (code) {
      case 22: serial.emit(...deviceInfo()); break
      case 1: serial.emit(...selfInfo()); break
      case 4:
        serial.emit(2, 0, 0, 0, 0)
        serial.emit(4, 0, 0, 0, 0)
        break
      default: assert.fail(`Unexpected command ${code}`)
    }
  })
  const session = sessionWith(port)
  const cache = new SessionCache(session, async () => { throw new Error('Storage unavailable') })
  await session.connect()
  await setImmediate()
  assert.equal(session.getSnapshot().phase, 'ready')
  assert.match(cache.getSnapshot().error, /Storage unavailable/)
  assert.ok(cache.getSnapshot().pending > 0)
  port.emit(0x83)
  await setImmediate()
  assert.deepEqual(port.commands.map(([code]) => code), [22, 1, 4])
  assert.deepEqual(session.getSnapshot().messages, [])
  await session.disconnect()
})

test('disconnect waits for an in-flight port open and releases it before reconnecting', async () => {
  const port = new FixturePort(() => assert.fail('No command should be sent'))
  let releaseOpen
  port.open = () => new Promise((resolve) => { releaseOpen = resolve })
  const session = sessionWith(port)
  const connection = session.connect()
  await setImmediate()
  assert.equal(typeof releaseOpen, 'function')
  const disconnection = session.disconnect()
  assert.equal(session.getSnapshot().phase, 'closing')
  await session.connect()
  releaseOpen()
  await Promise.all([connection, disconnection])
  assert.equal(session.getSnapshot().phase, 'idle')
  assert.equal(port.closed, true)
})

test('reconnects an authorized replugged port only after checking its radio key', async () => {
  const first = workingPort()
  const replugged = workingPort()
  let ports = []
  const session = sessionWith(first, 1000, {
    environment: { secureContext: true, serial: { requestPort: async () => first, getPorts: async () => ports } },
    retryDelays: [5, 5, 5, 5, 5],
  })
  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  assert.equal(session.getSnapshot().phase, 'reconnecting')
  ports = [replugged]
  await waitFor(() => session.getSnapshot().phase === 'ready')
  assert.deepEqual(replugged.commands.map(([code]) => code), [22, 1, 4])
  assert.equal(replugged.commands.some(([code]) => code === 10), false)
  await session.disconnect()
})

test('rejects a different radio before contacts are requested', async () => {
  const first = workingPort()
  const wrong = workingPort(0xcd)
  const session = sessionWith(first, 1000, {
    environment: { secureContext: true, serial: { requestPort: async () => first, getPorts: async () => [wrong] } },
    retryDelays: [1],
  })
  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'error')
  assert.equal(session.getSnapshot().error.code, 'identity')
  assert.deepEqual(wrong.commands.map(([code]) => code), [22, 1])
  assert.equal(wrong.closed, true)
})

test('does not open ambiguous matching ports and stops after bounded missing-port retries', async () => {
  const first = workingPort()
  const others = [workingPort(), workingPort()]
  let ports = others
  const session = sessionWith(first, 1000, {
    environment: { secureContext: true, serial: { requestPort: async () => first, getPorts: async () => ports } },
    retryDelays: [1, 1],
  })
  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'error')
  assert.equal(session.getSnapshot().error.code, 'identity')
  assert.deepEqual(others.map((port) => port.commands.length), [0, 0])

  const next = workingPort()
  ports = []
  const missing = sessionWith(next, 1000, {
    environment: { secureContext: true, serial: { requestPort: async () => next, getPorts: async () => ports } },
    retryDelays: [1, 1],
  })
  await missing.connect()
  next.dispatchEvent(new Event('disconnect'))
  await waitFor(() => missing.getSnapshot().phase === 'error')
  assert.equal(missing.getSnapshot().error.code, 'reconnect-failed')
})

test('manual disconnect cancels retries and releases cross-tab ownership', async () => {
  const locks = fixtureLocks()
  const first = workingPort()
  const second = workingPort()
  let scans = 0
  const session = sessionWith(first, 1000, {
    locks,
    environment: { secureContext: true, serial: { requestPort: async () => first, getPorts: async () => { scans++; return [] } } },
    retryDelays: [50],
  })
  const other = sessionWith(second, 1000, { locks })
  await session.connect()
  await other.connect()
  await waitFor(() => other.getSnapshot().phase === 'error')
  assert.equal(other.getSnapshot().error.code, 'ownership')
  assert.equal(second.commands.length, 0)
  first.dispatchEvent(new Event('disconnect'))
  await session.disconnect()
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(scans, 0)
  assert.equal(session.getSnapshot().phase, 'idle')
  await other.connect()
  assert.equal(other.getSnapshot().phase, 'ready')
  await other.disconnect()
})

test('a failed reconnect attempt consumes the retry budget without overlapping attempts', async () => {
  const first = workingPort()
  const stalled = new FixturePort(() => {})
  let scans = 0
  const session = sessionWith(first, 15, {
    environment: { secureContext: true, serial: {
      requestPort: async () => first,
      getPorts: async () => { scans++; return [stalled] },
    } },
    retryDelays: [1, 1],
  })
  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'error')
  assert.equal(session.getSnapshot().error.code, 'reconnect-failed')
  assert.equal(scans, 2)
  assert.equal(stalled.closed, true)
})

test('disconnect during ownership acquisition cannot leave the lock held', async () => {
  const underlying = fixtureLocks()
  let allow
  const gate = new Promise((resolve) => { allow = resolve })
  const locks = { request: async (...args) => { await gate; return underlying.request(...args) } }
  const port = workingPort()
  const session = sessionWith(port, 1000, { locks })
  const connecting = session.connect()
  await setImmediate()
  const disconnecting = session.disconnect()
  allow()
  await Promise.all([connecting, disconnecting])
  assert.equal(session.getSnapshot().phase, 'idle')
  const other = sessionWith(workingPort(), 1000, { locks: underlying })
  await other.connect()
  assert.equal(other.getSnapshot().phase, 'ready')
  await other.disconnect()
})

test('completed reconnection syncs are saved once per attempt', async () => {
  const first = workingPort()
  const second = workingPort()
  const updates = []
  const session = sessionWith(first, 1000, {
    environment: { secureContext: true, serial: { requestPort: async () => first, getPorts: async () => [second] } },
    retryDelays: [1],
  })
  const cache = new SessionCache(session, async () => ({
    update: async (key, update) => { updates.push({ key, update }) },
    close: () => {},
  }))
  await session.connect()
  await waitFor(() => updates.length === 2 && !cache.getSnapshot().saving)
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'ready' && updates.length === 4 && !cache.getSnapshot().saving)
  assert.deepEqual(updates.map(({ key }) => key), Array(4).fill('ab'.repeat(32)))
  assert.deepEqual(updates.map(({ update }) => Object.keys(update)[0]), ['contacts', 'channels', 'contacts', 'channels'])
  await session.disconnect()
})

test('a port close failure keeps ownership and requires a reload', async () => {
  const locks = fixtureLocks()
  const first = workingPort()
  first.close = async () => { throw new Error('close failed') }
  const session = sessionWith(first, 1000, { locks, retryDelays: [1] })
  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'error')
  assert.match(session.getSnapshot().error.message, /Reload/)
  const other = sessionWith(workingPort(), 1000, { locks })
  await other.connect()
  assert.equal(other.getSnapshot().error.code, 'ownership')
})

test('a failed close after reopening without streams stops retries and retains ownership', async () => {
  const locks = fixtureLocks()
  const first = workingPort()
  const broken = new FixturePort(() => assert.fail('No command should be sent'))
  let opens = 0
  let closes = 0
  let scans = 0
  let choices = 0
  broken.open = async () => {
    opens++
    broken.readable = null
    broken.writable = null
  }
  broken.close = async () => { closes++; throw new Error('close failed') }
  const session = sessionWith(first, 1000, {
    locks,
    environment: { secureContext: true, serial: {
      requestPort: async () => { choices++; return first },
      getPorts: async () => { scans++; return [broken] },
    } },
    retryDelays: [1, 1, 1],
  })

  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'error')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  assert.match(session.getSnapshot().error.message, /Reload/)
  assert.equal(scans, 1)
  assert.equal(opens, 1)
  assert.equal(closes, 1)
  assert.deepEqual(broken.commands, [])

  await session.disconnect()
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  await session.connect()
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  assert.equal(choices, 1)
  const otherPort = workingPort()
  let otherOpens = 0
  otherPort.open = async () => { otherOpens++ }
  const other = sessionWith(otherPort, 1000, { locks })
  await other.connect()
  assert.equal(other.getSnapshot().error.code, 'ownership')
  assert.equal(otherOpens, 0)
  assert.deepEqual(otherPort.commands, [])
})

test('a failed manual close cannot release ownership on a later disconnect', async () => {
  const locks = fixtureLocks()
  const port = workingPort()
  let closes = 0
  port.close = async () => { closes++; throw new Error('close failed') }
  const session = sessionWith(port, 1000, { locks })
  await session.connect()
  await session.disconnect()
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  assert.equal(closes, 1)
  assert.match(session.getSnapshot().error.message, /Reload/)
  await session.disconnect()
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  assert.equal(closes, 1)

  const other = sessionWith(workingPort(), 1000, { locks })
  await other.connect()
  assert.equal(other.getSnapshot().error.code, 'ownership')
})

test('a failed close after cancelling an in-flight open retains ownership', async () => {
  const locks = fixtureLocks()
  const port = new FixturePort(() => assert.fail('No command should be sent'))
  let releaseOpen
  port.open = () => new Promise((resolve) => { releaseOpen = resolve })
  port.close = () => { throw new Error('close failed') }
  const session = sessionWith(port, 1000, { locks })
  const connecting = session.connect()
  await waitFor(() => typeof releaseOpen === 'function')
  const disconnecting = session.disconnect()
  releaseOpen()
  await Promise.all([connecting, disconnecting])
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  await session.disconnect()
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')

  const other = sessionWith(workingPort(), 1000, { locks })
  await other.connect()
  assert.equal(other.getSnapshot().error.code, 'ownership')
})

test('disconnect releases ownership when an unusable opening port closes successfully', async () => {
  const locks = fixtureLocks()
  const port = new FixturePort(() => assert.fail('No command should be sent'))
  let releaseClose
  port.open = async () => { port.readable = null; port.writable = null }
  port.close = () => new Promise((resolve) => { releaseClose = resolve })
  const session = sessionWith(port, 1000, { locks })
  const connecting = session.connect()
  await waitFor(() => typeof releaseClose === 'function')
  const disconnecting = session.disconnect()
  releaseClose()
  await Promise.all([connecting, disconnecting])
  assert.equal(session.getSnapshot().phase, 'idle')

  const other = sessionWith(workingPort(), 1000, { locks })
  await other.connect()
  assert.equal(other.getSnapshot().phase, 'ready')
  await other.disconnect()
})

test('a successfully closed unusable port permits a later retry', async () => {
  const first = workingPort()
  const broken = new FixturePort(() => assert.fail('No command should be sent'))
  broken.open = async () => { broken.readable = null; broken.writable = null }
  broken.close = async () => { broken.closed = true }
  const replugged = workingPort()
  let scans = 0
  const session = sessionWith(first, 1000, {
    environment: { secureContext: true, serial: {
      requestPort: async () => first,
      getPorts: async () => [scans++ === 0 ? broken : replugged],
    } },
    retryDelays: [1, 1],
  })
  await session.connect()
  first.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'ready')
  assert.equal(broken.closed, true)
  assert.equal(scans, 2)
  assert.deepEqual(replugged.commands.map(([code]) => code), [22, 1, 4])
  await session.disconnect()
})

test('ownership and port enumeration failures give actionable errors', async () => {
  const first = workingPort()
  const unavailable = sessionWith(first, 1000, {
    locks: { request: async () => { throw new Error('Locks unavailable') } },
  })
  await unavailable.connect()
  assert.equal(unavailable.getSnapshot().error.code, 'ownership')
  assert.equal(first.commands.length, 0)

  const second = workingPort()
  const session = sessionWith(second, 1000, {
    environment: { secureContext: true, serial: {
      requestPort: async () => second,
      getPorts: async () => { throw new Error('Permission revoked') },
    } },
    retryDelays: [1],
  })
  await session.connect()
  second.dispatchEvent(new Event('disconnect'))
  await waitFor(() => session.getSnapshot().phase === 'error')
  assert.equal(session.getSnapshot().error.code, 'reconnect-failed')
  assert.match(session.getSnapshot().error.message, /permissions/)
})
