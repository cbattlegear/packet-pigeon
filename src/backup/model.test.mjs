import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import test from 'node:test'
import { backupJson, parseBackup, retentionDays } from './model.ts'

async function makeIdentity() {
  while (true) {
    const seed = randomBytes(32)
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der', type: 'pkcs8',
    })
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    if (publicKey.startsWith('00') || publicKey.startsWith('ff')) continue
    const expanded = new Uint8Array(await crypto.subtle.digest('SHA-512', seed))
    expanded[0] &= 248
    expanded[31] = (expanded[31] & 63) | 64
    return { public_key: publicKey, private_key: Buffer.from(expanded).toString('hex') }
  }
}

test('reads the reference configuration units and round-trips routes, secrets, and browser metadata', async () => {
  const identity = await makeIdentity()
  const contact = 'ab'.repeat(32)
  const channelKey = '42'.repeat(16)
  const scopeKey = '33'.repeat(16)
  const stock = {
    ...identity, name: 'Test radio',
    radio_settings: { frequency: 910525, bandwidth: 62500, spreading_factor: 7, coding_rate: 5, tx_power: 18 },
    position_settings: { latitude: '40.125', longitude: '-90.75' },
    other_settings: { manual_add_contacts: 1, advert_location_policy: 0 },
    auto_add_settings: { auto_add_chat: true, overwrite_oldest: true, auto_add_max_hops: 2 },
    channels: [{ name: 'Fixture', secret: channelKey, region_scope_name: '#Lab', region_scope_key: scopeKey,
      message_retention_duration_seconds: 604800 }],
    contacts: [{ type: 2, public_key: contact, name: 'Relay', custom_name: 'Lab relay', flags: 2, latitude: 1, longitude: -2,
      last_advert: 123, last_modified: 234, out_path_list: 'aabb,ccdd' }],
    region_transport_keys: [{ name: '#Lab', key: scopeKey }],
    packet_pigeon: { version: 1, path_hash_width: 3, default_region: { name: '#Lab', key: scopeKey } },
  }
  const decoded = parseBackup(stock)
  assert.equal(decoded.identity.publicKey, identity.public_key)
  assert.deepEqual(decoded.radio.settings, { frequencyMHz: 910.525, bandwidthKHz: 62.5, spreadingFactor: 7, codingRate: 5 })
  assert.deepEqual(decoded.autoAdd, { flags: 3, maxHops: 1 })
  assert.equal(decoded.contacts[0].pathLength, 66)
  assert.equal(decoded.contacts[0].pathHex, 'aabbccdd')
  assert.equal(decoded.contacts[0].customName, 'Lab relay')
  assert.deepEqual(decoded.channels[0].scope, { mode: 'region', name: '#Lab', key: scopeKey })
  assert.equal(retentionDays(decoded.channels[0].retentionSeconds), 7)
  assert.deepEqual(parseBackup(JSON.parse(backupJson(decoded))), decoded)
})

test('distinguishes explicit default channel settings from absent metadata', () => {
  const channels = [
    { name: 'Known defaults', secret: '12'.repeat(16), scope: { mode: 'default' }, retentionSeconds: null },
    { name: 'Unknown', secret: '23'.repeat(16), scope: undefined, retentionSeconds: undefined },
  ]
  const encoded = JSON.parse(backupJson({ channels }))
  assert.deepEqual(encoded.channels, [
    { name: 'Known defaults', secret: '12'.repeat(16), packet_pigeon_scope: 'default', message_retention_duration_seconds: null },
    { name: 'Unknown', secret: '23'.repeat(16) },
  ])
  assert.deepEqual(parseBackup(encoded).channels, channels)
})

test('rejects ambiguous or malformed backups before use', async () => {
  const identity = await makeIdentity()
  assert.throws(() => parseBackup({ ...identity, public_key: 'ab'.repeat(32) }), /does not match/)
  assert.throws(() => parseBackup({ private_key: '11'.repeat(64) }), /valid MeshCore expanded identity/)
  assert.throws(() => parseBackup({ contacts: [{ name: 'A', type: 2, public_key: 'ab'.repeat(32), out_path_list: 'ab,cdef' }] }), /mixed hash widths/)
  assert.throws(() => parseBackup({ channels: [{ name: 'A', secret: '00'.repeat(16) }] }), /cannot be all zero/)
  assert.throws(() => parseBackup({ name: 'Unrecognized', packet_pigeon: { version: 2 } }), /unsupported/)
  assert.throws(() => parseBackup({ messages: [] }), /does not contain supported/)
})
