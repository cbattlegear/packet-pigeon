import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { expectedDirectAck } from '../radio/direct-message.ts'
import { openRadioStorage, radioKeyFromPublicKey, RadioStorageError } from '../storage/index.ts'
import { DirectMessages } from './direct-messages.ts'

const publicKey = 'ab'.repeat(32)
const key = radioKeyFromPublicKey(publicKey)
const recipient = 'bc'.repeat(32)
const options = { directAttempts: 2, floodAttempts: 1 }

class FixtureSource {
  snapshot = { phase: 'ready', device: { publicKey, name: 'Pigeon' } }
  listeners = new Set()
  pushes = new Set()
  sends = []
  channelSends = []
  resets = 0
  route = 'direct'
  onSend = async (send) => ({ route: this.route, expectedAck: send.code, timeoutMs: 1 })
  onChannelSend = async () => {}

  getSnapshot = () => this.snapshot
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeToPushes = (listener) => { this.pushes.add(listener); return () => this.pushes.delete(listener) }
  async sendDirect(sender, target, timestamp, attempt, text) {
    const send = { sender, target, timestamp, attempt, text, code: await expectedDirectAck(sender, timestamp, attempt, text) }
    this.sends.push(send)
    return this.onSend(send)
  }
  async sendChannel(sender, index, channel, senderName, timestamp, text) {
    const send = { sender, index, channel, senderName, timestamp, text }
    this.channelSends.push(send)
    return this.onChannelSend(send)
  }
  async resetDirectPath() {
    this.resets++
    this.route = 'flood'
  }
  ack(code, roundTripMs = 42) {
    const payload = new Uint8Array(8)
    payload.set(Buffer.from(code, 'hex'))
    new DataView(payload.buffer).setUint32(4, roundTripMs, true)
    for (const listener of this.pushes) listener({ code: 0x82, payload })
  }
  phase(phase) {
    this.snapshot = { ...this.snapshot, phase }
    for (const listener of this.listeners) listener()
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for direct-message state')
}

async function fixture(open) {
  const factory = new IDBFactory()
  const source = new FixtureSource()
  const openStorage = open ? () => open(factory) : () => openRadioStorage(factory)
  const direct = new DirectMessages(source, openStorage, () => 5)
  await direct.load(publicKey)
  return { factory, source, direct, openStorage }
}

test('a disconnected send reports an error and preserves the draft without creating a message', async () => {
  const { source, direct, openStorage } = await fixture()
  source.phase('idle')
  assert.equal(await direct.send(key, recipient, 'Keep this draft', options), false)
  assert.match(direct.getSnapshot().error, /Connect the selected radio/)
  const storage = await openStorage()
  const data = await storage.read(key)
  assert.equal(data.drafts[0].text, 'Keep this draft')
  assert.equal(data.messages.length, 0)
  assert.equal(source.sends.length, 0)
  storage.close()
})

test('invalid message text is reported without sending or clearing the draft', async () => {
  const { source, direct } = await fixture()
  for (const text of ['NUL\0inside', '\ud800']) {
    await direct.saveDraft(key, `direct:${recipient}`, text)
    assert.equal(await direct.send(key, recipient, text, options), false)
    assert.match(direct.getSnapshot().error, /valid UTF-8 bytes without NUL/)
    assert.equal(direct.draft(key, `direct:${recipient}`), text)
  }
  assert.equal(direct.getSnapshot().data.messages.length, 0)
  assert.equal(source.sends.length, 0)
})

test('draft edits kept for this visit survive switching caches without writing to storage', async () => {
  const { source, direct, openStorage } = await fixture()
  const conversationId = `direct:${recipient}`
  await direct.saveDraft(key, conversationId, 'Previously saved')
  await direct.saveDraft(key, conversationId, 'Only in this tab', false)
  source.phase('idle')
  assert.equal(await direct.send(key, recipient, 'Updated in this tab', options, false), false)
  await direct.load('cc'.repeat(32))
  await direct.load(key)
  assert.equal(direct.draft(key, conversationId), 'Updated in this tab')
  const storage = await openStorage()
  const data = await storage.read(key)
  assert.equal(data.drafts[0].text, 'Previously saved')
  assert.equal(data.messages.length, 0)
  storage.close()
})

test('a 158-byte message remains intact across all direct and flood attempts', async () => {
  const { source, direct } = await fixture()
  const text = 'é'.repeat(79)
  assert.equal(await direct.send(key, recipient, text, { directAttempts: 4, floodAttempts: 4 }), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  assert.deepEqual(source.sends.map(({ attempt }) => attempt), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.ok(source.sends.every((send) => send.text === text))
  assert.equal(source.resets, 1)
  assert.equal(direct.getSnapshot().data.messages[0].outgoing.status, 'failed')
})

test('retries through direct and flood attempts, then retries the same message with an early ACK', async () => {
  const { source, direct } = await fixture()
  const states = new Set()
  direct.subscribe(() => {
    const message = direct.getSnapshot().data?.messages[0]
    if (message?.outgoing) states.add(message.outgoing.status)
  })
  assert.equal(await direct.send(key, recipient, 'Hello', options), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  const failed = direct.getSnapshot().data.messages[0]
  assert.equal(failed.outgoing.status, 'failed')
  assert.equal(failed.outgoing.attempt, 3)
  assert.equal(failed.outgoing.route, 'flood')
  assert.deepEqual(source.sends.map((send) => send.attempt), [0, 1, 2])
  assert.equal(source.resets, 1)
  assert.ok(states.has('sending'))
  assert.ok(states.has('sent'))

  source.onSend = async (send) => {
    source.ack(send.code)
    return { route: 'direct', expectedAck: send.code, timeoutMs: 1 }
  }
  assert.equal(await direct.retry(key, failed.id, { directAttempts: 1, floodAttempts: 0 }), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  const delivered = direct.getSnapshot().data.messages[0]
  assert.equal(direct.getSnapshot().data.messages.length, 1)
  assert.equal(delivered.id, failed.id)
  assert.equal(delivered.outgoing.status, 'delivered')
  assert.equal(delivered.outgoing.roundTripMs, 42)
  assert.ok(delivered.outgoing.wireTimestamp > failed.outgoing.wireTimestamp)
})

test('cancellation stops further attempts and a later acknowledgement still delivers the message', async () => {
  const { source, direct } = await fixture()
  let finishSend
  source.onSend = (send) => new Promise((resolve) => {
    finishSend = () => resolve({ route: 'direct', expectedAck: send.code, timeoutMs: 1 })
  })
  assert.equal(await direct.send(key, recipient, 'Cancel me', options), true)
  await waitFor(() => typeof finishSend === 'function')
  direct.cancel()
  finishSend()
  await waitFor(() => direct.getSnapshot().activeId === null)
  assert.equal(source.sends.length, 1)
  assert.match(direct.getSnapshot().data.messages[0].outgoing.error, /Cancelled/)
  source.ack(source.sends[0].code)
  await waitFor(() => direct.getSnapshot().data.messages[0].outgoing.status === 'delivered')
})

test('does not trust an early ACK when the radio returns a different expected code', async () => {
  const { source, direct } = await fixture()
  source.onSend = async (send) => {
    source.ack(send.code)
    return { route: 'direct', expectedAck: 'deadbeef', timeoutMs: 1 }
  }
  await direct.send(key, recipient, 'Wrong ACK', options)
  await waitFor(() => direct.getSnapshot().activeId === null)
  const message = direct.getSnapshot().data.messages[0]
  assert.equal(message.outgoing.status, 'failed')
  assert.match(message.outgoing.error, /unexpected acknowledgement/)
  assert.equal(source.sends.length, 1)
})

test('stops after a post-send storage failure and retries saved ACK updates without retransmitting', async () => {
  let failAccepted = true
  const { source, direct } = await fixture(async (factory) => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      changeDirect: async (target, change) => {
        if (failAccepted && change.kind === 'accepted') throw new RadioStorageError('write', 'Disk unavailable')
        return storage.changeDirect(target, change)
      },
    }
  })
  source.onSend = async (send) => {
    source.ack(send.code)
    return { route: 'direct', expectedAck: send.code, timeoutMs: 1 }
  }
  await direct.send(key, recipient, 'Save the ACK', options)
  await waitFor(() => direct.getSnapshot().activeId === null)
  assert.equal(source.sends.length, 1)
  assert.ok(direct.getSnapshot().pending > 0)
  failAccepted = false
  await direct.retrySaving()
  assert.equal(direct.getSnapshot().pending, 0)
  assert.equal(direct.getSnapshot().data.messages[0].outgoing.status, 'delivered')
  assert.equal(source.sends.length, 1)
})

test('keeps unsaved draft edits in memory until a successful save', async () => {
  let failDraft = true
  const { direct, openStorage } = await fixture(async (factory) => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      update: async (target, update) => {
        if (failDraft && update.draft) throw new RadioStorageError('write', 'Disk unavailable')
        return storage.update(target, update)
      },
    }
  })
  const conversation = `direct:${recipient}`
  await assert.rejects(direct.saveDraft(key, conversation, 'Unsaved text'), /Disk unavailable/)
  assert.equal(direct.draft(key, conversation), 'Unsaved text')
  assert.equal(direct.getSnapshot().pending, 1)
  failDraft = false
  await direct.retrySaving()
  const storage = await openStorage()
  assert.equal((await storage.read(key)).drafts[0].text, 'Unsaved text')
  assert.equal(direct.getSnapshot().pending, 0)
  storage.close()
})

test('interrupted messages require manual retry, but retain late ACK matching', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const sendOptions = { directAttempts: 1, floodAttempts: 0 }
  const started = await storage.changeDirect(key, {
    kind: 'begin', id: 'interrupted', recipient, text: 'Hello', options: sendOptions, now: 100_000,
  })
  const timestamp = started.message.outgoing.wireTimestamp
  const code = await expectedDirectAck(publicKey, timestamp, 0, 'Hello')
  await storage.changeDirect(key, { kind: 'attempt', id: 'interrupted', wireTimestamp: timestamp, attempt: 1, code })
  await storage.changeDirect(key, { kind: 'accepted', id: 'interrupted', wireTimestamp: timestamp, attempt: 1, code, route: 'direct' })
  storage.close()

  const source = new FixtureSource()
  const direct = new DirectMessages(source, () => openRadioStorage(factory), () => 5)
  await direct.load(publicKey)
  assert.equal(direct.getSnapshot().data.messages[0].outgoing.status, 'failed')
  assert.equal(source.sends.length, 0)
  source.ack(code)
  await waitFor(() => direct.getSnapshot().data.messages[0].outgoing.status === 'delivered')
})

