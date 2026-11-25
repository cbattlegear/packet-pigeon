import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { openRadioStorage, radioKeyFromPublicKey } from './index.ts'

const firstRadio = radioKeyFromPublicKey('ab'.repeat(32))
const secondRadio = radioKeyFromPublicKey('cd'.repeat(32))
const message = {
  id: 'incoming-1',
  conversationId: 'channel:0',
  sender: 'Pigeon',
  timestamp: 100,
  text: 'Hello',
}

test('requires a full public key and restores only the explicitly selected radio from an offline cache', async () => {
  assert.throws(() => radioKeyFromPublicKey('same radio name'), { code: 'identity' })
  assert.throws(() => radioKeyFromPublicKey(`${firstRadio}\n`), { code: 'identity' })
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  assert.equal(await storage.read(firstRadio), null)
  await storage.update(radioKeyFromPublicKey(firstRadio.toUpperCase()), {
    contacts: [{ publicKey: secondRadio, name: 'Pigeon' }],
    channels: [{ index: 0, name: 'Public', secret: 'do not persist' }],
    messages: [message],
    draft: { conversationId: 'channel:0', text: 'First draft' },
    preferences: { selectedConversationId: 'channel:0' },
  })
  await storage.update(secondRadio, { messages: [{ ...message, text: 'Second radio only' }] })
  storage.close()

  const offline = await openRadioStorage(factory)
  assert.deepEqual(await offline.listRadioKeys(), [firstRadio, secondRadio])
  assert.deepEqual(await offline.read(firstRadio), {
    contacts: [{ publicKey: secondRadio, name: 'Pigeon' }],
    channels: [{ index: 0, name: 'Public' }],
    messages: [message],
    drafts: [{ conversationId: 'channel:0', text: 'First draft' }],
    preferences: { selectedConversationId: 'channel:0' },
  })
  assert.deepEqual(await offline.read(secondRadio), {
    contacts: [],
    channels: [],
    messages: [{ ...message, text: 'Second radio only' }],
    drafts: [],
    preferences: null,
  })
  offline.close()
})

test('repeated and concurrent updates preserve new messages and independent local edits', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const otherTab = await openRadioStorage(factory)
  const sameTimestamp = { ...message, id: 'incoming-2' }
  await storage.update(firstRadio, {
    contacts: [{ publicKey: secondRadio, name: 'Pigeon' }],
    messages: [message, message],
    draft: { conversationId: 'channel:0', text: 'Old draft' },
  })
  await Promise.all([
    storage.update(firstRadio, { contacts: [], messages: [{ ...message, text: 'Replay' }, sameTimestamp] }),
    otherTab.update(firstRadio, { draft: { conversationId: 'channel:0', text: 'New draft' } }),
  ])
  assert.deepEqual(await storage.read(firstRadio), {
    contacts: [],
    channels: [],
    messages: [message, sameTimestamp],
    drafts: [{ conversationId: 'channel:0', text: 'New draft' }],
    preferences: null,
  })
  await storage.update(firstRadio, { draft: { conversationId: 'channel:0', text: null } })
  assert.deepEqual((await storage.read(firstRadio)).drafts, [])
  storage.close()
  otherTab.close()
})

test('an aborted write rejects, preserves the previous cache and can be retried', async (t) => {
  const storage = await openRadioStorage(new IDBFactory())
  await storage.update(firstRadio, { messages: [message] })
  const put = IDBObjectStore.prototype.put
  const intercepted = t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = put.apply(this, args)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  const update = {
    messages: [{ ...message, id: 'new' }],
    channels: [{ index: 0, name: 'New channel' }],
  }
  await assert.rejects(storage.update(firstRadio, update), { code: 'write' })
  const cached = await storage.read(firstRadio)
  assert.deepEqual(cached.messages, [message])
  assert.deepEqual(cached.channels, [])

  intercepted.mock.restore()
  await storage.update(firstRadio, update)
  assert.deepEqual((await storage.read(firstRadio)).messages, [message, ...update.messages])
  storage.close()
  await assert.rejects(storage.read(firstRadio), { code: 'read' })
})
