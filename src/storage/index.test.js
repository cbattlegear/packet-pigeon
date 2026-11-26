import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { openRadioStorage, radioKeyFromPublicKey, validChannelScopeSettings } from './index.ts'

const firstRadio = radioKeyFromPublicKey('ab'.repeat(32))
const secondRadio = radioKeyFromPublicKey('cd'.repeat(32))
const message = {
  id: 'incoming-1',
  conversationId: 'channel:0',
  sender: 'Pigeon',
  timestamp: 100,
  text: 'Hello',
}

test('channel notification modes survive sync and pause on slot reuse', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Public' }] })
  await storage.update(firstRadio, { channelNotification: { index: 0, channelName: 'Public', mode: 'mentions' } })
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Public' }] })
  assert.equal((await storage.read(firstRadio)).channelNotifications[0].mode, 'mentions')
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Other' }] })
  assert.equal((await storage.read(firstRadio)).channelNotifications[0].paused, true)
  await assert.rejects(storage.update(firstRadio, { channelNotification: { index: 0, channelName: 'Public', mode: 'all' } }))
  await storage.update(firstRadio, { channelNotification: { index: 0, channelName: 'Other', mode: 'muted' } })
  assert.deepEqual((await storage.read(firstRadio)).channelNotifications, [{ index: 0, channelName: 'Other', mode: 'muted' }])
  storage.close()
})

test('direct mute is scoped to the radio and sender prefix', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const conversationId = `direct:${secondRadio}`
  await storage.update(firstRadio, { directNotification: { conversationId, muted: true } })
  assert.deepEqual((await storage.read(firstRadio)).mutedDirectConversations, [`direct:${secondRadio.slice(0, 12)}`])
  await storage.update(firstRadio, { directNotification: { conversationId: `direct:${secondRadio.slice(0, 12)}`, muted: false } })
  assert.deepEqual((await storage.read(firstRadio)).mutedDirectConversations, [])
  assert.equal(await storage.read(secondRadio), null)
  storage.close()
})

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

test('channel retention prunes only expired dated entries for the configured radio and slot', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const otherTab = await openRadioStorage(factory)
  const day = 86_400_000
  const now = 2_000_000_000_000
  const channel = (id, index, timestamp) => ({
    ...message, id, conversationId: `channel:${index}`, timestamp,
  })
  const messages = [
    channel('old', 0, now - 2 * day),
    channel('boundary', 0, now - day),
    channel('undated', 0, null),
    channel('zero', 0, 0),
    channel('future', 0, now + day),
    channel('other-old', 1, now - 8 * day),
    { ...channel('direct', 0, now - 100 * day), conversationId: `direct:${secondRadio}` },
    { ...channel('unknown', 0, now - 100 * day), conversationId: 'unsupported' },
  ]
  const channels = [{ index: 0, name: 'Public' }, { index: 1, name: 'Private' }]
  await storage.update(firstRadio, {
    channels, messages, markRead: ['old', 'boundary', 'other-old'],
    draft: { conversationId: 'channel:0', text: 'Keep me' },
  })
  await storage.update(secondRadio, { channels, messages: [messages[0]] })
  await storage.update(firstRadio, { channelRetention: { index: 0, channelName: 'Public', days: 1 } })
  await storage.update(firstRadio, { channelRetention: { index: 1, channelName: 'Private', days: 7 } })
  await Promise.all([
    storage.update(firstRadio, { channels, preferences: { selectedConversationId: 'channel:0' } }),
    otherTab.update(firstRadio, { blockedChannelSender: { name: 'Alice', blocked: true } }),
  ])
  assert.equal(await storage.pruneChannelMessages(now), 2)
  const result = await storage.read(firstRadio)
  assert.deepEqual(result.messages.map(({ id }) => id), ['boundary', 'undated', 'zero', 'future', 'direct', 'unknown'])
  assert.deepEqual(result.readMessages, ['boundary'])
  assert.deepEqual(result.drafts, [{ conversationId: 'channel:0', text: 'Keep me' }])
  assert.deepEqual(result.blockedChannelSenders, ['Alice'])
  assert.equal(result.preferences.selectedConversationId, 'channel:0')
  assert.deepEqual((await storage.read(secondRadio)).messages, [messages[0]])
  assert.equal(await storage.pruneChannelMessages(now), 0)
  storage.close()
  otherTab.close()
})

