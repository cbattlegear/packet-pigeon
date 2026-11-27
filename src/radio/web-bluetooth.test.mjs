import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { CompanionSession } from './index.ts'
import { MessageSync } from '../integration/message-sync.ts'
import { SessionCache } from '../integration/session-cache.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import { chooseBluetoothDevice, getWebBluetoothSupport, meshCoreBluetooth } from './web-bluetooth.ts'

const encode = (value) => new TextEncoder().encode(value)
const directReceipt = (text) => Uint8Array.of(
  16, 8, 0, 0, 1, 2, 3, 4, 5, 6, 0xff, 0, 42, 0, 0, 0, ...encode(text),
)

function ownership() {
  let held = false
  return {
    async request(name, options, callback) {
      assert.equal(name, 'packet-pigeon-usb-session')
      assert.equal(options.ifAvailable, true)
      if (held) return callback(null)
      held = true
      try { return await callback({}) } finally { held = false }
    },
    get held() { return held },
  }
}

function fixture({
  writeWithoutResponse = false, queuedMessages = [], directMessaging = false,
  notificationLimit = Infinity, queueWrite, activeDiscovery = false,
} = {}) {
  const device = new EventTarget()
  device.id = 'fixture-radio'
  const notifications = new EventTarget()
  const writes = []
  const queue = [...queuedMessages]
  const state = {
    chooses: 0, enumerations: 0, connects: 0, closes: 0, subscriptions: 0, connected: false,
    identity: 0xab, missingService: false, rejectSubscription: false, rejectClose: false, rejectConnects: 0,
    dequeued: 0, pathLength: 0, pathBytes: [], protocolVersion: 14,
    noiseReply: [24, 1, 0x85, 0xff, ...new Uint8Array(10)],
  }
  const contactFrame = () => {
    const contact = Uint8Array.of(3, ...new Uint8Array(32).fill(0xbc), directMessaging ? 1 : 2, 0,
      activeDiscovery ? state.pathLength : 0xff, ...new Uint8Array(112))
    contact.set(state.pathBytes, 36)
    contact.set(encode('Fixture repeater'), 100)
    return contact
  }
  const notify = (frame) => {
    // Bluetooth characteristic values may be views into a larger backing buffer.
    const storage = Uint8Array.of(0xff, ...frame, 0xff)
    notifications.value = new DataView(storage.buffer, 1, frame.length)
    notifications.dispatchEvent(new Event('characteristicvaluechanged'))
  }
  notifications.properties = { notify: true }
  notifications.startNotifications = async () => {
    state.subscriptions++
    if (state.rejectSubscription) throw new DOMException('Notification permission', 'SecurityError')
    return notifications
  }
  const responses = (command, method) => {
    assert(state.connected)
    assert(state.subscriptions > 0)
    writes.push({ bytes: Array.from(command), method })
    if (command[0] === 22) {
      notify(Uint8Array.of(13, state.protocolVersion, 100, 0, ...new Uint8Array(78)))
    } else if (command[0] === 1) {
      notify(Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(state.identity),
        ...new Uint8Array(22), ...encode('Bluetooth fixture')))
    } else if (command[0] === 4) {
      notify(Uint8Array.of(2, 1, 0, 0, 0))
      notify(contactFrame())
      notify(Uint8Array.of(4, 0, 0, 0, 0))
    } else if (command[0] === 30 && activeDiscovery) {
      notify(command[1] === 0xbc ? contactFrame() : Uint8Array.of(1, 2))
    } else if (command[0] === 55 && activeDiscovery) {
      notify(Uint8Array.of(0x8e, 0xf8, 0x9c, 0, 0x92, 0xec, ...command.slice(3, 7), ...new Uint8Array(8).fill(0xbc)))
      notify(Uint8Array.of(0x8e, 0xf8, 0x9c, 0, 0x92, 0xec, ...command.slice(3, 7), ...new Uint8Array(32).fill(0xbc)))
      notify(Uint8Array.of(0))
    } else if (command[0] === 57 && activeDiscovery) {
      const body = command[33] === 1 ? '*,local' : 'Relay\nOperator'
      notify(Uint8Array.of(0x8c, 0, 1, 2, 3, 4, 9, 0, 0, 0, ...encode(body)))
      notify(Uint8Array.of(6, 0, 1, 2, 3, 4, 0xe8, 3, 0, 0))
    } else if (command[0] === 56) {
      if (state.noiseReply) notify(Uint8Array.from(state.noiseReply))
    } else if (command[0] === 2 && directMessaging) {
      notify(Uint8Array.of(0x82, 1, 2, 3, 4, 42, 0, 0, 0))
      if (queue.length) notify(Uint8Array.of(0x83))
      notify(Uint8Array.of(6, 0, 1, 2, 3, 4, 0xe8, 3, 0, 0))
    } else if (command[0] === 13 && directMessaging) {
      notify(Uint8Array.of(0))
    } else if (command[0] === 10) {
      const fragments = queue.shift()
      if (fragments) {
        state.dequeued++
        for (const fragment of fragments) {
          if (fragment.length <= notificationLimit) notify(fragment)
        }
      } else {
        notify(Uint8Array.of(10))
      }
    } else assert.fail(`Unexpected raw command ${command[0]}`)
  }
  const rx = Object.assign(new EventTarget(), {
    properties: { write: !writeWithoutResponse, writeWithoutResponse: true },
    async writeValueWithResponse(bytes) {
      responses(bytes, 'with')
      if (bytes[0] === 10) await queueWrite?.()
    },
    async writeValueWithoutResponse(bytes) {
      responses(bytes, 'without')
      if (bytes[0] === 10) await queueWrite?.()
    },
  })
  const drop = () => {
    state.connected = false
    device.dispatchEvent(new Event('gattserverdisconnected'))
  }
  const gatt = {
    get connected() { return state.connected },
    async connect() {
      state.connects++
      if (state.rejectConnects > 0) {
        state.rejectConnects--
        throw new DOMException('Out of range', 'NetworkError')
      }
      state.connected = true
      return gatt
    },
    disconnect() {
      state.closes++
      if (state.rejectClose) throw new DOMException('Radio is busy', 'NetworkError')
      drop()
    },
    async getPrimaryService(uuid) {
      assert.equal(uuid, meshCoreBluetooth.service)
      if (state.missingService) throw new DOMException('Service missing', 'NotFoundError')
      return {
        async getCharacteristic(uuid) {
          if (uuid === meshCoreBluetooth.receive) return rx
          if (uuid === meshCoreBluetooth.transmit) return notifications
          assert.fail(`Unexpected characteristic ${uuid}`)
        },
      }
    },
  }
  device.gatt = gatt
  const environment = {
    secureContext: true,
    bluetooth: {
      async requestDevice(options) {
        assert.deepEqual(options, { filters: [{ services: [meshCoreBluetooth.service] }] })
        state.chooses++
        return device
      },
      async getDevices() {
        state.enumerations++
        return [device]
      },
    },
  }
  return { environment, device, notify, drop, state, writes, queue }
}

