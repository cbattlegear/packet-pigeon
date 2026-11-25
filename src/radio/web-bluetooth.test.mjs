import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { CompanionSession } from './index.ts'
import { chooseBluetoothDevice, getWebBluetoothSupport, meshCoreBluetooth } from './web-bluetooth.ts'

const encode = (value) => new TextEncoder().encode(value)

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

function fixture({ writeWithoutResponse = false } = {}) {
  const device = new EventTarget()
  const notifications = new EventTarget()
  const writes = []
  const state = {
    chooses: 0, connects: 0, closes: 0, subscriptions: 0, connected: false,
    identity: 0xab, missingService: false, rejectSubscription: false, rejectClose: false, rejectConnects: 0,
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
      notify(Uint8Array.of(13, 14, 100, 0, ...new Uint8Array(78)))
    } else if (command[0] === 1) {
      notify(Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(state.identity),
        ...new Uint8Array(22), ...encode('Bluetooth fixture')))
    } else if (command[0] === 4) {
      const contact = Uint8Array.of(3, ...new Uint8Array(32).fill(0xbc), 2, 0, 0xff, ...new Uint8Array(112))
      contact.set(encode('Fixture repeater'), 100)
      notify(Uint8Array.of(2, 1, 0, 0, 0))
      notify(contact)
      notify(Uint8Array.of(4, 0, 0, 0, 0))
    } else assert.fail(`Unexpected raw command ${command[0]}`)
  }
  const rx = Object.assign(new EventTarget(), {
    properties: { write: !writeWithoutResponse, writeWithoutResponse: true },
    async writeValueWithResponse(bytes) { responses(bytes, 'with') },
    async writeValueWithoutResponse(bytes) { responses(bytes, 'without') },
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
    },
  }
  return { environment, device, notify, drop, state, writes }
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
