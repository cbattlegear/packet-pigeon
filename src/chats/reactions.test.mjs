import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import { buildReaction, dartStringHash, openReactionHash } from '../radio/reactions.ts'
import { canReactTo } from './reactions.ts'

const key = radioKeyFromPublicKey('ab'.repeat(32))
const other = radioKeyFromPublicKey('cd'.repeat(32))
const peer = '01'.repeat(32)
const stamp = 1704067200
const contact = { publicKey: peer, name: 'Peer', details: { type: 1 } }
function receipt(id, text, { channel = false, sender = peer.slice(0, 12), timestamp = stamp, textType = 0 } = {}) {
  return {
    id, conversationId: channel ? 'channel:1' : `direct:${sender}`, sender: '', text,
    timestamp: timestamp * 1000, rawHex: '1234',
    receipt: { kind: channel ? 'channel-text' : 'direct-text', receiptId: id, senderTimestamp: timestamp, textType,
      pathLength: 0xff, snrDb: null, ...(channel ? { channelIndex: 1 } : { senderKeyPrefix: sender, signatureHex: null }), text },
  }
}

test('native DM/channel receipts survive reload, match out of order, and summarize once per sender/emoji', async () => {
  const factory = new IDBFactory()
  let storage = await openRadioStorage(factory)
  const dm = await buildReaction('👍', 'ok', stamp, null)
  const channel = await buildReaction('❤️', 'ok', stamp, 'e\u0301')
  await storage.update(key, { contacts: [contact], channels: [{ index: 1, name: 'Test' }], messages: [
    receipt('dm-reaction', dm), receipt('channel-reaction', `Bob: ${channel}`, { channel: true }),
    receipt('duplicate', dm), receipt('second-reactor', `Carol: ${channel}`, { channel: true }),
  ] })
  assert.equal((await storage.read(key)).messages[0].reaction.state, 'unmatched')
  storage.close()
  storage = await openRadioStorage(factory)
  await storage.update(other, { contacts: [contact], messages: [receipt('dm', 'ok')] })
  await storage.update(key, { messages: [receipt('dm', 'ok'), receipt('channel', 'é: ok', { channel: true })] })
  const data = await storage.read(key)
  assert.deepEqual(data.messages.find(({ id }) => id === 'dm').reactions, [{ emoji: '👍', count: 1, senders: ['Peer'] }])
  assert.deepEqual(data.messages.find(({ id }) => id === 'channel').reactions,
    [{ emoji: '❤️', count: 2, senders: ['Bob', 'Carol'] }])
  assert.equal(data.messages.find(({ id }) => id === 'dm-reaction').rawHex, '1234')
  assert.equal(data.messages.length, 6)
  assert.equal((await storage.read(other)).messages[0].reactions, undefined)
  assert.equal(data.messages.find(({ id }) => id === 'channel-reaction').reaction.state, 'matched')
  storage.close()
})

test('all Open formats are retained before their targets arrive and reject ambiguous collisions', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const text = 'Hello from mesh'
  const v3 = `r:${openReactionHash(text, stamp, null)}:00`
  const v1 = `r:${stamp * 1000}_0_${dartStringHash(text)}:🔥`
  const channelV3 = `r:${openReactionHash(text, stamp, 'Peer')}:01`
  const channelV1 = `r:${stamp * 1000}_${dartStringHash('Peer')}_${dartStringHash(text)}:🎉`
  await storage.update(key, { contacts: [contact], messages: [
    receipt('v3', v3), receipt('v1', v1),
    receipt('cv3', `Bob: ${channelV3}`, { channel: true }),
    receipt('cv1', `Bob: ${channelV1}`, { channel: true }),
  ] })
  assert.ok((await storage.read(key)).messages.every(({ reaction }) => reaction.state === 'unmatched'))
  await storage.update(key, { messages: [receipt('target', text), receipt('channel', `Peer: ${text}`, { channel: true })] })
  let data = await storage.read(key)
  assert.equal(data.messages.find(({ id }) => id === 'target').reactions.length, 2)
  assert.equal(data.messages.find(({ id }) => id === 'channel').reactions.length, 2)
  await storage.update(key, { messages: [receipt('collision', 'Hello different content')] })
  data = await storage.read(key)
  assert.equal(data.messages.find(({ id }) => id === 'v3').reaction.state, 'ambiguous')
  assert.deepEqual(data.messages.find(({ id }) => id === 'target').reactions, [{ emoji: '🔥', count: 1, senders: ['Peer'] }])
  storage.close()
})

