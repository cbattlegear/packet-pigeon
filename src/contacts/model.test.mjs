import assert from 'node:assert/strict'
import test from 'node:test'
import { contactEntries, contactRoute, visibleContacts } from './model.ts'

const key = (prefix, character) => prefix + character.repeat(64 - prefix.length)
const prefix = 'a1'.repeat(6)
const first = { publicKey: key(prefix, 'a'), name: 'Ridge 2',
  details: { type: 2, lastAdvertisedAt: 200, pathLength: 0x42, pathHex: '01020a0b' } }
const second = { publicKey: key('b1'.repeat(6), 'b'), name: 'Companion',
  details: { type: 1, lastAdvertisedAt: 100, pathLength: 0xff, pathHex: '' } }
const third = { publicKey: key(prefix, 'c'), name: 'Ridge 10',
  details: { type: 2, lastAdvertisedAt: 0, pathLength: 0, pathHex: '' } }

test('joins exact or unique saved message identifiers and omits ambiguous public-key prefixes', () => {
  const entries = contactEntries([first, second, third], [], [
    { conversationId: `direct:${prefix}`, timestamp: 700 },
    { conversationId: `direct:${second.publicKey.slice(0, 12)}`, timestamp: 400 },
    { conversationId: `direct:${first.publicKey}`, timestamp: 500 },
    { conversationId: 'channel:0', timestamp: 1_000 },
  ])
  assert.deepEqual(entries.map(({ latestMessage }) => latestMessage), [500, 400, null])
  assert.deepEqual(visibleContacts(entries, { search: '', favorites: false, role: 'all', sort: 'message' })
    .map(({ publicKey }) => publicKey), [first.publicKey, second.publicKey, third.publicKey])
})

test('filters role and favorites, searches both names, and displays decoded routes', () => {
  const entries = contactEntries([first, second, third], [
    { publicKey: first.publicKey, customName: 'Club Relay', favorite: true },
  ], [])
  assert.deepEqual(visibleContacts(entries, { search: 'ridge', favorites: true, role: 2, sort: 'heard' })
    .map(({ displayName }) => displayName), ['Club Relay'])
  assert.equal(contactRoute(first.details), '2 hops · 0102 → 0a0b')
  assert.equal(contactRoute(second.details), 'No saved route')
  assert.equal(contactRoute(third.details), 'Zero hop')
  assert.equal(contactRoute({ pathLength: 0xfe, pathHex: 'aabb' }), 'Route unavailable')
})