test('retention follows local renames but pauses on an unexpected slot name and clears on removal', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const otherTab = await openRadioStorage(factory)
  const now = 2_000_000_000_000
  const old = { ...message, timestamp: now - 2 * 86_400_000 }
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Public' }], messages: [old] })
  await storage.update(firstRadio, { channelRetention: { index: 0, channelName: 'Public', days: 1 } })
  await otherTab.update(firstRadio, { channelRetentionRename: { index: 0, from: 'Public', to: 'Renamed' } })
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Renamed' }] })
  assert.deepEqual((await storage.read(firstRadio)).channelRetention, [{ index: 0, channelName: 'Renamed', days: 1 }])
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Replacement' }] })
  assert.equal(await storage.pruneChannelMessages(now), 0)
  assert.deepEqual((await storage.read(firstRadio)).messages, [old])
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Renamed' }] })
  assert.deepEqual((await storage.read(firstRadio)).channelRetention,
    [{ index: 0, channelName: 'Renamed', days: 1, paused: true }])
  assert.equal(await storage.pruneChannelMessages(now), 0)
  assert.deepEqual((await storage.read(firstRadio)).messages, [old])
  await otherTab.update(firstRadio, { channelRetentionRename: { index: 0, from: 'Renamed', to: 'Other' } })
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Other' }] })
  assert.equal(await storage.pruneChannelMessages(now), 0)
  assert.deepEqual((await storage.read(firstRadio)).messages, [old])
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Replacement' }] })
  await assert.rejects(storage.update(firstRadio, {
    channelRetention: { index: 0, channelName: 'Renamed', days: 1 },
  }), { code: 'update' })
  await assert.rejects(storage.update(firstRadio, {
    channelRetention: { index: 0, channelName: 'Replacement', days: 2 },
  }), { code: 'update' })
  await storage.update(firstRadio, { channelRetention: { index: 0, channelName: 'Replacement', days: 7 } })
  assert.deepEqual((await storage.read(firstRadio)).channelRetention,
    [{ index: 0, channelName: 'Replacement', days: 7 }])
  await storage.update(firstRadio, { channels: [] })
  assert.deepEqual((await storage.read(firstRadio)).channelRetention, [])
  assert.equal(await storage.pruneChannelMessages(now), 0)
  assert.deepEqual((await storage.read(firstRadio)).messages, [old])
  storage.close()
  otherTab.close()
})