test('wrong channel, sender, type, contact, timestamp window and multiple matching receipts are not misapplied', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const reaction = await buildReaction('👍', 'ok', stamp, 'Alice')
  const dm = await buildReaction('👍', 'ok', stamp, null)
  await storage.update(key, { contacts: [contact], messages: [
    receipt('reaction', `Bob: ${reaction}`, { channel: true }), receipt('dm-reaction', dm),
    receipt('wrong-sender', 'Carol: ok', { channel: true }),
    { ...receipt('wrong-channel', 'Alice: ok', { channel: true }), conversationId: 'channel:2',
      receipt: { ...receipt('unused', '', { channel: true }).receipt, channelIndex: 2, text: 'Alice: ok' } },
    receipt('wrong-type', 'Alice: ok', { channel: true, textType: 1 }),
    receipt('wrong-contact', 'ok', { sender: '02'.repeat(6) }),
  ] })
  assert.equal((await storage.read(key)).messages[0].reaction.state, 'unmatched')
  assert.equal((await storage.read(key)).messages[1].reaction.state, 'unmatched')
  await storage.update(key, { messages: [receipt('first', 'Alice: ok', { channel: true }), receipt('second', 'Alice: ok', { channel: true })] })
  assert.equal((await storage.read(key)).messages[0].reaction.state, 'ambiguous')
  await storage.update(key, { messages: [
    receipt('old-open', `r:${(stamp - 301) * 1000}_0_${dartStringHash('ok')}:👍`), receipt('dm', 'ok'),
  ] })
  assert.equal((await storage.read(key)).messages.find(({ id }) => id === 'old-open').reaction.state, 'unmatched')
  await storage.update(key, { contacts: [contact, { ...contact, publicKey: peer.slice(0, 12) + 'ff'.repeat(26) }] })
  assert.equal((await storage.read(key)).messages.find(({ id }) => id === 'dm-reaction').reaction.state, 'ambiguous')
  assert.equal(canReactTo(receipt('management', 'ok', { textType: 1 })), false)
  storage.close()
})

test('a retried DM keeps reactions to its earlier transmitted wire timestamp', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  await storage.update(key, { contacts: [contact] })
  const options = { directAttempts: 1, floodAttempts: 0 }
  const begun = await storage.changeDirect(key, { kind: 'begin', id: 'out', recipient: peer, text: 'ok', now: stamp * 1000, options })
  const timestamp = begun.message.outgoing.wireTimestamp
  await storage.changeDirect(key, { kind: 'attempt', id: 'out', wireTimestamp: timestamp, attempt: 1, code: '12345678' })
  await storage.changeDirect(key, { kind: 'accepted', id: 'out', wireTimestamp: timestamp, attempt: 1, code: '12345678', route: 'direct' })
  await storage.changeDirect(key, { kind: 'failed', id: 'out', wireTimestamp: timestamp, error: 'No acknowledgement' })
  await storage.changeDirect(key, { kind: 'retry', id: 'out', now: (stamp + 10) * 1000, options })
  await storage.update(key, { messages: [receipt('reaction', await buildReaction('👍', 'ok', timestamp, null))] })
  assert.equal((await storage.read(key)).messages.find(({ id }) => id === 'out').reactions[0].count, 1)
  storage.close()
})

