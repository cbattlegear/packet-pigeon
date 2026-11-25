import assert from 'node:assert/strict'
import test from 'node:test'
import { filterNodes, mapPosition, mapRadioContacts, readImportNodes, readPublicNodes } from '../src/map/nodes.ts'

const key = (digit) => digit.repeat(64)

test('normalizes local imports, ignores secret fields and separates discovered nodes', () => {
  const data = { nodes: [
    { publicKey: key('A'), role: 1, name: ' My companion ', favorite: true, privateKey: 'ignore' },
    { publicKey: key('b'), role: 2, name: 'Ridge', position: { lat: 50, lon: -100 }, source: 'discovery' },
    { public_key: key('c'), type: 4, adv_name: 'Outside map', adv_lat: 89, adv_lon: 42 },
  ] }
  const nodes = readImportNodes(data)
  assert.deepEqual(nodes[0], {
    publicKey: key('a'), role: 1, name: 'My companion', favorite: true, source: 'local', position: null,
  })
  assert.deepEqual(nodes[1].position, { lat: 50, lon: -100 })
  assert.equal(nodes[1].source, 'discovery')
  assert.equal(mapPosition(nodes[2].position), false)
  assert.throws(() => readImportNodes([{ publicKey: 'short', role: 7 }]), /64-character public key/)
})

test('uses the MeshCore JSON snapshot fields and safely skips unsupported entries', () => {
  const nodes = readPublicNodes([
    { public_key: key('1'), type: 2, adv_name: 'Public repeater', adv_lat: 0, adv_lon: 0 },
    { public_key: key('2'), type: 3, adv_lat: 91, adv_lon: 0 },
    { public_key: key('3'), type: 33 },
  ])
  assert.equal(nodes.length, 2)
  assert.deepEqual(nodes[0].position, { lat: 0, lon: 0 })
  assert.equal(nodes[1].position, null)
  assert(nodes.every(({ source }) => source === 'public'))
  assert.throws(() => readPublicNodes({ error: true }), /unexpected node list/)
})

test('combines name or public key search with role and favorite filters', () => {
  const nodes = readImportNodes([
    { publicKey: key('a'), name: 'Hill repeater', role: 2, favorite: true },
    { publicKey: key('b'), name: 'Hill companion', role: 1, favorite: true },
    { publicKey: key('c'), name: 'Valley repeater', role: 2, favorite: false },
  ])
  assert.deepEqual(filterNodes(nodes, { search: '  HILL ', role: 2, favoritesOnly: true }), [nodes[0]])
  assert.deepEqual(filterNodes(nodes, { search: key('c').slice(0, 8), role: 'all', favoritesOnly: false }), [nodes[2]])
})

test('maps USB contacts with usable coordinates and keeps unpositioned contacts searchable', () => {
  const nodes = mapRadioContacts([
    { publicKey: key('a'), name: 'Relay', type: 2, latitude: 40, longitude: -105 },
    { publicKey: key('b'), name: 'Companion', type: 1, latitude: 0, longitude: 0 },
    { publicKey: key('c'), name: 'Unsupported role', type: 33, latitude: 40, longitude: -105 },
  ])
  assert.deepEqual(nodes.map(({ source, position }) => [source, position]), [
    ['local', { lat: 40, lon: -105 }],
    ['local', null],
  ])
})