async function until(session, condition) {
  for (let step = 0; step < 100; step++) {
    if (condition(session.getSnapshot())) return
    await setTimeout(2)
  }
  assert.fail(`Unexpected final phase: ${session.getSnapshot().phase}`)
}

test('starts pairing only on request and handles browser support, chooser cancellation, and denial', async () => {
  assert.equal(getWebBluetoothSupport({ secureContext: false }).error.code, 'insecure-context')
  assert.equal(getWebBluetoothSupport({ secureContext: true }).error.code, 'unsupported-browser')
  const denied = (name) => ({
    secureContext: true, bluetooth: { async requestDevice() { throw new DOMException('Fixture', name) } },
  })
  assert.equal(await chooseBluetoothDevice(denied('NotFoundError')), null)
  await assert.rejects(chooseBluetoothDevice(denied('SecurityError')), { code: 'chooser-failed' })
  const { environment, state } = fixture()
  const session = new CompanionSession({ bluetoothEnvironment: environment, locks: ownership() })
  assert.equal(session.getSnapshot().phase, 'idle')
  assert.equal(state.chooses, 0)
})

test('uses raw notification frames, prefers writes with response, and shares sync and contact decoding', async () => {
  const radio = fixture()
  const locks = ownership()
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks })
  const pushes = []
  const unsubscribe = session.subscribeToPushes((push) => pushes.push(push.code))
  await session.connectBluetooth()
  assert.equal(session.getSnapshot().phase, 'ready')
  assert.equal(session.getSnapshot().device.name, 'Bluetooth fixture')
  assert.equal(session.getSnapshot().contacts[0].name, 'Fixture repeater')
  assert.deepEqual(radio.writes.map(({ bytes }) => bytes[0]), [22, 1, 4])
  assert.deepEqual(radio.writes[0].bytes, [22, 3])
  assert(radio.writes.every(({ method }) => method === 'with'))
  radio.notify(Uint8Array.of(0x83))
  await setTimeout(0)
  assert.deepEqual(pushes, [0x83])
  await session.disconnect()
  radio.notify(Uint8Array.of(0x83))
  await setTimeout(0)
  assert.deepEqual(pushes, [0x83])
  assert.equal(locks.held, false)
  assert.equal(radio.state.closes, 1)
  unsubscribe()
})

