import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversations, messageVisibility, oldestUnreadReceipt, possibleRepeats, unreadReceipts } from './model.ts'

const details = {
  type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
  latitude: 0, longitude: 0, lastModifiedAt: 0,
}
const first = '010203040506' + 'aa'.repeat(26)
const second = '010203040506' + 'bb'.repeat(26)
const receipt = {
  kind: 'direct-text', receiptId: 'one', senderKeyPrefix: '010203040506', signatureHex: null,
  textType: 0, senderTimestamp: 123, text: 'Hello', pathLength: 0, snrDb: null,
}
const received = {
  id: 'one', conversationId: 'direct:010203040506', sender: '010203040506',
  timestamp: 123000, text: 'Hello', receipt,
}

test('joins a uniquely identified sender with its contact and preserves repeated receipts', () => {
  const data = {
    contacts: [{ publicKey: first, name: 'Pigeon', details }], channels: [],
    messages: [received, { ...received, id: 'two', receipt: { ...receipt, receiptId: 'two' } }],
    drafts: [], preferences: null, contactPreferences: [{ publicKey: first, customName: 'Friend', favorite: false }],
  }
  const items = conversations(data)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Friend')
  assert.equal(items[0].recipient, first)
  assert.deepEqual(items[0].messages.map((message) => message.id), ['one', 'two'])
  assert.deepEqual([...possibleRepeats(items[0].messages)], ['two'])
})

test('possible repeats are hidden only on request and remain recoverable', () => {
  const repeated = { ...received, id: 'two', receipt: { ...receipt, receiptId: 'two', pathLength: 3 } }
  const distinct = {
    ...received, id: 'three', timestamp: 124000,
    receipt: { ...receipt, receiptId: 'three', senderTimestamp: 124 },
  }
  const otherSender = {
    ...received, id: 'four', receipt: { ...receipt, receiptId: 'four', senderKeyPrefix: '0708090a0b0c' },
  }
  const messages = [received, repeated, distinct, otherSender]
  const shown = messageVisibility(messages, false)
  assert.deepEqual(shown.visible.map(({ id }) => id), ['one', 'two', 'three', 'four'])
  assert.deepEqual([...shown.repeats], ['two'])
  assert.deepEqual(messageVisibility(messages, true).visible.map(({ id }) => id), ['one', 'three', 'four'])
  assert.deepEqual(messageVisibility(messages, false).visible.map(({ id }) => id), ['one', 'two', 'three', 'four'])
  assert.deepEqual(messages.map(({ id }) => id), ['one', 'two', 'three', 'four'])
})

test('does not attribute an ambiguous sender or enable sending to colliding contacts', () => {
  const data = {
    contacts: [
      { publicKey: first, name: 'One', details },
      { publicKey: second, name: 'Two', details },
    ],
    channels: [{ index: 0, name: 'Public' }],
    messages: [
      received,
      { id: 'channel', conversationId: 'channel:0', sender: '', timestamp: 124000, text: 'Public message' },
      { id: 'raw', conversationId: 'unsupported', sender: '', timestamp: null, text: '', rawHex: '5501' },
    ],
    drafts: [], preferences: null,
  }
  const items = conversations(data)
  assert.equal(items.find((item) => item.id === `direct:${first}`).recipient, null)
  assert.equal(items.find((item) => item.id === `direct:${second}`).recipient, null)
  assert.deepEqual(items.find((item) => item.id === 'direct:010203040506').messages, [received])
  assert.equal(items.find((item) => item.id === 'channel:0').title, 'Public')
  assert.equal(items.find((item) => item.id === 'unsupported').messages[0].rawHex, '5501')
})

test('the oldest unread receipt uses the sender timestamp and skips outgoing and read entries', () => {
  const undated = { ...received, id: 'undated', timestamp: null }
  const oldest = { ...received, id: 'oldest', timestamp: 100000 }
  const sent = { ...received, id: 'sent', timestamp: 99000, outgoing: {} }
  const read = { ...received, id: 'read', timestamp: 98000 }
  const unread = unreadReceipts([undated, received, oldest, sent, read], new Set([read.id]))
  assert.deepEqual(unread.map(({ id }) => id), [undated.id, received.id, oldest.id])
  assert.equal(oldestUnreadReceipt(unread), oldest)
})