test('invalid saved retention aborts cleanup without deleting another radio’s messages', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const now = 2_000_000_000_000
  const old = { ...message, timestamp: now - 2 * 86_400_000 }
  const initial = { channels: [{ index: 0, name: 'Public' }], messages: [old] }
  await storage.update(firstRadio, initial)
  await storage.update(secondRadio, initial)
  await storage.update(firstRadio, { channelRetention: { index: 0, channelName: 'Public', days: 1 } })
  const raw = await new Promise((resolve, reject) => {
    const request = factory.open('packet-pigeon', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const transaction = raw.transaction('radios', 'readwrite')
    const store = transaction.objectStore('radios')
    const request = store.get(secondRadio)
    request.onsuccess = () => {
      request.result.channelRetention = [{ index: 0, channelName: 'Public', days: 1, paused: 'yes' }]
      store.put(request.result, secondRadio)
    }
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error)
  })
  raw.close()
  await assert.rejects(storage.pruneChannelMessages(now), {
    code: 'update', message: new RegExp(`radio ${secondRadio.slice(0, 12)}`),
  })
  assert.deepEqual((await storage.read(firstRadio)).messages, [old])
  assert.deepEqual((await storage.read(secondRadio)).messages, [old])
  await storage.update(secondRadio, { resetChannelRetention: true })
  assert.equal(await storage.pruneChannelMessages(now), 1)
  assert.deepEqual((await storage.read(firstRadio)).messages, [])
  assert.deepEqual((await storage.read(secondRadio)).messages, [old])
  storage.close()
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

test('channel sends allocate per-radio timestamps and keep retention, drafts, and receipts isolated', async () => {
    const factory = new IDBFactory()
    const storage = await openRadioStorage(factory)
    const other = await openRadioStorage(factory)
    const channels = [{ index: 0, name: 'Public' }]
    const old = { ...message, conversationId: 'channel:0' }
    await storage.update(firstRadio, {
      channels, messages: [old], markRead: [old.id],
      draft: { conversationId: 'channel:0', text: 'Keep my newer draft' },
      channelRetention: { index: 0, channelName: 'Public', days: 7 },
      blockedChannelSender: { name: 'Alice', blocked: true },
    })

    await storage.update(secondRadio, { channels, messages: [old] })
    const begin = (id) => ({
      kind: 'begin', id, index: 0, channelName: 'Public', senderName: 'Pigeon',
      firmwareProtocolVersion: 14,
      text: 'Hello', now: 1_000_000, clearDraft: true,
    })
    const [first, second] = await Promise.all([
      storage.changeChannelMessage(firstRadio, begin('first')),
      other.changeChannelMessage(firstRadio, begin('second')),
    ])
    assert.deepEqual([first.message.channelOutgoing.wireTimestamp, second.message.channelOutgoing.wireTimestamp].sort(), [1000, 1001])
    const separate = await storage.changeChannelMessage(secondRadio, begin('other'))
    assert.equal(separate.message.channelOutgoing.wireTimestamp, 1000)
    await assert.rejects(storage.changeChannelMessage(firstRadio, { kind: 'remove', id: 'first' }), /Wait for sending/)
    await storage.changeChannelMessage(firstRadio, {
      kind: 'accepted', id: 'first', wireTimestamp: first.message.channelOutgoing.wireTimestamp,
    })
    await storage.changeChannelMessage(firstRadio, { kind: 'remove', id: old.id })
    const data = await storage.read(firstRadio)
    assert.deepEqual(data.channelRetention, [{ index: 0, channelName: 'Public', days: 7 }])
    assert.deepEqual(data.blockedChannelSenders, ['Alice'])
    assert.deepEqual(data.readMessages, [])
    assert.deepEqual(data.drafts, [{ conversationId: 'channel:0', text: 'Keep my newer draft' }])
    assert.deepEqual((await storage.read(secondRadio)).messages.map(({ id }) => id), [old.id, 'other'])
    await assert.rejects(storage.changeChannelMessage(firstRadio, { ...begin('stale'), channelName: 'Changed' }), /channel changed/i)
    storage.close()
    other.close()
})

test('scope settings and recovery markers preserve concurrent cache writes and radio isolation', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const other = await openRadioStorage(factory)
  const channels = [{ index: 0, name: 'Public' }]
  await storage.update(firstRadio, { channels, messages: [message], draft: { conversationId: 'channel:0', text: 'Hello' } })
  await storage.update(secondRadio, { channels })
  await Promise.all([
    storage.update(firstRadio, { scopeRecovery: true, channelScope: { index: 0, channelName: 'Public', scope: { mode: 'region', name: 'North' } } }),
    other.update(firstRadio, { channels, channelRetention: { index: 0, channelName: 'Public', days: 30 } }),
    other.update(firstRadio, { blockedChannelSender: { name: 'Alice', blocked: true } }),
  ])
  const begin = { kind: 'begin', id: 'scoped', index: 0, channelName: 'Public', senderName: 'Pigeon',
    text: 'Hello', now: 100_000, clearDraft: true, firmwareProtocolVersion: 8 }
  const result = await storage.changeChannelMessage(firstRadio, begin)
  assert.deepEqual(result.message.channelOutgoing.scope, { mode: 'region', name: '#North' })
  await other.update(firstRadio, { channelScope: { index: 0, channelName: 'Public', scope: { mode: 'unscoped' } } })
  assert.deepEqual((await storage.read(firstRadio)).messages.at(-1).channelOutgoing.scope, { mode: 'region', name: '#North' })
  await assert.rejects(storage.changeChannelMessage(firstRadio, { ...begin, id: 'unsupported', firmwareProtocolVersion: 11 }), /v12/)
  const data = await storage.read(firstRadio)
  assert.equal(data.scopeRecovery, true)
  assert.deepEqual(data.blockedChannelSenders, ['Alice'])
  assert.deepEqual(data.channelRetention, [{ index: 0, channelName: 'Public', days: 30 }])
  assert.equal(data.messages.length, 2)
  const separate = await storage.changeChannelMessage(secondRadio, { ...begin, id: 'default' })
  assert.deepEqual(separate.message.channelOutgoing.scope, { mode: 'default' })
  assert.equal((await storage.read(secondRadio)).scopeRecovery, undefined)
  storage.close()
  other.close()
})