test('Bluetooth automatically syncs initial messages, notification bursts and messages queued during reconnect', async (t) => {
  const radio = fixture({ queuedMessages: [[directReceipt('Initial')]], directMessaging: true })
  const session = new CompanionSession({
    bluetoothEnvironment: radio.environment, locks: ownership(), retryDelays: [1],
  })
  const factory = new IDBFactory()
  const cache = new SessionCache(session, () => openRadioStorage(factory))
  const sync = new MessageSync(session, () => openRadioStorage(factory), () => {
    const status = cache.getSnapshot()
    return !status.error && !status.saving && status.pending === 0
  })
  const stop = sync.startAutomaticSync(cache.subscribe)
  t.after(async () => { stop(); await session.disconnect() })
  await session.connectBluetooth()
  await until(sync, (status) => status.data?.messages.length === 1 && !status.syncing)
  radio.queue.push([directReceipt('Later')], [directReceipt('Burst')])
  for (let i = 0; i < 10; i++) radio.notify(Uint8Array.of(0x83))
  await until(sync, (status) => status.data?.messages.length === 3 && !status.syncing)
  radio.queue.push([directReceipt('Reply while sending')])
  await session.sendDirect(session.getSnapshot().device.publicKey, 'bc'.repeat(32), 42, 0, 'Outgoing fixture')
  await until(sync, (status) => status.data?.messages.length === 4 && !status.syncing)
  radio.drop()
  radio.queue.push([directReceipt('Reconnected')])
  await until(sync, (status) => status.data?.messages.length === 5 && !status.syncing)
  assert.equal(radio.state.connects, 2)
  assert.equal(radio.state.chooses, 1)
  assert.deepEqual(sync.getSnapshot().data.messages.map(({ text }) => text),
    ['Initial', 'Later', 'Burst', 'Reply while sending', 'Reconnected'])
  assert.equal(sync.getSnapshot().error, null)
})

test('Bluetooth noise-floor reads stay local, reject incomplete replies, and respect firmware support', async () => {
  const radio = fixture()
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks: ownership() })
  await session.connectBluetooth()
  const key = session.getSnapshot().device.publicKey
  assert.deepEqual(radio.writes.map(({ bytes }) => bytes[0]), [22, 1, 4])
  assert.equal(await session.noiseFloor(key), -123)
  assert.deepEqual(radio.writes.at(-1).bytes, [56, 1])
  radio.state.noiseReply = [24, 1, 0x85]
  await assert.rejects(session.noiseFloor(key), { code: 'protocol' })
  radio.state.noiseReply = [1, 1]
  await assert.rejects(session.noiseFloor(key), { code: 'unsupported-firmware' })
  assert.equal(radio.writes.some(({ bytes }) => bytes[0] === 55 || bytes[0] === 57), false)
  await session.disconnect()

  const old = fixture()
  old.state.protocolVersion = 7
  const oldSession = new CompanionSession({ bluetoothEnvironment: old.environment, locks: ownership() })
  await oldSession.connectBluetooth()
  await assert.rejects(oldSession.noiseFloor(key), { code: 'unsupported-firmware' })
  assert.equal(old.writes.some(({ bytes }) => bytes[0] === 56), false)
  await oldSession.disconnect()

  const dropped = fixture()
  dropped.state.noiseReply = null
  const timed = new CompanionSession({ bluetoothEnvironment: dropped.environment, locks: ownership(), timeoutMs: 40 })
  await timed.connectBluetooth()
  await assert.rejects(timed.noiseFloor(key), { code: 'timeout' })
  await until(timed, ({ phase }) => phase === 'error')
  assert.equal(dropped.state.closes, 1)
  assert.equal(dropped.writes.filter(({ bytes }) => bytes[0] === 56).length, 1)
  await timed.disconnect()
})