test('channel messages are saved before radio acceptance and resends preserve the current draft', async () => {
  const { source, direct, openStorage } = await fixture()
  const storage = await openStorage()
  await storage.update(key, { channels: [{ index: 0, name: 'Public' }] })
  await direct.load(publicKey)
  source.onChannelSend = async () => {
    const data = await storage.read(key)
    assert.equal(data.messages.at(-1).channelOutgoing.status, 'sending')
  }
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'Hello'), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  let data = await storage.read(key)
  assert.equal(data.messages[0].channelOutgoing.status, 'accepted')
  assert.equal(data.messages[0].outgoing, undefined)
  assert.deepEqual(source.channelSends.map(({ channel, senderName, text }) => ({ channel, senderName, text })),
    [{ channel: 'Public', senderName: 'Pigeon', text: 'Hello' }])
  await direct.saveDraft(key, 'channel:0', 'A different draft')
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'Hello', true, true), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  data = await storage.read(key)
  assert.equal(data.messages.length, 2)
  assert.ok(data.messages[1].channelOutgoing.wireTimestamp > data.messages[0].channelOutgoing.wireTimestamp)
  assert.deepEqual(data.drafts, [{ conversationId: 'channel:0', text: 'A different draft' }])
  storage.close()
})

test('channel sending preserves drafts on disconnect or invalid bytes and marks ambiguous outcomes', async () => {
  const { source, direct, openStorage } = await fixture()
  const storage = await openStorage()
  await storage.update(key, { channels: [{ index: 0, name: 'Public' }] })
  await direct.load(publicKey)
  source.phase('idle')
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'Keep me'), false)
  assert.equal(direct.draft(key, 'channel:0'), 'Keep me')
  assert.equal(source.channelSends.length, 0)
  source.phase('ready')
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'a'.repeat(153)), false)
  assert.equal(source.channelSends.length, 0)
  source.onChannelSend = async () => { throw new Error('Response timed out') }
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'Maybe sent'), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  const message = (await storage.read(key)).messages[0]
  assert.equal(message.channelOutgoing.status, 'uncertain')
  assert.match(message.channelOutgoing.error, /may have been transmitted/)
  storage.close()
})

