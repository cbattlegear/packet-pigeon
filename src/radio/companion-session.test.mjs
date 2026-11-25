import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { once } from 'node:events'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { IDBFactory } from 'fake-indexeddb'
import { CompanionSession, getWebSerialSupport } from './index.ts'
import { SerialFrameDecoder } from './web-serial.ts'
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

function contactInfo() {
  const frame = Uint8Array.of(3, ...new Uint8Array(32).fill(0xbc), 1, 2, 0xff, ...new Uint8Array(112))
  frame.set(encode('Contact'), 100)
  const data = new DataView(frame.buffer)
  data.setUint32(132, 123, true)
  data.setInt32(136, -123000000, true)
  data.setUint32(144, 456, true)
  return frame
}

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