test('active discovery uses Bluetooth only on request and ignores short discovery replies', async () => {
  const radio = fixture({ activeDiscovery: true })
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks: ownership() })
  await session.connectBluetooth()
  const key = session.getSnapshot().device.publicKey
  assert.deepEqual(radio.writes.map(({ bytes }) => bytes[0]), [22, 1, 4])
  const controller = new AbortController()
  const found = []
  let listening = false
  const scan = session.discoverNearby(key, controller.signal, (node) => found.push(node), () => { listening = true })
  await until(session, () => listening && found.length === 1)
  assert.equal(found[0].publicKey, 'bc'.repeat(32))
  controller.abort(new Error('Stopped'))
  await assert.rejects(scan, /Stopped/)
  const signal = new AbortController().signal
  assert.deepEqual(await session.discoverRepeaterDetails(key, 'bc'.repeat(32), 'regions', signal, () => {}),
    { kind: 'regions', regions: ['*', 'local'] })
  assert.deepEqual(await session.discoverRepeaterDetails(key, 'bc'.repeat(32), 'owner', signal, () => {}),
    { kind: 'owner', name: 'Relay', owner: 'Operator' })
  radio.state.pathLength = 0x42
  radio.state.pathBytes = [0x12, 0x34, 0x56, 0x78]
  assert.deepEqual(await session.discoverRepeaterDetails(key, 'bc'.repeat(32), 'regions', signal, () => {}, {
    expectedRoute: { pathLength: 0x42, pathHex: '12345678' }, replyPath: { width: 2, text: '5678 1234' },
  }), { kind: 'regions', regions: ['*', 'local'] })
  assert.deepEqual(radio.writes.at(-1).bytes.slice(33), [1, 0x42, 0x56, 0x78, 0x12, 0x34])
  assert.deepEqual(await session.discoverRepeaterDetails(key, 'cd'.repeat(32), 'regions', signal, () => {}, {
    expectedRoute: null, replyPath: { width: 1, text: '' },
  }), { kind: 'regions', regions: ['*', 'local'] })
  assert.deepEqual(radio.writes.map(({ bytes }) => bytes[0]), [22, 1, 4, 55, 30, 57, 30, 57, 30, 57, 30, 57])
  await session.disconnect()
})

test('uses write without response when required and reconnects to the authorized device with bounded retries', async () => {
  const radio = fixture({ writeWithoutResponse: true })
  const session = new CompanionSession({
    bluetoothEnvironment: radio.environment, locks: ownership(), retryDelays: [1, 1], timeoutMs: 100,
  })
  await session.connectBluetooth()
  radio.state.rejectConnects = 1
  radio.drop()
  assert.equal(session.getSnapshot().phase, 'reconnecting')
  await until(session, ({ phase }) => phase === 'ready')
  assert.equal(radio.state.chooses, 1)
  assert.equal(radio.state.connects, 3)
  assert.equal(radio.state.subscriptions, 2)
  assert(radio.writes.every(({ method }) => method === 'without'))
  radio.drop()
  await session.disconnect()
  await setTimeout(8)
  assert.equal(session.getSnapshot().phase, 'idle')
  assert.equal(radio.state.connects, 3)
})

