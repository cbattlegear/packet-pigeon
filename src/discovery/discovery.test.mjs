import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { SessionCache } from '../integration/session-cache.ts'
import { decodeAdvert, readAdvertPath, readAutoAddPolicy, writeAutoAddPolicy } from '../radio/discovery-commands.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import { discoveryEntries, discoveryMapNodes, exportDiscoveries, filterDiscoveries, importDiscoveries } from './model.ts'

const radioA = radioKeyFromPublicKey('ab'.repeat(32))
const radioB = radioKeyFromPublicKey('cd'.repeat(32))
const contact = 'ef'.repeat(32)
const contactBytes = new Uint8Array(32).fill(0xef)
const path = { receivedAt: 8000, hops: 2, width: 2, hex: '01020304' }

function radioFixture(responses) {
  const writes = []
  return {
    writes,
    async request(command, receive) {
      writes.push([...command])
      const frame = responses.shift()
      assert(frame)
      return receive(Uint8Array.from(frame)).value
    },
  }
}

function newAdvert() {
  const data = Uint8Array.of(0x8a, ...contactBytes, 2, 0, 0xff, ...new Uint8Array(112))
  data.set(new TextEncoder().encode('Ridge relay'), 100)
  const fields = new DataView(data.buffer)
  fields.setInt32(136, 40_000_000, true)
  fields.setInt32(140, -105_000_000, true)
  return data.slice(1)
}

test('accepts full and short passive adverts and ignores truncated or unrelated pushes', () => {
  assert.equal(decodeAdvert(0x8a, newAdvert().slice(0, 80)), null)
  assert.equal(decodeAdvert(0x83, contactBytes), null)
  const observed = decodeAdvert(0x8a, newAdvert())
  assert.equal(observed.publicKey, contact)
  assert.equal(observed.contact.name, 'Ridge relay')
  assert.equal(observed.contact.latitude, 40)
  assert.equal(observed.added, false)
  assert.deepEqual(decodeAdvert(0x80, contactBytes), { publicKey: contact, added: true })
})

test('looks up local cached paths and rejects malformed or fragmented path responses', async () => {
  const radio = radioFixture([[22, 8, 0, 0, 0, 0x42, 1, 2, 3, 4], [1, 2], [22, 8, 0, 0, 0, 0x42, 1]])
  assert.deepEqual(await readAdvertPath(radio, contact), path)
  assert.deepEqual(radio.writes[0], [42, 0, ...contactBytes])
  assert.equal(await readAdvertPath(radio, contact), null)
  await assert.rejects(readAdvertPath(radio, contact), /fragmented advert path/)
})

test('preserves unknown policy bits, maps zero hop correctly, and gates older firmware', async () => {
  const radio = radioFixture([[25, 0xa0, 0], [0], [0], [25, 0xa5, 1]])
  const updated = await writeAutoAddPolicy(radio, { flags: 5, maxHops: 0, selectedRoles: true }, 0x80)
  assert.deepEqual(radio.writes, [[59], [58, 0xa5, 1], [38, 0x81], [59]])
  assert.deepEqual(updated, { mode: 0x81, policy: { flags: 0xa5, maxHops: 0, selectedRoles: true } })

  const legacy = radioFixture([[25, 4], [25, 4], [1, 1]])
  assert.deepEqual(await readAutoAddPolicy(legacy, 1), { flags: 4, selectedRoles: true })
  await assert.rejects(writeAutoAddPolicy(legacy, { flags: 4, maxHops: 1, selectedRoles: true }, 1), /hop limit/)
  await assert.rejects(readAutoAddPolicy(legacy, 1), { code: 'unsupported-firmware' })
  assert.deepEqual(legacy.writes, [[59], [59], [59]])
})

test('stores passive adverts by verified radio and preserves newer metadata around path updates', async () => {
  const factory = new IDBFactory()
  const store = await openRadioStorage(factory)
  let listener
  let current = { phase: 'ready', transport: 'usb', device: { publicKey: radioA }, contacts: [], channels: [], messages: [] }
  const cache = new SessionCache({
    subscribe() {}, getSnapshot: () => current, subscribeToPushes(fn) { listener = fn },
  }, async () => store)
  const found = []
  cache.subscribeToDiscoveries((key, entry) => found.push([key, entry.publicKey]))
  try {
    listener({ code: 0x8a, payload: newAdvert() })
    for (let index = 0; cache.getSnapshot().pending && index < 100; index++) await setTimeout(2)
    assert.deepEqual(found, [[radioA, contact]])
    listener({ code: 0x8a, payload: newAdvert() })
    for (let index = 0; cache.getSnapshot().pending && index < 100; index++) await setTimeout(2)
    assert.deepEqual(found, [[radioA, contact]])
    const saved = (await store.read(radioA)).discoveries[0]
    assert.equal(saved.name, 'Ridge relay')
    assert.equal(await store.read(radioB), null)

    current = { ...current, phase: 'reconnecting' }
    listener({ code: 0x80, payload: contactBytes })
    await store.update(radioA, { discovery: { upsert: [{ publicKey: contact, heardAt: 1, path }] } })
    const data = await store.read(radioA)
    const entries = discoveryEntries(data)
    assert.equal(entries[0].heardAt, saved.heardAt)
    assert.equal(entries[0].alreadyAdded, false)
    assert.equal(entries[0].displayName, 'Ridge relay')
    assert.deepEqual(entries[0].path, path)
    assert.equal(discoveryMapNodes(entries)[0].position.lon, -105)
    assert.equal(filterDiscoveries(entries, { query: 'ridge', role: 2, width: 2, includeAdded: false, sort: 'hops' }).length, 1)

    const imported = importDiscoveries(JSON.parse(exportDiscoveries(entries)))
    await store.update(radioB, { discovery: { upsert: imported } })
    await store.update(radioA, { discovery: { remove: [contact] } })
    assert.equal((await store.read(radioA)).discoveries.length, 0)
    assert.equal((await store.read(radioB)).discoveries.length, 1)
  } finally {
    store.close()
  }
})