test('failed channel outcome persistence retries without retransmission', async () => {
  let failAccepted = true
  const { source, direct, openStorage } = await fixture(async (factory) => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      changeChannelMessage: async (radio, change) => {
        if (failAccepted && change.kind === 'accepted') {
          failAccepted = false
          throw new RadioStorageError('write', 'Disk unavailable')
        }
        return storage.changeChannelMessage(radio, change)
      },
    }
  })
  const storage = await openStorage()
  await storage.update(key, { channels: [{ index: 0, name: 'Public' }] })
  await direct.load(publicKey)
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'Hello'), true)
  await waitFor(() => direct.getSnapshot().activeId === null)
  assert.equal(direct.getSnapshot().pending, 1)
  assert.equal(source.channelSends.length, 1)
  await direct.retrySaving()
  assert.equal(direct.getSnapshot().pending, 0)
  assert.equal((await storage.read(key)).messages[0].channelOutgoing.status, 'accepted')
  assert.equal(source.channelSends.length, 1)
  storage.close()
})

test('a late channel send outcome stays under its captured radio identity', async () => {
  const { source, direct, openStorage } = await fixture()
  const storage = await openStorage()
  const otherKey = radioKeyFromPublicKey('cd'.repeat(32))
  await storage.update(key, { channels: [{ index: 0, name: 'Public' }] })
  await storage.update(otherKey, { channels: [{ index: 0, name: 'Other' }] })
  await direct.load(key)
  let release
  let entered
  const blocked = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  source.onChannelSend = async () => { entered(); await blocked }
  assert.equal(await direct.sendChannel(key, 0, 'Public', 'Hello'), true)
  await started
  source.phase('idle')
  source.snapshot = { phase: 'ready', device: { publicKey: otherKey, name: 'Other' } }
  source.phase('ready')
  await direct.load(otherKey)
  release()
  await waitFor(() => direct.getSnapshot().activeId === null)
  assert.equal((await storage.read(key)).messages[0].channelOutgoing.status, 'accepted')
  assert.deepEqual((await storage.read(otherKey)).messages, [])
  assert.equal(direct.getSnapshot().key, otherKey)
  storage.close()
})