test('refresh restoration reuses an enumerated Bluetooth permission without opening the chooser', async () => {
  const radio = fixture()
  let saved = null
  const persistence = {
    load: () => saved,
    save: (target) => { saved = target },
    clear: () => { saved = null },
  }
  const original = new CompanionSession({
    bluetoothEnvironment: radio.environment,
    locks: ownership(),
    connectionPersistence: persistence,
  })
  await original.connectBluetooth()
  assert.deepEqual(saved, {
    version: 1,
    transport: 'bluetooth',
    publicKey: 'ab'.repeat(32),
    deviceId: 'fixture-radio',
  })
  const target = saved
  await original.disconnect()
  saved = target

  const refreshed = new CompanionSession({
    bluetoothEnvironment: radio.environment,
    locks: ownership(),
    connectionPersistence: persistence,
  })
  await refreshed.restore()
  assert.equal(refreshed.getSnapshot().phase, 'ready')
  assert.equal(radio.state.chooses, 1)
  assert.equal(radio.state.enumerations, 1)
  assert.equal(radio.state.connects, 2)
  await refreshed.disconnect()
  saved = target

  radio.state.identity = 0xcd
  const different = new CompanionSession({
    bluetoothEnvironment: radio.environment,
    locks: ownership(),
    connectionPersistence: persistence,
  })
  await different.restore()
  assert.equal(different.getSnapshot().error.code, 'identity')
  assert.equal(radio.state.chooses, 1)
  assert.equal(radio.state.connected, false)
})

test('checks the radio identity before syncing after Bluetooth recovery', async () => {
  const radio = fixture()
  const session = new CompanionSession({
    bluetoothEnvironment: radio.environment, locks: ownership(), retryDelays: [1], timeoutMs: 100,
  })
  await session.connectBluetooth()
  radio.state.identity = 0xde
  radio.drop()
  await until(session, ({ phase }) => phase === 'error')
  assert.equal(session.getSnapshot().error.code, 'identity')
  assert.deepEqual(radio.writes.map(({ bytes }) => bytes[0]), [22, 1, 4, 22, 1])
  assert.equal(radio.state.connected, false)
})

test('manually syncs Bluetooth receipts, retaining the save barrier and ownership across disconnect', async () => {
  const receipt = directReceipt('Hello over Bluetooth')
  const radio = fixture({ queuedMessages: [[receipt], [receipt]] })
  const locks = ownership()
  const factory = new IDBFactory()
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks })
  const other = new CompanionSession({ bluetoothEnvironment: radio.environment, locks })
  const attempts = []
  let fail = true
  let saving = false
  let releaseSave
  const saveBarrier = new Promise((resolve) => { releaseSave = resolve })
  const openStorage = async () => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      update: async (key, update) => {
        attempts.push(update.messages[0].id)
        if (fail) {
          saving = true
          await saveBarrier
          fail = false
          throw new Error('Disk unavailable')
        }
        await storage.update(key, update)
      },
    }
  }
  const sync = new MessageSync(session, openStorage)
  let disconnecting
  let syncing
  try {
    await session.connectBluetooth()
    radio.notify(Uint8Array.of(0x83))
    await setTimeout(0)
    assert(!radio.writes.some(({ bytes }) => bytes[0] === 10))
    syncing = sync.sync()
    for (let step = 0; !saving && step < 100; step++) await setTimeout(2)
    assert(saving)
    await setTimeout(5)
    assert.equal(radio.state.dequeued, 1)
    assert.equal(radio.writes.filter(({ bytes }) => bytes[0] === 10).length, 1)
    releaseSave()
    await syncing
    assert.equal(radio.state.dequeued, 1)
    assert.equal(sync.getSnapshot().pending, true)
    assert.match(sync.getSnapshot().error, /Disk unavailable/)
    assert.throws(() => session.reserveQueuedMessage('ab'.repeat(32)), /Save the previous/)

    disconnecting = session.disconnect()
    await other.connectBluetooth()
    assert.equal(other.getSnapshot().error.code, 'ownership')
    assert.equal(radio.state.dequeued, 1)

    await sync.sync()
    await disconnecting
    assert.equal(sync.getSnapshot().pending, false)
    assert.equal(attempts[0], attempts[1])
    await other.connectBluetooth()
    assert.equal(other.getSnapshot().phase, 'ready')
    assert.equal(radio.state.dequeued, 1)

    const resumed = new MessageSync(other, openStorage)
    await resumed.sync()
    assert.equal(resumed.getSnapshot().error, null)
    assert.equal(radio.state.dequeued, 2)
    assert.equal(radio.writes.filter(({ bytes }) => bytes[0] === 10).length, 3)
    const messages = resumed.getSnapshot().data.messages
    assert.deepEqual(messages.map(({ text }) => text), ['Hello over Bluetooth', 'Hello over Bluetooth'])
    assert.notEqual(messages[0].id, messages[1].id)
    assert.equal(messages[0].rawHex, Buffer.from(receipt).toString('hex'))
  } finally {
    releaseSave()
    if (syncing) await syncing
    if (sync.getSnapshot().pending) await sync.sync()
    if (disconnecting) await disconnecting
    await session.disconnect()
    await other.disconnect()
  }
})