test('channel whitespace aliases, historical sender names, blocking, and deletion preserve honest counts', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  await storage.update(key, { channels: [{ index: 1, name: 'Public' }] })
  const begun = await storage.changeChannelMessage(key, {
    kind: 'begin', id: 'out', index: 1, channelName: 'Public', senderName: 'Old name', text: ' ok ',
    now: stamp * 1000, clearDraft: false, firmwareProtocolVersion: 14,
  })

  await storage.changeChannelMessage(key, { kind: 'accepted', id: 'out', wireTimestamp: begun.message.channelOutgoing.wireTimestamp })
  await storage.update(key, { messages: [
    receipt('reaction', `Bob: ${await buildReaction('👍', 'ok', stamp, 'Old name')}`, { channel: true }),
  ] })
  assert.equal((await storage.read(key)).messages.find(({ id }) => id === 'out').reactions[0].count, 1)
  await storage.update(key, { blockedChannelSender: { name: 'Bob', blocked: true } })
  assert.equal((await storage.read(key)).messages.find(({ id }) => id === 'out').reactions, undefined)
  await storage.update(key, { blockedChannelSender: { name: 'Bob', blocked: false } })
  assert.equal((await storage.read(key)).messages.find(({ id }) => id === 'out').reactions[0].count, 1)
  await storage.changeChannelMessage(key, { kind: 'remove', id: 'out' })
  assert.equal((await storage.read(key)).messages[0].reaction.state, 'unmatched')
  assert.equal((await storage.read(key)).messages[0].rawHex, '1234')
  storage.close()
})

test('a browser hashing failure is explicit without rejecting an already saved receipt or normal cache writes', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const raw = receipt('reaction', await buildReaction('👍', 'ok', stamp, null))
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
    await storage.update(key, { contacts: [contact], messages: [raw, receipt('target', 'ok')] })
    const data = await storage.read(key)
    assert.match(data.reactionError, /Web Crypto/)
    assert.equal(data.messages[0].reaction.state, 'unavailable')
    assert.equal(data.messages[0].rawHex, '1234')
    assert.equal(data.messages[1].reactions, undefined)
    await storage.update(key, { draft: { conversationId: `direct:${peer}`, text: 'Normal draft' } })
    assert.equal((await storage.read(key)).drafts[0].text, 'Normal draft')
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor)
  }
  assert.equal((await storage.read(key)).messages[1].reactions[0].count, 1)
  storage.close()
})

test('blocking uses the exact channel envelope name, including surrounding whitespace', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  try {
    const reaction = await buildReaction('👍', 'ok', stamp, 'Alice')
    const plainReaction = await buildReaction('❤️', 'ok', stamp, 'Alice')
    await storage.update(key, { messages: [
      receipt('target', 'Alice: ok', { channel: true }),
      receipt('padded', ` Bob : ${reaction}`, { channel: true }),
      receipt('plain', `Bob: ${plainReaction}`, { channel: true }),
    ], blockedChannelSender: { name: ' Bob ', blocked: true } })
    let data = await storage.read(key)
    assert.deepEqual(data.messages.find(({ id }) => id === 'target').reactions, [{ emoji: '❤️', count: 1, senders: ['Bob'] }])
    await storage.update(key, { blockedChannelSender: { name: 'Bob', blocked: true } })
    data = await storage.read(key)
    assert.equal(data.messages.find(({ id }) => id === 'target').reactions, undefined)
    await storage.update(key, { blockedChannelSender: { name: ' Bob ', blocked: false } })
    data = await storage.read(key)
    assert.deepEqual(data.messages.find(({ id }) => id === 'target').reactions, [{ emoji: '👍', count: 1, senders: ['Bob'] }])
  } finally { storage.close() }
})

