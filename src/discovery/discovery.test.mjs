import assert from 'node:assert/strict'
import { setImmediate, setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { SessionCache } from '../integration/session-cache.ts'
import {
  decodeAdvert, decodeNearbyNode, nearbyWindowMs, readAdvertPath, readAutoAddPolicy, requestRepeaterDetails,
  scanNearby, sendNearbyRequest, writeAutoAddPolicy,
} from '../radio/discovery-commands.ts'
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

function tagBytes(tag) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, tag, true)
  return bytes
}

function nearbyPush(tag, key = contactBytes) {
  return { code: 0x8e, payload: Uint8Array.of(0xf8, 0x9c, 0, 0x92, 0xec, ...tagBytes(tag), ...key) }
}

function binaryPush(tag, body) {
  return { code: 0x8c, payload: Uint8Array.of(0, ...tagBytes(tag), 1, 0, 0, 0, ...body) }
}

test('decodes only full, matching zero-hop discovery replies', () => {
  const push = nearbyPush(0x12345678)
  const padded = Uint8Array.of(0, ...push.payload, 0)
  push.payload = padded.subarray(1, -1)
  assert.deepEqual(decodeNearbyNode(push, 0x12345678), {
    publicKey: contact, type: 2, outboundSnrDb: -5, inboundSnrDb: -2, rssiDbm: -100,
  })
  assert.equal(decodeNearbyNode(push, 3), null)
  assert.equal(decodeNearbyNode({ ...push, code: 0x8c }, 0x12345678), null)
  assert.equal(decodeNearbyNode({ ...push, payload: push.payload.slice(0, 17) }, 0x12345678), null)
  const relayed = push.payload.slice()
  relayed[2] = 1
  assert.equal(decodeNearbyNode({ ...push, payload: relayed }, 0x12345678), null)
  relayed[2] = 0
  relayed[3] = 0x95
  assert.equal(decodeNearbyNode({ ...push, payload: relayed }, 0x12345678), null)
})

test('nearby discovery sends one tagged broadcast, buffers early replies, and stops on cancellation', async () => {
  let listener
  let finishSend
  let removed = 0
  let tag
  const found = []
  let listening = false
  const controller = new AbortController()
  const scanning = scanNearby((value) => {
    tag = value
    listener(nearbyPush(tag))
    listener(nearbyPush((tag + 1) >>> 0))
    return new Promise((resolve) => { finishSend = resolve })
  }, (callback) => {
    listener = callback
    return () => { removed++ }
  }, controller.signal, (node) => found.push(node), () => { listening = true })
  assert.deepEqual(found, [])
  finishSend()
  await setImmediate()
  assert.equal(listening, true)
  assert.equal(found.length, 1)
  listener(nearbyPush(tag, new Uint8Array(32).fill(0xcd)))
  assert.equal(found.length, 2)
  controller.abort(new Error('Stopped by fixture'))
  await assert.rejects(scanning, /Stopped by fixture/)
  assert.equal(removed, 1)

  const radio = radioFixture([[0]])
  await sendNearbyRequest(radio, 0x12345678, new AbortController().signal)
  assert.deepEqual(radio.writes, [[55, 0x80, 0x1e, 0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0]])
})

test('nearby listening ends after the advertised window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let removed = false
  let complete = false
  const scanning = scanNearby(async () => {}, () => () => { removed = true },
    new AbortController().signal, () => {}, () => {}).then(() => { complete = true })
  await setImmediate()
  t.mock.timers.tick(nearbyWindowMs - 1)
  await setImmediate()
  assert.equal(complete, false)
  t.mock.timers.tick(1)
  await scanning
  assert.equal(removed, true)
})