test('saves a Bluetooth receipt received before its GATT write fails', async () => {
  const receipt = directReceipt('Received before write error')
  const write = Promise.withResolvers()
  const radio = fixture({ queuedMessages: [[receipt], [directReceipt('Next')]], queueWrite: () => write.promise })
  const session = new CompanionSession({
    bluetoothEnvironment: radio.environment, locks: ownership(), retryDelays: [], timeoutMs: 1000,
  })
  const factory = new IDBFactory()
  const sync = new MessageSync(session, () => openRadioStorage(factory))
  let syncing
  try {
    await session.connectBluetooth()
    syncing = sync.sync()
    for (let step = 0; !sync.getSnapshot().pending && step < 100; step++) await setTimeout(2)
    assert.equal(sync.getSnapshot().pending, true)
    write.reject(new DOMException('Write failed', 'NetworkError'))
    await syncing
    assert.match(sync.getSnapshot().error, /write/)
    assert.equal(sync.getSnapshot().pending, false)
    assert.equal(sync.getSnapshot().data.messages[0].text, 'Received before write error')
    assert.equal(radio.state.dequeued, 1)
    assert.equal(radio.writes.filter(({ bytes }) => bytes[0] === 10).length, 1)
  } finally {
    write.resolve()
    if (syncing) await syncing
    await session.disconnect()
  }
})

test('saves a malformed Bluetooth fragment as raw bytes and stops queue sync', async () => {
  const receipt = directReceipt('A fragmented message')
  const first = receipt.slice(0, 8)
  const radio = fixture({ queuedMessages: [[first, receipt.slice(8)], [directReceipt('Next')]] })
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks: ownership() })
  const factory = new IDBFactory()
  const sync = new MessageSync(session, () => openRadioStorage(factory))
  try {
    await session.connectBluetooth()
    await sync.sync()
    assert.match(sync.getSnapshot().error, /unrecognized/)
    assert.equal(radio.state.dequeued, 1)
    assert.equal(radio.writes.filter(({ bytes }) => bytes[0] === 10).length, 1)
    assert.equal(sync.getSnapshot().data.messages[0].rawHex, Buffer.from(first).toString('hex'))
    assert.equal(sync.getSnapshot().data.messages[0].conversationId, 'unsupported')
  } finally {
    await session.disconnect()
  }
})

test('a valid-looking Bluetooth fragment can be saved as incomplete text', async () => {
  const receipt = directReceipt('Partial message')
  const first = receipt.slice(0, 16 + 'Partial'.length)
  const radio = fixture({ queuedMessages: [[first, receipt.slice(first.length)]] })
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks: ownership() })
  const factory = new IDBFactory()
  const sync = new MessageSync(session, () => openRadioStorage(factory))
  try {
    await session.connectBluetooth()
    await sync.sync()
    assert.equal(radio.state.dequeued, 1)
    assert.equal(sync.getSnapshot().data.messages[0].text, 'Partial')
    assert.equal(sync.getSnapshot().data.messages[0].rawHex, Buffer.from(first).toString('hex'))
  } finally {
    await session.disconnect()
  }
})

