import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allocateRepeaterCliTag, repeaterCliCommand, repeaterOwnerInfoCommand, sendRepeaterCli, UncertainRepeaterCliError,
  repeaterNameCommand, repeaterPositionCommand, parseRepeaterNeighbors,
} from './repeater-cli.ts'

const key = 'bc'.repeat(32)
const encoder = new TextEncoder()

test('CLI queries use the repeater text type and a tagged command', async () => {
  let command
  const link = { async request(bytes, receive) {
    command = bytes.slice()
    return receive(Uint8Array.of(6, 1, 0, 0, 0, 0, 0xe8, 3, 0, 0)).value
  } }
  assert.deepEqual(await sendRepeaterCli(link, key, 'get name', 'A7'), {
    tag: 'A7', route: 'flood', timeoutMs: 10_000,
  })
  assert.deepEqual([...command], [2, 1, 0, 0, 0, 0, 0, ...new Uint8Array(6).fill(0xbc), ...encoder.encode('A7|get name')])
})

test('neighbor replies parse exact firmware records and reject malformed or unsafe values', () => {
  assert.deepEqual(parseRepeaterNeighbors('1234ABCD:42:-20\r\n89abcdef:300:12'), [
    { keyPrefix: '1234abcd', secondsAgo: 42, snrQuarterDb: -20 },
    { keyPrefix: '89abcdef', secondsAgo: 300, snrQuarterDb: 12 },
  ])
  assert.deepEqual(parseRepeaterNeighbors('-none-'), [])
  for (const reply of ['', '1234abcd:42', '1234abcd:-1:0', '1234abcd:4294967296:0',
    '1234abcd:0:32768', '1234abcd:0:-32769', '1234abcd:0:0\n', '123456789:1:0', 'x'.repeat(4097)]) {
    assert.throws(() => parseRepeaterNeighbors(reply), /neighbor/)
  }
})

test('owner information is bounded, supports line breaks and rejects unsafe text', () => {
  assert.equal(repeaterOwnerInfoCommand('Line one\nLine two').command, 'set owner.info Line one|Line two')
  assert.equal(repeaterOwnerInfoCommand('').command, 'set owner.info ')
  assert.equal(repeaterOwnerInfoCommand('é'.repeat(59) + 'x').confirm, true)
  for (const value of ['x'.repeat(120), 'é'.repeat(60), 'one|two', 'one\ttwo', 'one\0two', '\ud800']) {
    assert.throws(() => repeaterOwnerInfoCommand(value), /Owner information/)
  }
  for (const command of ['set owner.info x\nreboot', `set owner.info ${'é'.repeat(60)}`, 'set owner.info \0']) {
    assert.throws(() => repeaterCliCommand(command), /Owner information/)
  }
})

test('repeater names preserve valid UTF-8 and reject unsupported or unsafe values', () => {
  for (const value of ['Relay', 'é'.repeat(15) + 'x', 'Mesh | Home', 'Relay 🛰']) {
    assert.equal(repeaterNameCommand(value).command, `set name ${value}`)
    assert.equal(repeaterNameCommand(value).confirm, true)
  }
  for (const value of ['', ' ', ' leading', 'trailing ', 'x'.repeat(32), 'é'.repeat(16),
    'newline\nreboot', 'tab\there', 'nul\0', '\ud800', ...'[]/\\:,?*']) {
    assert.throws(() => repeaterNameCommand(value), /name/)
  }
})

test('advertised position updates enforce coordinate ranges and decimal precision', () => {
  for (const [axis, value] of [['lat', '-90'], ['lat', '90.000000'], ['lon', '-180'], ['lon', '180']]) {
    assert.equal(repeaterPositionCommand(axis, value).command, `set ${axis} ${value}`)
    assert.equal(repeaterPositionCommand(axis, value).confirm, true)
  }
  for (const [axis, value] of [['lat', '-90.000001'], ['lat', '90.1'], ['lon', '-181'], ['lon', '180.1'],
    ['lat', '1.1234567'], ['lon', '1e2'], ['lon', ''], ['lat', 'Infinity'], ['lon', '0\nadvert'], ['lat', '1\n']]) {
    assert.throws(() => repeaterPositionCommand(axis, value), /latitude|longitude/)
  }
  assert.throws(() => repeaterCliCommand('set lat 90.000001'), /latitude/)
  assert.throws(() => repeaterCliCommand('set lon -180.000001'), /longitude/)
  assert.throws(() => repeaterCliCommand('set lat 1\n'), /supported/)
})

