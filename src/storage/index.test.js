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

test('concurrent read markers preserve received entries for the selected radio', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const otherTab = await openRadioStorage(factory)
  const later = { ...message, id: 'later', region: 'Local region' }
  await storage.update(firstRadio, { messages: [message, later] })
  await storage.update(secondRadio, { messages: [message] })
  await storage.changeDirect(firstRadio, {
    kind: 'begin', id: 'sent', recipient: secondRadio, text: 'Outgoing',
    options: { directAttempts: 1, floodAttempts: 0 }, now: 100_000,
  })
  await Promise.all([
    storage.update(firstRadio, { markRead: [message.id, 'sent', 'unknown'] }),
    otherTab.update(firstRadio, { markRead: [later.id, message.id] }),
  ])
  const stored = await storage.read(firstRadio)
  assert.deepEqual(new Set(stored.readMessages), new Set([message.id, later.id]))
  assert.deepEqual(stored.messages.find(({ id }) => id === later.id), later)
  assert.equal((await storage.read(secondRadio)).readMessages, undefined)
  storage.close()
  otherTab.close()
})

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

test('blocked sender edits survive sync and concurrent local changes without crossing radios', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const otherTab = await openRadioStorage(factory)
  await storage.update(firstRadio, { blockedChannelSender: { name: 'Alice', blocked: true } })
  await Promise.all([
    storage.update(firstRadio, {
      channels: [{ index: 0, name: 'Public' }], messages: [message],
      preferences: { selectedConversationId: 'channel:0' },
    }),
    otherTab.update(firstRadio, { blockedChannelSender: { name: 'Bob', blocked: true } }),
  ])
  await storage.update(secondRadio, { blockedChannelSender: { name: 'Elsewhere', blocked: true } })
  await storage.update(firstRadio, { blockedChannelSender: { name: 'Alice', blocked: true } })
  const first = await storage.read(firstRadio)
  assert.deepEqual(new Set(first.blockedChannelSenders), new Set(['Alice', 'Bob']))
  assert.deepEqual(first.channels, [{ index: 0, name: 'Public' }])
  assert.deepEqual(first.messages, [message])
  assert.equal(first.preferences.selectedConversationId, 'channel:0')
  assert.deepEqual((await storage.read(secondRadio)).blockedChannelSenders, ['Elsewhere'])

  await assert.rejects(storage.update(firstRadio, {
    channels: [], blockedChannelSender: { name: 'invalid\nname', blocked: true },
  }), { code: 'update' })
  assert.deepEqual((await storage.read(firstRadio)).channels, [{ index: 0, name: 'Public' }])
  await Promise.all([
    storage.update(firstRadio, { markRead: [message.id] }),
    otherTab.update(firstRadio, { blockedChannelSender: { name: 'Alice', blocked: false } }),
  ])
  const updated = await storage.read(firstRadio)
  assert.deepEqual(updated.blockedChannelSenders, ['Bob'])
  assert.deepEqual(updated.readMessages, [message.id])
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

test('allocates distinct timestamps, preserves changed drafts and never downgrades delivery', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const options = { directAttempts: 1, floodAttempts: 0 }
  const conversationId = `direct:${secondRadio}`
  await storage.update(firstRadio, { draft: { conversationId, text: 'Newer draft' } })
  const first = await storage.changeDirect(firstRadio, {
    kind: 'begin', id: 'one', recipient: secondRadio, text: 'Hello', options, now: 100_000,
  })
  const second = await storage.changeDirect(firstRadio, {
    kind: 'begin', id: 'two', recipient: secondRadio, text: 'Hello', options, now: 100_000,
  })
  assert.equal(first.message.outgoing.wireTimestamp, 100)
  assert.equal(second.message.outgoing.wireTimestamp, 101)
  assert.deepEqual(second.data.drafts, [{ conversationId, text: 'Newer draft' }])

  const attempt = { id: 'one', wireTimestamp: 100, attempt: 1, code: 'aabbccdd' }
  await storage.changeDirect(firstRadio, { kind: 'attempt', ...attempt })
  await assert.rejects(storage.changeDirect(firstRadio, {
    kind: 'attempt', id: 'two', wireTimestamp: 101, attempt: 1, code: 'aabbccdd',
  }), /collides/)
  await storage.changeDirect(firstRadio, { kind: 'accepted', ...attempt, route: 'direct' })
  await storage.changeDirect(firstRadio, { kind: 'ack', code: 'aabbccdd', roundTripMs: 30 })
  await storage.changeDirect(firstRadio, { kind: 'failed', id: 'one', wireTimestamp: 100, error: 'late failure' })
  const delivered = (await storage.read(firstRadio)).messages.find((entry) => entry.id === 'one')
  assert.equal(delivered.outgoing.status, 'delivered')
  assert.equal(delivered.outgoing.roundTripMs, 30)
  assert.equal(delivered.outgoing.error, null)
  storage.close()
})

test('does not attribute provisional or ambiguous acknowledgement codes', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const options = { directAttempts: 1, floodAttempts: 0 }
  const begin = await storage.changeDirect(firstRadio, {
    kind: 'begin', id: 'one', recipient: secondRadio, text: 'Hello', options, now: 100_000,
  })
  await storage.changeDirect(firstRadio, {
    kind: 'attempt', id: 'one', wireTimestamp: 100, attempt: 1, code: '01020304',
  })
  const provisional = await storage.changeDirect(firstRadio, { kind: 'ack', code: '01020304', roundTripMs: 1 })
  assert.equal(provisional.message, null)
  assert.equal(provisional.data.messages[0].outgoing.status, 'sending')

  await storage.update(firstRadio, {
    messages: [{
      ...begin.message, id: 'other',
      outgoing: { ...begin.message.outgoing, acknowledgements: [{ code: '01020304', confirmed: true }] },
    }],
  })
  const ambiguous = await storage.changeDirect(firstRadio, { kind: 'ack', code: '01020304', roundTripMs: 1 })
  assert.equal(ambiguous.ambiguous, true)
  assert.deepEqual(ambiguous.data.messages.map((entry) => entry.outgoing.status), ['sending', 'sending'])
  storage.close()
})

test('a late send response retains an interrupted failure while enabling late ACK matching', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  await storage.changeDirect(firstRadio, {
    kind: 'begin', id: 'one', recipient: secondRadio, text: 'Hello',
    options: { directAttempts: 1, floodAttempts: 0 }, now: 100_000,
  })
  const attempt = { id: 'one', wireTimestamp: 100, attempt: 1, code: 'aabbccdd' }
  await storage.changeDirect(firstRadio, { kind: 'attempt', ...attempt })
  await storage.changeDirect(firstRadio, { kind: 'failed', id: 'one', wireTimestamp: 100, error: 'Interrupted' })
  const accepted = await storage.changeDirect(firstRadio, { kind: 'accepted', ...attempt, route: 'direct' })
  assert.equal(accepted.message.outgoing.status, 'failed')
  const acknowledged = await storage.changeDirect(firstRadio, { kind: 'ack', code: 'aabbccdd', roundTripMs: 1 })
  assert.equal(acknowledged.message.outgoing.status, 'delivered')
  storage.close()
})