test('direct repeater requests correlate early replies and parse regions and owner information', async () => {
  const tag = 0x12345678
  let listener
  let removed = 0
  const writes = []
  let body = new TextEncoder().encode('*,north,Coast_É,north')
  const link = {
    async request(command, receive) {
      writes.push([...command])
      listener(binaryPush(tag + 1, new TextEncoder().encode('wrong')))
      listener(binaryPush(tag, body))
      return receive(Uint8Array.of(6, 0, ...tagBytes(tag), 0xe8, 3, 0, 0)).value
    },
  }
  const subscribe = (callback) => { listener = callback; return () => { removed++ } }
  assert.deepEqual(await requestRepeaterDetails(link, contact, 'regions', subscribe,
    new AbortController().signal, () => {}), { kind: 'regions', regions: ['*', 'north', 'Coast_É'] })
  assert.deepEqual(writes[0], [57, ...contactBytes, 1, 0])
  body = new TextEncoder().encode('Ridge relay\nContact the local operator')
  assert.deepEqual(await requestRepeaterDetails(link, contact, 'owner', subscribe,
    new AbortController().signal, () => {}), {
    kind: 'owner', name: 'Ridge relay', owner: 'Contact the local operator',
  })
  assert.deepEqual(writes[1], [57, ...contactBytes, 2, 0])
  body = new TextEncoder().encode('north')
  assert.deepEqual(await requestRepeaterDetails(link, contact, 'regions', subscribe,
    new AbortController().signal, () => {}, { encoded: 0x81, hex: 'aabbcc' }), {
    kind: 'regions', regions: ['north'],
  })
  assert.deepEqual(writes[2], [57, ...contactBytes, 1, 0x81, 0xaa, 0xbb, 0xcc])
  body = new TextEncoder().encode('north,,south')
  await assert.rejects(requestRepeaterDetails(link, contact, 'regions', subscribe,
    new AbortController().signal, () => {}), { code: 'protocol' })
  body = new TextEncoder().encode('north,\u0085')
  await assert.rejects(requestRepeaterDetails(link, contact, 'regions', subscribe,
    new AbortController().signal, () => {}), { code: 'protocol' })
  assert.equal(removed, 5)
})

test('repeater requests time out and unsubscribe without retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let removed = false
  const link = radioFixture([[6, 0, 1, 2, 3, 4, 0, 0, 0, 0]])
  const pending = requestRepeaterDetails(link, contact, 'regions', () => () => { removed = true },
    new AbortController().signal, () => {})
  await setImmediate()
  t.mock.timers.tick(5_000)
  await assert.rejects(pending, /timeout/)
  assert.equal(removed, true)
  assert.equal(link.writes.length, 1)
})

test('routed requests use a bounded longer timeout and reject invalid return paths before sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let removed = false
  let settled = false
  const link = radioFixture([[6, 0, 1, 2, 3, 4, 0, 0, 0, 0]])
  const pending = requestRepeaterDetails(link, contact, 'regions', () => () => { removed = true },
    new AbortController().signal, () => {}, { encoded: 1, hex: 'aa' }, true)
  pending.then(() => { settled = true }, () => { settled = true })
  await setImmediate()
  t.mock.timers.tick(119_999)
  await setImmediate()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await assert.rejects(pending, /timeout/)
  assert.equal(removed, true)
  assert.deepEqual(link.writes[0], [57, ...contactBytes, 1, 1, 0xaa])

  const invalid = radioFixture([])
  await assert.rejects(requestRepeaterDetails(invalid, contact, 'regions', () => () => {},
    new AbortController().signal, () => {}, { encoded: 0x42, hex: '1234' }), /reply path is invalid/)
  assert.deepEqual(invalid.writes, [])
})

test('a flooded repeater request is reported as already sent', async () => {
  const link = radioFixture([[6, 1, 1, 2, 3, 4, 0, 0, 0, 0]])
  let removed = false
  await assert.rejects(requestRepeaterDetails(link, contact, 'regions', () => () => { removed = true },
    new AbortController().signal, () => {}), /sent the request by a flood route/)
  assert.equal(removed, true)
  assert.equal(link.writes.length, 1)
})

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