test('CLI rejects unsafe and unsupported text before dispatch', async () => {
  let writes = 0
  const link = { async request() { writes++; throw new Error('unexpected write') } }
  for (const command of ['get guest.password', 'set guest.password secret', 'get prv.key', 'reboot now', 'reboot\n', 'ver\nadvert',
    'set repeat', 'set repeat true', 'set repeat off\n', 'set repeat off extra',
    'get allow.read.only', 'set allow.read.only on', 'set allow.read.only off',
    'set allow.read.only', 'set allow.read.only true', 'set allow.read.only off extra',
    'set name Bad\nreboot', 'set name Bad/Name', `set name ${'x'.repeat(32)}`]) {
    await assert.rejects(sendRepeaterCli(link, key, command, 'AA'), /supported repeater CLI command|name/)
  }
  assert.equal(writes, 0)
  assert.equal(repeaterCliCommand('advert').confirm, true)
  assert.equal(repeaterCliCommand('clock sync').confirm, true)
  assert.equal(repeaterCliCommand('reboot').confirm, true)
  assert.equal(repeaterCliCommand('set repeat on').confirm, true)
  assert.equal(repeaterCliCommand('set repeat off').confirm, true)
  assert.equal(repeaterCliCommand('gps advert').command, 'gps advert')
  assert.throws(() => repeaterCliCommand('gps advert prefs'), /supported/)
  assert.throws(() => repeaterCliCommand('time 9999999999'), /supported/)
})

test('advertisement interval changes accept only supported exact values', () => {
  for (const command of ['set advert.interval 0', 'set advert.interval 60', 'set advert.interval 240',
    'set flood.advert.interval 0', 'set flood.advert.interval 3', 'set flood.advert.interval 168']) {
    assert.equal(repeaterCliCommand(command).confirm, true)
  }
  for (const command of ['set advert.interval 59', 'set advert.interval 61', 'set advert.interval 242',
    'set flood.advert.interval 2', 'set flood.advert.interval 169', 'set advert.interval -2',
    'set advert.interval 060', 'set advert.interval 60.0', 'set advert.interval 60\n', 'set advert.interval 60\nreboot',
    'set flood.advert.interval 999999999999999999999']) {
    assert.throws(() => repeaterCliCommand(command), /interval|supported/)
  }
})

test('flood hop limits accept exact whole values and require confirmation', () => {
  for (const kind of ['flood.max', 'flood.max.unscoped', 'flood.max.advert']) {
    assert.equal(repeaterCliCommand(`get ${kind}`).command, `get ${kind}`)
    for (const value of ['0', '1', '64']) {
      assert.equal(repeaterCliCommand(`set ${kind} ${value}`).confirm, true)
    }
    for (const value of ['', '-1', '65', '256', '01', '1.0', '1e1', ' 1', '1 ', '1\n', '1\nreboot', '999999999999999999999']) {
      assert.throws(() => repeaterCliCommand(`set ${kind} ${value}`), /flood hop limit|supported/)
    }
  }
})

test('flood loop detection accepts only supported modes and requires confirmation', () => {
  assert.equal(repeaterCliCommand('get loop.detect').command, 'get loop.detect')
  for (const mode of ['off', 'minimal', 'moderate', 'strict']) {
    const command = repeaterCliCommand(`set loop.detect ${mode}`)
    assert.equal(command.confirm, true)
    assert.match(command.description, new RegExp(mode))
  }
  for (const command of ['set loop.detect', 'set loop.detect OFF', 'set loop.detect strict ',
    'set loop.detect strict extra', 'set loop.detect minimal\nreboot', 'set loop.detect unknown']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('CLI confirmation failures distinguish rejection from uncertain dispatch', async () => {
  const link = (reply) => ({ async request(_bytes, receive) { return receive(Uint8Array.of(...reply)).value } })
  await assert.rejects(sendRepeaterCli(link([1, 2]), key, 'ver', 'AA'), { code: 'device-error' })
  for (const response of [[6, 0], [6, 2, ...new Uint8Array(8)], [1], [0]]) {
    await assert.rejects(sendRepeaterCli(link(response), key, 'ver', 'BC'), (error) =>
      error instanceof UncertainRepeaterCliError && error.tag === 'BC')
  }
})

test('reply tags never repeat in the tab and exhaustion is explicit', () => {
  const used = new Set()
  const first = allocateRepeaterCliTag(used)
  const second = allocateRepeaterCliTag(used)
  assert.notEqual(first, second)
  assert.match(first, /^[0-9A-Z]{2}$/)
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const firstChar of alphabet) for (const secondChar of alphabet) used.add(firstChar + secondChar)
  assert.throws(() => allocateRepeaterCliTag(used), /No unused CLI reply tags/)
})