test('an observed name change permanently pauses a slot scope until explicitly chosen again', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  await storage.update(firstRadio, {
    channels: [{ index: 0, name: 'Public' }],
    channelScope: { index: 0, channelName: 'Public', scope: { mode: 'region', name: '#North' } },
    draft: { conversationId: 'channel:0', text: 'Keep me' },
  })
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Replacement' }] })
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Public' }] })
  const begin = { kind: 'begin', id: 'paused', index: 0, channelName: 'Public', senderName: 'Pigeon',
    text: 'Keep me', now: 100_000, clearDraft: true, firmwareProtocolVersion: 14 }
  await assert.rejects(storage.changeChannelMessage(firstRadio, begin), /scope is paused/)
  assert.deepEqual((await storage.read(firstRadio)).drafts, [{ conversationId: 'channel:0', text: 'Keep me' }])
  await assert.rejects(storage.update(firstRadio, { channelScope: { index: 0, channelName: 'Stale', scope: { mode: 'default' } } }), /changed/)
  await storage.update(firstRadio, { channelScope: { index: 0, channelName: 'Public', scope: { mode: 'default' } } })
  assert.deepEqual((await storage.changeChannelMessage(firstRadio, begin)).message.channelOutgoing.scope, { mode: 'default' })
  await storage.update(firstRadio, { channelScope: { index: 0, channelName: 'Public', scope: { mode: 'unscoped' } } })
  await storage.update(firstRadio, { channels: [] })
  assert.deepEqual((await storage.read(firstRadio)).channelScopes, [])
  assert.equal(validChannelScopeSettings([{ index: 0, channelName: 'Public', scope: { mode: 'region', name: '\0' } }]), false)
  assert.equal(validChannelScopeSettings([
    { index: 0, channelName: 'Public', scope: { mode: 'default' } }, { index: 0, channelName: 'Public', scope: { mode: 'unscoped' } },
  ]), false)
  storage.close()
})

test('scope markers require strict durability before completing the write', async (t) => {
  const storage = await openRadioStorage(new IDBFactory())
  const transaction = IDBDatabase.prototype.transaction
  const durability = []
  const intercepted = t.mock.method(IDBDatabase.prototype, 'transaction', function (stores, mode, options) {
    if (mode === 'readwrite') durability.push(options?.durability)
    return transaction.call(this, stores, mode, options)
  })
  await storage.update(firstRadio, { scopeRecovery: true })
  await storage.update(firstRadio, { channels: [{ index: 0, name: 'Public' }] })
  await storage.update(firstRadio, { scopeRecovery: false })
  assert.deepEqual(durability, ['strict', undefined, 'strict'])
  intercepted.mock.restore()
  const unsupported = t.mock.method(IDBDatabase.prototype, 'transaction', function (stores, mode) {
    return transaction.call(this, stores, mode, { durability: 'relaxed' })
  })
  await assert.rejects(storage.update(firstRadio, { scopeRecovery: true }), /cannot durably save/)
  assert.equal((await storage.read(firstRadio)).scopeRecovery, false)
  unsupported.mock.restore()
  storage.close()
})
