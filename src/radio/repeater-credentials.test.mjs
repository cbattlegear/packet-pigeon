import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { RepeaterCredentialVault, repeaterCredentialKey } from './repeater-credentials.ts'

class MemoryStorage {
  data = new Map()
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { this.data.set(key, value) }
  removeItem(key) { this.data.delete(key) }
}

class Locks {
  tails = new Map()
  request(key, options, action) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => {
      options.signal.throwIfAborted()
      return action()
    })
    this.tails.set(key, next)
    return next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key) })
  }
}

const radio = 'ab'.repeat(32)
const repeater = 'cd'.repeat(32)
const password = 'FixtureSecret!'
const passphrase = 'Unique test passphrase 123'
const signal = () => new AbortController().signal

test('encrypted passwords persist by radio and repeater and authenticate their scope', async () => {
  const storage = new MemoryStorage()
  const locks = new Locks()
  const vault = new RepeaterCredentialVault(storage, locks, webcrypto)
  await vault.save(radio, repeater, password, passphrase, null, signal())
  const key = repeaterCredentialKey(radio, repeater)
  const stored = storage.getItem(key)
  assert.equal(stored.includes(password), false)
  assert.equal(stored.includes(passphrase), false)
  assert.equal(vault.has(radio, repeater), true)
  assert.equal(vault.has('ef'.repeat(32), repeater), false)
  assert.equal(vault.has(radio, 'ef'.repeat(32)), false)
  const reloaded = new RepeaterCredentialVault(storage, locks, webcrypto)
  assert.equal(await reloaded.unlock(radio, repeater, passphrase, signal()), password)
  await assert.rejects(reloaded.unlock(radio, repeater, 'wrong passphrase', signal()), /incorrect or.*damaged/)
  storage.setItem(repeaterCredentialKey(radio, 'ef'.repeat(32)), stored)
  await assert.rejects(reloaded.unlock(radio, 'ef'.repeat(32), passphrase, signal()), /incorrect or.*damaged/)
  const record = JSON.parse(stored)
  record.ciphertext = `${record.ciphertext[0] === '0' ? '1' : '0'}${record.ciphertext.slice(1)}`
  storage.setItem(key, JSON.stringify(record))
  await assert.rejects(reloaded.unlock(radio, repeater, passphrase, signal()), /incorrect or.*damaged/)
  storage.setItem(key, '{invalid')
  await assert.rejects(reloaded.unlock(radio, repeater, passphrase, signal()), /damaged or unsupported/)
  await reloaded.forget(radio, repeater, storage.getItem(key), signal())
  assert.equal(reloaded.has(radio, repeater), false)
  await assert.rejects(reloaded.unlock(radio, repeater, passphrase, signal()), /No encrypted password/)
})

test('rejects invalid input without writing and preserves a saved password on failed replacement', async () => {
  const storage = new MemoryStorage()
  const vault = new RepeaterCredentialVault(storage, new Locks(), webcrypto)
  for (const invalid of ['', 'a'.repeat(16), 'secret\0', '\ud800']) {
    await assert.rejects(vault.save(radio, repeater, invalid, passphrase, null, signal()), /repeater password/)
  }
  await assert.rejects(vault.save(radio, repeater, password, 'short', null, signal()), /passphrase/)
  assert.equal(vault.has(radio, repeater), false)
  await vault.save(radio, repeater, password, passphrase, null, signal())
  const before = storage.getItem(repeaterCredentialKey(radio, repeater))
  await assert.rejects(vault.save(radio, repeater, password, 'short', before, signal()), /passphrase/)
  assert.equal(storage.getItem(repeaterCredentialKey(radio, repeater)), before)
  await assert.rejects(vault.save(radio, repeater, password, passphrase, null, signal()), /changed in another tab/)
  await assert.rejects(vault.forget(radio, repeater, 'stale', signal()), /changed in another tab/)
  assert.equal(storage.getItem(repeaterCredentialKey(radio, repeater)), before)
})

test('concurrent changes are not deleted and abort prevents a delayed replacement', async () => {
  const storage = new MemoryStorage()
  const locks = new Locks()
  const normal = new RepeaterCredentialVault(storage, locks, webcrypto)
  await normal.save(radio, repeater, password, passphrase, null, signal())
  const original = storage.getItem(repeaterCredentialKey(radio, repeater))
  let release
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const delayedCrypto = {
    getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
    subtle: new Proxy(webcrypto.subtle, { get(target, name) {
      if (name === 'deriveKey') return async (...args) => { started(); await gate; return target.deriveKey(...args) }
      const property = Reflect.get(target, name, target)
      return typeof property === 'function' ? property.bind(target) : property
    } }),
  }
  const vault = new RepeaterCredentialVault(storage, locks, delayedCrypto)
  const saving = vault.save(radio, repeater, 'NewSecret!', passphrase, original, signal())
  await entered
  const forgetting = vault.forget(radio, repeater, original, signal())
  release()
  await saving
  await assert.rejects(forgetting, /changed in another tab/)
  assert.equal(await normal.unlock(radio, repeater, passphrase, signal()), 'NewSecret!')

  const before = storage.getItem(repeaterCredentialKey(radio, repeater))
  let releaseAgain
  let startedAgain
  const enteredAgain = new Promise((resolve) => { startedAgain = resolve })
  const gateAgain = new Promise((resolve) => { releaseAgain = resolve })
  const secondCrypto = {
    getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
    subtle: new Proxy(webcrypto.subtle, { get(target, name) {
      if (name === 'deriveKey') return async (...args) => { startedAgain(); await gateAgain; return target.deriveKey(...args) }
      const property = Reflect.get(target, name, target)
      return typeof property === 'function' ? property.bind(target) : property
    } }),
  }
  const controller = new AbortController()
  const replacing = new RepeaterCredentialVault(storage, locks, secondCrypto)
    .save(radio, repeater, password, passphrase, before, controller.signal)
  await enteredAgain
  controller.abort(new Error('Stopped'))
  releaseAgain()
  await assert.rejects(replacing, /Stopped/)
  assert.equal(storage.getItem(repeaterCredentialKey(radio, repeater)), before)

  const interruptedCrypto = {
    getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
    subtle: new Proxy(webcrypto.subtle, { get(target, name) {
      if (name === 'encrypt') return async (...args) => {
        storage.removeItem(repeaterCredentialKey(radio, repeater))
        return target.encrypt(...args)
      }
      const property = Reflect.get(target, name, target)
      return typeof property === 'function' ? property.bind(target) : property
    } }),
  }
  await assert.rejects(
    new RepeaterCredentialVault(storage, locks, interruptedCrypto).save(radio, repeater, password, passphrase, before, signal()),
    /changed while saving/,
  )
  assert.equal(storage.getItem(repeaterCredentialKey(radio, repeater)), null)
})