test('reports a dropped oversized Bluetooth response without draining another receipt', async () => {
  const oversized = directReceipt('x'.repeat(150))
  const notificationLimit = 165
  assert(oversized.length > notificationLimit)
  const radio = fixture({ notificationLimit, queuedMessages: [[oversized], [directReceipt('Next')]] })
  const session = new CompanionSession({
    bluetoothEnvironment: radio.environment, locks: ownership(), timeoutMs: 25,
  })
  const factory = new IDBFactory()
  const sync = new MessageSync(session, () => openRadioStorage(factory))
  try {
    await session.connectBluetooth()
    await sync.sync()
    assert.match(sync.getSnapshot().error, /timed out/)
    assert.equal(sync.getSnapshot().pending, false)
    assert.equal(sync.getSnapshot().data, null)
    assert.equal(radio.state.dequeued, 1)
    assert.equal(radio.writes.filter(({ bytes }) => bytes[0] === 10).length, 1)
    await until(session, ({ phase }) => phase === 'error')
    assert.equal(session.getSnapshot().error.code, 'timeout')
  } finally {
    await session.disconnect()
  }
})

test('ignores split Bluetooth adverts even when a continuation looks like a complete advert', async () => {
  const radio = fixture()
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const radioKey = radioKeyFromPublicKey('ab'.repeat(32))
  const saved = { publicKey: 'ef'.repeat(32), name: 'Previously observed on USB', heardAt: 1 }
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks: ownership() })
  const cache = new SessionCache(session, async () => storage)
  try {
    await storage.update(radioKey, { discovery: { upsert: [saved] } })
    await session.connectBluetooth()
    const advert = Uint8Array.of(0x8a, ...new Uint8Array(32).fill(0x91), 2, 0, 0xff, ...new Uint8Array(112))
    advert[115] = 0x80
    radio.notify(advert.slice(0, 115))
    radio.notify(advert.slice(115))
    await setTimeout(0)
    for (let index = 0; cache.getSnapshot().pending && index < 100; index++) await setTimeout(2)
    assert.deepEqual((await storage.read(radioKey)).discoveries, [saved])
    await assert.rejects(session.advertPath(radioKey, saved.publicKey), { code: 'unsupported-transport' })
    assert(!radio.writes.some(({ bytes }) => bytes[0] === 42))
  } finally {
    await session.disconnect()
    storage.close()
  }
})

test('sends direct commands over Bluetooth without automatically draining queued receipts', async () => {
  const radio = fixture({ directMessaging: true, queuedMessages: [[directReceipt('Waiting')]] })
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks: ownership() })
  const pushes = []
  session.subscribeToPushes((push) => pushes.push(push))
  await session.connectBluetooth()
  const receipt = await session.sendDirect('ab'.repeat(32), 'bc'.repeat(32), 123, 0, 'Hello')
  assert.deepEqual(receipt, { route: 'direct', expectedAck: '01020304', timeoutMs: 1000 })
  assert.deepEqual([...pushes[0].payload], [1, 2, 3, 4, 42, 0, 0, 0])
  await session.resetDirectPath('ab'.repeat(32), 'bc'.repeat(32))
  assert.equal(radio.state.dequeued, 0)
  assert(!radio.writes.some(({ bytes }) => bytes[0] === 10))
  await session.disconnect()
})

test('cleans up missing services and keeps shared ownership if setup cleanup fails', async () => {
  const radio = fixture()
  const locks = ownership()
  const session = new CompanionSession({ bluetoothEnvironment: radio.environment, locks })
  radio.state.missingService = true
  await session.connectBluetooth()
  assert.equal(session.getSnapshot().error.code, 'unsupported-firmware')
  assert.equal(radio.state.connected, false)
  assert.equal(locks.held, false)

  radio.state.missingService = false
  radio.state.rejectSubscription = true
  radio.state.rejectClose = true
  await session.connectBluetooth()
  assert.equal(session.getSnapshot().error.code, 'cleanup-failed')
  assert.equal(locks.held, true)
  const usb = new CompanionSession({
    environment: { secureContext: true, serial: { async requestPort() {
      return { async open() { assert.fail('A second tab must not open USB while Bluetooth owns the session.') } }
    } } },
    locks,
  })
  await usb.connect()
  assert.equal(usb.getSnapshot().error.code, 'ownership')
  assert.deepEqual(radio.writes, [])
})
