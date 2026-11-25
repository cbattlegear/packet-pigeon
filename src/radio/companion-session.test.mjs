import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { CompanionSession, getWebSerialSupport } from './index.ts'
import { SerialFrameDecoder } from './web-serial.ts'
import { SessionCache } from '../integration/session-cache.ts'

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

  emit(...payload) {
    this.incoming.enqueue(response(...payload))
  }
}

function sessionWith(port, timeoutMs = 1000) {
  return new CompanionSession({
    environment: { secureContext: true, serial: { requestPort: async () => port } },
    timeoutMs,
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

function contactInfo() {
  const frame = Uint8Array.of(3, ...new Uint8Array(32).fill(0xbc), 1, 2, 0xff, ...new Uint8Array(112))
  frame.set(encode('Contact'), 100)
  const data = new DataView(frame.buffer)
  data.setUint32(132, 123, true)
  data.setInt32(136, -123000000, true)
  data.setUint32(144, 456, true)
  return frame
}

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