test('Open v3 matching uses a hash index rather than comparing every reaction with every candidate', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  const charCodeAt = String.prototype.charCodeAt
  let codeUnits = 0
  try {
    const targets = Array.from({ length: 3000 }, (_, index) => receipt(`target-${index}`, `open-history-${index}`))
    const reactions = Array.from({ length: 500 }, (_, index) =>
      receipt(`reaction-${index}`, `r:${openReactionHash(`open-history-${index}`, stamp, null)}:00`))
    await storage.update(key, { contacts: [contact], messages: [...targets, ...reactions] })
    String.prototype.charCodeAt = function (...args) { codeUnits++; return charCodeAt.apply(this, args) }
    const data = await storage.read(key)
    assert.ok(data.messages.slice(3000).every(({ reaction }) => reaction && reaction.state !== 'unmatched'))
    assert.ok(codeUnits < 150000, `Open hash work should scale with candidates, not candidates times reactions: ${codeUnits}`)
  } finally {
    String.prototype.charCodeAt = charCodeAt
    storage.close()
  }
})

test('indexed Open v1 windows ignore outside timestamps and count a target only once', async () => {
  const storage = await openRadioStorage(new IDBFactory())
  try {
    const anchor = stamp + 10000
    const same = Array.from({ length: 60 }, (_, index) => receipt(`older-${index}`, 'ok', { timestamp: stamp + index }))
    const target = { ...receipt('target', 'ok', { timestamp: anchor }), reactionTimestamps: [anchor - 1, anchor + 1] }
    const reaction = receipt('reaction', `r:${anchor * 1000}_0_${dartStringHash('ok')}:👍`)
    await storage.update(key, { contacts: [contact], messages: [...same, target, reaction] })
    let data = await storage.read(key)
    assert.equal(data.messages.find(({ id }) => id === 'reaction').reaction.targetId, 'target')
    assert.equal(data.messages.find(({ id }) => id === 'target').reactions[0].count, 1)
    await storage.update(key, { messages: [receipt('second', 'ok', { timestamp: anchor - 300 })] })
    data = await storage.read(key)
    assert.equal(data.messages.find(({ id }) => id === 'reaction').reaction.state, 'ambiguous')
    assert.equal(data.messages.find(({ id }) => id === 'target').reactions, undefined)
  } finally { storage.close() }
})

test('large histories reuse projections on drafts and keep target hashes across receipt updates', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const otherConnection = await openRadioStorage(factory)
  const subtle = crypto.subtle
  const digest = subtle.digest
  const segment = Intl.Segmenter.prototype.segment
  let hashes = 0
  let segments = 0
  try {
    await storage.update(key, { contacts: [contact], messages: [
      ...Array.from({ length: 2101 }, (_, index) => receipt(`target-${index}`, `history-${index}`, { timestamp: stamp + index })),
      receipt('first-reaction', await buildReaction('👍', 'history-0', stamp, null)),
    ] })
    Object.defineProperty(subtle, 'digest', { configurable: true, value: (...args) => { hashes++; return digest.apply(subtle, args) } })
    Intl.Segmenter.prototype.segment = function (...args) { segments++; return segment.apply(this, args) }
    let data = await storage.read(key)
    assert.equal(data.messages.find(({ id }) => id === 'target-0').reactions[0].count, 1)
    assert.ok(hashes >= 2100 && hashes <= 2101)
    hashes = 0
    segments = 0
    for (let index = 0; index < 3; index++) {
      await storage.update(key, { draft: { conversationId: `direct:${peer}`, text: `draft-${index}` } })
      data = await otherConnection.read(key)
    }
    assert.equal(hashes, 0, 'draft writes must not rehash history')
    assert.equal(segments, 0, 'draft writes must not reparse history')
    assert.equal(data.drafts[0].text, 'draft-2')
    await otherConnection.update(key, { messages: [receipt('new-target', 'fresh-history', { timestamp: stamp + 3000 })] })
    data = await storage.read(key)
    assert.equal(hashes, 1, 'a new receipt should only hash the new target')
    assert.equal(data.messages.find(({ id }) => id === 'target-0').reactions[0].count, 1)
  } finally {
    Object.defineProperty(subtle, 'digest', { configurable: true, value: digest })
    Intl.Segmenter.prototype.segment = segment
    otherConnection.close()
    storage.close()
  }
})
