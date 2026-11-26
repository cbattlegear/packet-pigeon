import assert from 'node:assert/strict'
import test from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { openRadioStorage, radioKeyFromPublicKey } from './index.ts'

test('keeps names and favorites atomic and independent for each radio', async () => {
  const factory = new IDBFactory()
  const first = await openRadioStorage(factory)
  const second = await openRadioStorage(factory)
  const radioA = radioKeyFromPublicKey('ab'.repeat(32))
  const radioB = radioKeyFromPublicKey('bc'.repeat(32))
  const publicKey = 'cd'.repeat(32)
  const contact = { publicKey, name: 'Advertised name' }
  try {
    await first.update(radioA, { contacts: [contact] })
    await first.update(radioB, { contacts: [contact] })
    assert.equal((await first.read(radioA)).contactPreferences, undefined)
    await Promise.all([
      first.update(radioA, { contactPreference: { publicKey, customName: '  Local name  ' } }),
      second.update(radioA, { contactPreference: { publicKey: publicKey.toUpperCase(), favorite: true } }),
      second.update(radioB, { contactPreference: { publicKey, favorite: false } }),
    ])
    await first.update(radioA, { contacts: [contact] })
    assert.deepEqual((await second.read(radioA)).contactPreferences, [
      { publicKey, customName: 'Local name', favorite: true },
    ])
    assert.deepEqual((await first.read(radioB)).contactPreferences, [])
    await first.update(radioA, { contactPreference: { publicKey, customName: null } })
    assert.deepEqual((await first.read(radioA)).contactPreferences, [
      { publicKey, customName: null, favorite: true },
    ])
  } finally {
    first.close()
    second.close()
  }
})
