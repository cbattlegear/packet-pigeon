import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { SessionCache } from './session-cache.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'

class FixtureSession {
  snapshot = { phase: 'idle', error: null, device: null, contacts: [], channels: [], messages: [], progress: null }
  listeners = new Set()
  getSnapshot = () => this.snapshot
  subscribe = (listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(update) {
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for cache update')
}

test('persists completed syncs and retries original receipts under their captured radio key', async () => {
  const factory = new IDBFactory()
  const session = new FixtureSession()
  const firstKey = 'ab'.repeat(32)
  const secondKey = 'cd'.repeat(32)
  const attempts = []
  let fail = true
  const cache = new SessionCache(session, async () => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      update: async (key, update) => {
        attempts.push({ key, update })
        if (fail) {
          fail = false
          throw new Error('Disk unavailable')
        }
        return storage.update(key, update)
      },
    }
  })

  const contact = {
    publicKey: secondKey, name: 'Contact', type: 1, flags: 2, pathLength: 0,
    pathHex: '', lastAdvertisedAt: 4, latitude: 0, longitude: 0, lastModifiedAt: 5,
  }
  const first = {
    receiptId: 'receipt-one', kind: 'channel-text', channelIndex: 0,
    pathLength: 1, snrDb: 2, textType: 0, senderTimestamp: 123, text: 'same',
  }
  const second = { ...first, receiptId: 'receipt-two' }
  const data = {
    receiptId: 'receipt-three', kind: 'channel-data', channelIndex: 0,
    pathLength: 0, snrDb: null, dataType: 4, dataHex: 'aabb',
  }

  session.emit({ phase: 'handshake' })
  session.emit({ phase: 'syncing', device: { publicKey: firstKey }, progress: { stage: 'contacts' }, contacts: [contact] })
  assert.equal(cache.getSnapshot().pending, 0, 'partial contacts must not replace the cache')
  session.emit({ progress: { stage: 'channels' } })
  await waitFor(() => cache.getSnapshot().error !== null)
  session.emit({ channels: [{ index: 0, name: 'Public' }], progress: { stage: 'messages' } })
  session.emit({ messages: [first] })
  session.emit({ messages: [first, second, data] })
  session.emit({ phase: 'error' })

  session.emit({ phase: 'handshake', device: null, contacts: [], channels: [], messages: [], progress: null })
  session.emit({ phase: 'syncing', device: { publicKey: secondKey }, progress: { stage: 'channels' }, contacts: [] })
  cache.retry()
  await waitFor(() => cache.getSnapshot().pending === 0 && !cache.getSnapshot().saving)
  assert.equal(cache.getSnapshot().error, null)
  assert.deepEqual(attempts[0], attempts[1], 'retry must keep its captured update and key')

  const storage = await openRadioStorage(factory)
  const firstData = await storage.read(radioKeyFromPublicKey(firstKey))
  const secondData = await storage.read(radioKeyFromPublicKey(secondKey))
  assert.equal(firstData.contacts[0].details.lastModifiedAt, 5)
  assert.deepEqual(firstData.channels, [{ index: 0, name: 'Public' }])
  assert.deepEqual(firstData.messages.map(({ id }) => id), ['receipt-one', 'receipt-two', 'receipt-three'])
  assert.deepEqual(firstData.messages.map(({ receipt }) => receipt), [first, second, data])
  assert.equal(firstData.messages[2].timestamp, null)
  assert.deepEqual(secondData.messages, [])
  assert.deepEqual(secondData.contacts, [])
  storage.close()
})

test('persists changed channel lists without replacing messages or local preferences', async () => {
  const factory = new IDBFactory()
  const session = new FixtureSession()
  const cache = new SessionCache(session, () => openRadioStorage(factory))
  const key = radioKeyFromPublicKey('ab'.repeat(32))
  const storage = await openRadioStorage(factory)
  await storage.update(key, {
    channels: [{ index: 0, name: 'Public' }],
    channelRetention: { index: 0, channelName: 'Public', days: 30 },
    preferences: { selectedConversationId: 'channel:0' },
    messages: [{ id: 'm', conversationId: 'channel:0', sender: '', timestamp: 1, text: 'saved' }],
  })
  session.emit({ phase: 'handshake' })
  session.emit({ phase: 'ready', device: { publicKey: key }, channels: [{ index: 0, name: 'Public' }] })
  await waitFor(() => !cache.getSnapshot().saving && !cache.getSnapshot().pending)
  session.emit({ channels: [{ index: 0, name: 'Renamed' }, { index: 1, name: '#topic' }] })
  await waitFor(() => !cache.getSnapshot().saving && !cache.getSnapshot().pending)
  const data = await storage.read(key)
  assert.deepEqual(data.channels, [{ index: 0, name: 'Renamed' }, { index: 1, name: '#topic' }])
  assert.equal(data.messages[0].text, 'saved')
  assert.equal(data.preferences.selectedConversationId, 'channel:0')
  assert.deepEqual(data.channelRetention, [{ index: 0, channelName: 'Public', days: 30, paused: true }])
  storage.close()
})

