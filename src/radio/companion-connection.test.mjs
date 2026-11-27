import assert from 'node:assert/strict'
import test from 'node:test'
import {
  browserCompanionConnectionPersistence, companionConnectionKey, parseCompanionConnection,
} from './companion-connection.ts'

test('parses only complete, versioned companion connection identities', () => {
  assert.deepEqual(parseCompanionConnection(JSON.stringify({
    version: 1,
    transport: 'usb',
    publicKey: 'AB'.repeat(32),
    vendorId: 1,
    productId: 2,
  })), {
    version: 1,
    transport: 'usb',
    publicKey: 'ab'.repeat(32),
    vendorId: 1,
    productId: 2,
  })
  assert.deepEqual(parseCompanionConnection(JSON.stringify({
    version: 1,
    transport: 'bluetooth',
    publicKey: 'cd'.repeat(32),
    deviceId: 'authorized-radio',
  })), {
    version: 1,
    transport: 'bluetooth',
    publicKey: 'cd'.repeat(32),
    deviceId: 'authorized-radio',
  })
  assert.equal(parseCompanionConnection(null), null)
  assert.throws(() => parseCompanionConnection('{}'), { code: 'reconnect-failed' })
  assert.throws(() => parseCompanionConnection(JSON.stringify({
    version: 1,
    transport: 'usb',
    publicKey: 'ab'.repeat(32),
    vendorId: 1,
  })), { code: 'reconnect-failed' })
  assert.throws(() => parseCompanionConnection(JSON.stringify({
    version: 1,
    transport: 'usb',
    publicKey: 'ab'.repeat(32),
    vendorId: 0x10000,
    productId: 1,
  })), { code: 'reconnect-failed' })
})

test('browser persistence stores and clears one safe refresh target', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })

  const target = {
    version: 1, transport: 'bluetooth', publicKey: 'ab'.repeat(32), deviceId: 'paired-radio',
  }
  browserCompanionConnectionPersistence.save(target)
  assert.deepEqual(browserCompanionConnectionPersistence.load(), target)
  assert.equal(values.has(companionConnectionKey), true)
  browserCompanionConnectionPersistence.clear()
  assert.equal(values.has(companionConnectionKey), false)
})
