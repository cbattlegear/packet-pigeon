import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMeshCoreShare, parseMeshCoreShare } from '../src/sharing/meshcoreLinks.ts'
import { formatCompanionSetup, parseCompanionSetup } from '../src/sharing/setupLink.ts'

const publicKey = '9cd8fcf22a47333b591d96a2b848b73f457b1bb1a3ea2453a885f9e5787765b1'
const secret = '8b3387e9c5cdea6ac9e5edbaa115cd72'

test('parses and formats the documented MeshCore contact and channel links', () => {
  const contactLink = `meshcore://contact/add?name=Example+Contact&public_key=${publicKey}&type=1`
  const channelLink = `meshcore://channel/add?name=Public&secret=${secret}`
  assert.deepEqual(parseMeshCoreShare(contactLink), {
    kind: 'contact', name: 'Example Contact', publicKey, type: 1,
  })
  assert.deepEqual(parseMeshCoreShare(channelLink), { kind: 'channel', name: 'Public', secret })
  assert.equal(formatMeshCoreShare(parseMeshCoreShare(contactLink)), contactLink)
  assert.equal(formatMeshCoreShare(parseMeshCoreShare(channelLink)), channelLink)
})

test('round-trips encoded names, a region scope, and all supported contact types', () => {
  const name = 'Café + mesh & radio 📡'
  for (const type of [1, 2, 3, 4]) {
    const contact = { kind: 'contact', name, publicKey: publicKey.toUpperCase(), type }
    assert.deepEqual(parseMeshCoreShare(formatMeshCoreShare(contact)), { ...contact, publicKey })
  }
  const channel = { kind: 'channel', name, secret, regionScope: 'US / Midwest' }
  assert.deepEqual(parseMeshCoreShare(formatMeshCoreShare(channel)), channel)
})

test('rejects malformed links without including channel secrets in errors', () => {
  const invalidLinks = [
    `https://channel/add?name=Private&secret=${secret}`,
    `meshcore://setup/add?name=Private&secret=${secret}`,
    `meshcore://channel/add?name=Private&secret=${secret}#fragment`,
    `meshcore://channel/add?name=Private&name=Other&secret=${secret}`,
    `meshcore://channel/add?name=%FF&secret=${secret}`,
    'meshcore://channel/add?name=Private&secret=123',
    `meshcore://channel/add?name=Private&secret=${secret}%0A`,
    `meshcore://contact/add?name=Contact&public_key=${publicKey}&type=5`,
    'meshcore://contact/add?name=Contact&public_key=123&type=1',
  ]
  for (const link of invalidLinks) {
    assert.throws(() => parseMeshCoreShare(link), (error) => !error.message.includes(secret))
  }
})

test('reads a v1 setup payload and exports a preset without identity or channel secrets', () => {
  const setup = (data) => `meshcore://companion-setup/v1?${new URLSearchParams({ json: JSON.stringify(data) })}`
  const settings = { frequencyMHz: 910.525, bandwidthKHz: 62.5, spreadingFactor: 7, codingRate: 5 }
  const link = setup({
    title: 'Fixture setup', description: 'Example preset',
    radio_settings: { title: 'Preset', description: 'Example', frequency: '910.525', bandwidth: '62.5',
      spreading_factor: '7', coding_rate: '5', network_settings: { path_hash_size: 2 } },
    contacts: [{ name: 'Peer', public_key: publicKey, type: 1 }],
    channels: [{ name: 'Public', secret, region_scope: 'us' }],
  })
  assert.deepEqual(parseCompanionSetup(link), {
    kind: 'setup', title: 'Fixture setup', description: 'Example preset', settings, pathWidth: 2,
    contacts: [{ kind: 'contact', name: 'Peer', publicKey, type: 1 }],
    channels: [{ kind: 'channel', name: 'Public', secret, regionScope: 'us' }],
  })
  const exported = formatCompanionSetup('Fixture', settings, 3)
  assert.deepEqual(parseCompanionSetup(exported), {
    kind: 'setup', title: 'Fixture', description: '', settings, pathWidth: 3, contacts: [], channels: [],
  })
  assert.equal(parseCompanionSetup('meshcore://contact/add?name=test'), null)
  for (const invalid of [
    link.replace('/v1', '/v2'),
    `${link}&json=%7B%7D`,
    setup({ radio_settings: { frequency: 'invalid' }, channels: [{ secret }] }),
    setup({ contacts: [{ name: 'No public key', private_key: publicKey, type: 1 }] }),
  ]) {
    assert.throws(() => parseCompanionSetup(invalid), (error) =>
      !error.message.includes(secret) && !error.message.includes(publicKey))
  }
})