test('local retention rename waits for queued channel snapshots', async () => {
  const factory = new IDBFactory()
  const session = new FixtureSession()
  const key = radioKeyFromPublicKey('ab'.repeat(32))
  const otherKey = radioKeyFromPublicKey('cd'.repeat(32))
  const storage = await openRadioStorage(factory)
  for (const radio of [key, otherKey]) {
    await storage.update(radio, {
      channels: [{ index: 0, name: 'Public' }],
      channelRetention: { index: 0, channelName: 'Public', days: 30 },
    })
  }
  let release
  let entered
  const blocked = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const cache = new SessionCache(session, async () => {
    const connection = await openRadioStorage(factory)
    return {
      ...connection,
      update: async (radio, update) => {
        if (update.channels) { entered(); await blocked }
        return connection.update(radio, update)
      },
    }
  })
  session.emit({ phase: 'handshake' })
  session.emit({ phase: 'ready', device: { publicKey: key }, channels: [{ index: 0, name: 'Public' }] })
  await started
  const renamed = cache.renameChannelRetention(key, { index: 0, from: 'Public', to: 'Renamed' })
  release()
  await renamed
  session.emit({ channels: [{ index: 0, name: 'Renamed' }] })
  await waitFor(() => !cache.getSnapshot().saving && !cache.getSnapshot().pending)
  assert.deepEqual((await storage.read(key)).channelRetention, [{ index: 0, channelName: 'Renamed', days: 30 }])
  assert.deepEqual((await storage.read(otherKey)).channelRetention, [{ index: 0, channelName: 'Public', days: 30 }])
  storage.close()
})

test('a failed queued cache write rejects and does not retry the retention migration later', async () => {
  const factory = new IDBFactory()
  const session = new FixtureSession()
  const key = radioKeyFromPublicKey('ab'.repeat(32))
  const storage = await openRadioStorage(factory)
  await storage.update(key, {
    channels: [{ index: 0, name: 'Public' }],
    channelRetention: { index: 0, channelName: 'Public', days: 30 },
  })
  let release
  let entered
  let fail = true
  const blocked = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const cache = new SessionCache(session, async () => {
    const connection = await openRadioStorage(factory)
    return {
      ...connection,
      update: async (radio, update) => {
        if (update.channels && fail) {
          entered()
          await blocked
          fail = false
          throw new Error('Disk unavailable')
        }
        return connection.update(radio, update)
      },
    }
  })
  session.emit({ phase: 'handshake' })
  session.emit({ phase: 'ready', device: { publicKey: key }, channels: [{ index: 0, name: 'Public' }] })
  await started
  const result = assert.rejects(cache.renameChannelRetention(key, { index: 0, from: 'Public', to: 'Renamed' }), /Disk unavailable/)
  release()
  await result
  session.emit({ channels: [{ index: 0, name: 'Renamed' }] })
  cache.retry()
  await waitFor(() => !cache.getSnapshot().saving && !cache.getSnapshot().pending)
  assert.equal(cache.getSnapshot().error, null)
  assert.deepEqual((await storage.read(key)).channelRetention,
    [{ index: 0, channelName: 'Public', days: 30, paused: true }])
  storage.close()
})

test('a failed retention migration does not block later channel caching', async () => {
  const factory = new IDBFactory()
  const session = new FixtureSession()
  const key = radioKeyFromPublicKey('ab'.repeat(32))
  const storage = await openRadioStorage(factory)
  await storage.update(key, {
    channels: [{ index: 0, name: 'Public' }],
    channelRetention: { index: 0, channelName: 'Public', days: 30 },
  })
  const cache = new SessionCache(session, async () => {
    const connection = await openRadioStorage(factory)
    return {
      ...connection,
      update: async (radio, update) => {
        if (update.channelRetentionRename) throw new Error('Retention write failed')
        return connection.update(radio, update)
      },
    }
  })
  session.emit({ phase: 'handshake' })
  session.emit({ phase: 'ready', device: { publicKey: key }, channels: [{ index: 0, name: 'Public' }] })
  await waitFor(() => !cache.getSnapshot().saving && !cache.getSnapshot().pending)
  await assert.rejects(cache.renameChannelRetention(key, { index: 0, from: 'Public', to: 'Renamed' }), /Retention write failed/)
  session.emit({ channels: [{ index: 0, name: 'Renamed' }] })
  await waitFor(() => !cache.getSnapshot().saving && !cache.getSnapshot().pending)
  assert.equal(cache.getSnapshot().error, null)
  assert.deepEqual((await storage.read(key)).channelRetention,
    [{ index: 0, channelName: 'Public', days: 30, paused: true }])
  storage.close()
})
