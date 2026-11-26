import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allocateRepeaterCliTag, repeaterCliCommand, repeaterOwnerInfoCommand, sendRepeaterCli, UncertainRepeaterCliError,
  repeaterNameCommand, repeaterPositionCommand, repeaterRegionQuery, repeaterHomeRegionCommand, repeaterRegionFloodCommand,
  repeaterTransmitPowerCommand, repeaterGuestPasswordCommand, repeaterRegionPutCommand, repeaterRegionRemoveCommand, repeaterRemoveAccessCommand,
  repeaterGrantAdminCommand, repeaterLimitedAccessCommand, repeaterRemoveNeighborCommand,
  compareRepeaterPublicKey, parseRepeaterNeighbors,
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

test('identity queries accept only exact commands and compare complete public-key replies', () => {
  for (const command of ['get public.key', 'get role']) {
    const action = repeaterCliCommand(command)
    assert.equal(action.command, command)
    assert.equal('confirm' in action, false)
  }
  for (const command of ['get public.key ', 'get public.key extra', 'get role\nreboot', 'get role extra']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
  assert.equal(compareRepeaterPublicKey(`> ${key.toUpperCase()}`, key), 'match')
  assert.equal(compareRepeaterPublicKey(`> ${'dd'.repeat(32)}`, key), 'mismatch')
  for (const reply of ['', '> unsupported', `> ${key.slice(0, -2)}`, `> ${key} extra`, `> ${key}\n`]) {
    assert.equal(compareRepeaterPublicKey(reply, key), 'unrecognized')
  }
})

test('power diagnostic queries accept only exact read-only commands', () => {
  for (const command of ['get pwrmgt.support', 'get pwrmgt.source', 'get pwrmgt.bootreason', 'get pwrmgt.bootmv']) {
    const action = repeaterCliCommand(command)
    assert.equal(action.command, command)
    assert.equal('confirm' in action, false)
    for (const invalid of [`${command} `, `${command} extra`, `${command}\nreboot`]) {
      assert.throws(() => repeaterCliCommand(invalid), /supported repeater CLI command/)
    }
  }
  assert.throws(() => repeaterCliCommand('set pwrmgt.source battery'), /supported repeater CLI command/)
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

test('neighbor discovery requires confirmation and only accepts the exact command', () => {
  const action = repeaterCliCommand('discover.neighbors')
  assert.equal(action.confirm, true)
  assert.match(action.warning, /zero-hop discovery request/)
  assert.match(action.warning, /nearby repeaters may also transmit replies/)
  assert.match(action.warning, /replaces any discovery already in progress/)
  assert.match(action.warning, /responses are unauthenticated and do not prove identity/)
  assert.match(action.warning, /does not prove a broadcast occurred/)
  assert.match(action.warning, /old entries may remain and the list can be incomplete/)
  for (const command of ['discover.neighbors ', 'discover.neighbors extra', 'discover.neighbors\nreboot']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('neighbor removal requires a full key and warns that removal is not a block', () => {
  const key = 'dd'.repeat(32)
  const action = repeaterRemoveNeighborCommand(key.toUpperCase())
  assert.equal(action.command, `neighbor.remove ${key}`)
  assert.equal(action.neighborTarget, key)
  assert.equal(action.confirm, true)
  assert.match(action.warning, /four-byte prefixes, which can collide/)
  assert.match(action.warning, /not access or future discovery/)
  assert.match(action.warning, /even if no entry matched/)
  assert.match(action.warning, /Older snapshots and maps remain stale/)
  assert.equal(repeaterCliCommand(`neighbor.remove ${key}`).confirm, true)
  for (const command of [`neighbor.remove ${key.slice(0, 8)}`, 'neighbor.remove ',
    `neighbor.remove ${key} `, `neighbor.remove ${key} extra`, `neighbor.remove ${key}\nreboot`]) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
  for (const value of ['dd'.repeat(4), 'gg'.repeat(32), 'dd'.repeat(33)]) {
    assert.throws(() => repeaterRemoveNeighborCommand(value), /64-character hex public key/)
  }
})

test('filtered region lists allow only the two exact read-only commands', () => {
  for (const command of ['region list allowed', 'region list denied']) {
    const action = repeaterCliCommand(command)
    assert.equal(action.command, command)
    assert.equal('confirm' in action, false)
  }
  for (const command of ['region list', 'region list all', 'region list allowed ', 'region list denied extra',
    'region list allowed\nregion save']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('access removal requires an exact full public key and confirmation', () => {
  const key = 'ab'.repeat(32)
  const action = repeaterRemoveAccessCommand(key.toUpperCase())
  assert.equal(action.command, `setperm ${key} 0`)
  assert.equal(action.accessTarget, key)
  assert.equal(action.confirm, true)
  assert.match(action.warning, /does not change passwords|not its passwords/)
  assert.match(action.warning, /blank guest password may allow guest access/)
  assert.match(action.warning, /may misdirect the reply/)
  assert.match(action.warning, /saving is delayed and can fail/i)
  assert.equal(repeaterCliCommand(`setperm ${key} 0`).confirm, true)
  for (const command of [`setperm ${key.slice(0, 12)} 0`, `setperm ${key} 00`,
    `setperm ${key} 0 extra`, `setperm ${key} 0\nreboot`, `setperm ${key} 0\n`]) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
  for (const value of ['ab'.repeat(6), 'gg'.repeat(32), 'ab'.repeat(33)]) {
    assert.throws(() => repeaterRemoveAccessCommand(value), /64-character hex public key/)
  }
})

test('administrator grants require a full key and confirmation and explain eviction risks', () => {
  const key = 'dd'.repeat(32)
  const action = repeaterGrantAdminCommand(key.toUpperCase())
  assert.equal(action.command, `setperm ${key} 3`)
  assert.equal(action.accessTarget, key)
  assert.equal(action.confirm, true)
  assert.match(action.warning, /full administrator control/)
  assert.match(action.warning, /log in without the password/)
  assert.match(action.warning, /Existing permission bits are replaced/)
  assert.match(action.warning, /full table can evict another client, even an administrator or the connected radio/)
  assert.match(action.warning, /may misdirect the reply/)
  assert.match(action.warning, /reported login role may then be stale/)
  assert.match(action.warning, /OK reply does not verify persistence/)
  assert.equal(repeaterCliCommand(`setperm ${key} 3`).confirm, true)
  for (const command of [`setperm ${key.slice(0, 12)} 3`, `setperm ${key} 03`,
    `setperm ${key} 3 extra`, `setperm ${key} 3\nreboot`, `setperm ${key} 3\n`]) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
  for (const value of ['dd'.repeat(6), 'gg'.repeat(32), 'dd'.repeat(33)]) {
    assert.throws(() => repeaterGrantAdminCommand(value), /64-character hex public key/)
  }
})

test('non-admin role changes require full keys and explain permissions and eviction risks', () => {
  const key = 'dd'.repeat(32)
  for (const [role, number] of [['read-only', 1], ['read-write', 2]]) {
    const action = repeaterLimitedAccessCommand(key.toUpperCase(), role)
    assert.equal(action.command, `setperm ${key} ${number}`)
    assert.equal(action.accessTarget, key)
    assert.equal(action.confirm, true)
    assert.equal(repeaterCliCommand(`setperm ${key} ${number}`).confirm, true)
    assert.match(action.warning, /do not imply distinct repeater capabilities/)
    assert.match(action.warning, /may allow more telemetry than guest access/)
    assert.match(action.warning, /log in without the password/)
    assert.match(action.warning, /replaces all permission bits and can demote an administrator/)
    assert.match(action.warning, /administrator password may regain admin access/)
    assert.match(action.warning, /full table can evict another client/)
    assert.match(action.warning, /may misdirect the reply/)
    assert.match(action.warning, /reported login role may then be stale/)
    assert.match(action.warning, /OK reply does not verify persistence/)
  }
  for (const value of ['dd'.repeat(6), 'gg'.repeat(32), 'dd'.repeat(33)]) {
    assert.throws(() => repeaterLimitedAccessCommand(value, 'read-only'), /64-character hex public key/)
  }
  assert.throws(() => repeaterLimitedAccessCommand(key, 'admin'), /supported non-admin role/)
  for (const command of [`setperm ${key.slice(0, 12)} 1`, `setperm ${key} 4`, `setperm ${key} 01`,
    `setperm ${key} 1 extra`, `setperm ${key} 2\nreboot`, `setperm ${key} 1\n`]) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
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
  for (const command of ['get guest.password', 'get prv.key', 'password secret', 'reboot now', 'reboot\n', 'ver\nadvert',
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
  assert.throws(() => repeaterCliCommand('time 9999999999'), /supported/)
})

test('GPS activity is explicit and receiver changes require confirmation', () => {
  const status = repeaterCliCommand('sensor get gps')
  assert.equal('confirm' in status, false)
  for (const command of ['gps on', 'gps off']) {
    const action = repeaterCliCommand(command)
    assert.equal(action.confirm, true)
    assert.match(action.warning, /location telemetry and later advertisements/)
    assert.match(action.warning, /change the device clock and disrupt later commands/)
    assert.match(action.warning, /cannot power off the receiver/)
    assert.match(action.warning, /does not prove a fix, hardware state, or persistence/)
  }
  for (const command of ['gps', 'gps ', 'gps status', 'sensor get gps ', 'gps on ', 'gps off extra',
    'gps on\nreboot', 'gps sync']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('copying sensor coordinates requires confirmation and only accepts the exact command', () => {
  const action = repeaterCliCommand('gps setloc')
  assert.equal(action.confirm, true)
  assert.match(action.warning, /stale or zero even without a GPS fix or receiver/)
  assert.match(action.warning, /does not send an advertisement/)
  assert.match(action.warning, /local advert interval below 60 minutes/)
  assert.match(action.warning, /does not prove a valid fix or persistence/)
  for (const command of ['gps setloc ', 'gps setloc extra', 'gps setloc\nreboot']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('GPS advert policy changes accept only exact supported values and require confirmation', () => {
  for (const policy of ['none', 'prefs', 'share']) {
    assert.equal(repeaterCliCommand(`gps advert ${policy}`).confirm, true)
  }
  for (const command of ['gps advert ', 'gps advert on', 'gps advert PREFS', 'gps advert prefs ',
    'gps advert prefs extra', 'gps advert share\nreboot']) {
    assert.throws(() => repeaterCliCommand(command), /supported/)
  }
})

test('power-saving query is read-only and mutations require confirmation', () => {
  assert.equal(repeaterCliCommand('powersaving').command, 'powersaving')
  for (const command of ['powersaving on', 'powersaving off']) {
    assert.equal(repeaterCliCommand(command).confirm, true)
  }
  for (const command of ['powersaving maybe', 'powersaving on ', 'powersaving off extra',
    'powersaving off\nreboot']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('receiver gain query is read-only and changes require confirmation', () => {
  assert.equal(repeaterCliCommand('get radio.rxgain').command, 'get radio.rxgain')
  for (const command of ['set radio.rxgain on', 'set radio.rxgain off']) {
    const action = repeaterCliCommand(command)
    assert.equal(action.confirm, true)
    assert.match(action.warning, /does not prove the radio applied the preference or saved it successfully/)
    assert.match(action.warning, /returns radio parameters instead of on\/off/)
    assert.match(action.warning, /local advert interval below 60 minutes to zero/)
    assert.match(action.warning, /already scheduled advert may still be sent/)
  }
  for (const command of ['get radio.rxgain ', 'set radio.rxgain', 'set radio.rxgain true',
    'set radio.rxgain on extra', 'set radio.rxgain off\nreboot']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('AGC reset intervals are bounded to exact four-second steps and require confirmation', () => {
  assert.equal(repeaterCliCommand('get agc.reset.interval').command, 'get agc.reset.interval')
  for (const value of ['0', '4', '16', '1020']) {
    assert.equal(repeaterCliCommand(`set agc.reset.interval ${value}`).confirm, true)
  }
  for (const value of ['', '-4', '1', '3', '5', '1021', '1024', '00', '04', '4.0', '1e2',
    ' 4', '4 ', '4\n', '4\nreboot', '999999999999999999999']) {
    assert.throws(() => repeaterCliCommand(`set agc.reset.interval ${value}`), /AGC reset interval/)
  }
})

test('extra direct ACK preference accepts only exact supported commands', () => {
  assert.equal(repeaterCliCommand('get multi.acks').command, 'get multi.acks')
  for (const command of ['set multi.acks 0', 'set multi.acks 1']) {
    const action = repeaterCliCommand(command)
    assert.equal(action.confirm, true)
    assert.match(action.warning, /extra multipart ACK/)
    assert.match(action.warning, /delivery or improved reliability is not guaranteed/)
    assert.match(action.warning, /Already queued ACKs are unaffected/)
    assert.match(action.warning, /local advert interval below 60 minutes to zero/)
    assert.match(action.warning, /does not prove ACKs were sent or the preference was saved/)
  }
  for (const command of ['get multi.acks ', 'set multi.acks', 'set multi.acks on', 'set multi.acks 2',
    'set multi.acks 01', 'set multi.acks 1 ', 'set multi.acks 0\nreboot']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command/)
  }
})

test('interference threshold requires exact bounded integers and confirmation', () => {
  assert.equal(repeaterCliCommand('get int.thresh').command, 'get int.thresh')
  for (const value of ['0', '1', '16', '255']) {
    assert.equal(repeaterCliCommand(`set int.thresh ${value}`).confirm, true)
  }
  for (const value of ['', '-1', '256', '00', '01', '1.0', '1e2', ' 1', '1 ',
    '1\n', '1\nreboot', '999999999999999999999']) {
    assert.throws(() => repeaterCliCommand(`set int.thresh ${value}`), /interference threshold/)
  }
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

test('airtime factor accepts bounded decimal values and requires confirmation', () => {
  assert.equal(repeaterCliCommand('get af').command, 'get af')
  for (const value of ['0', '0.01', '1', '8.99', '9', '9.00']) {
    assert.equal(repeaterCliCommand(`set af ${value}`).confirm, true)
  }
  for (const value of ['', '-1', '9.01', '10', '00', '0.001', '.5', '1e0', ' 1', '1 ', '1\n', '1\nreboot']) {
    assert.throws(() => repeaterCliCommand(`set af ${value}`), /airtime factor/)
  }
})

test('retransmission delay factors accept bounded decimal values and require confirmation', () => {
  for (const kind of ['txdelay', 'direct.txdelay']) {
    assert.equal(repeaterCliCommand(`get ${kind}`).command, `get ${kind}`)
    for (const value of ['0', '0.01', '0.5', '1', '1.99', '2', '2.00']) {
      assert.equal(repeaterCliCommand(`set ${kind} ${value}`).confirm, true)
    }
    for (const value of ['', '-1', '2.01', '3', '00', '0.001', '.5', '1e0', ' 1', '1 ', '1\n', '2\r', '1\u2028', '1\nreboot']) {
      assert.throws(() => repeaterCliCommand(`set ${kind} ${value}`), /retransmission delay factor/)
    }
  }
})

test('receive-delay base accepts bounded decimals and requires confirmation', () => {
  assert.equal(repeaterCliCommand('get rxdelay').command, 'get rxdelay')
  for (const value of ['0', '0.01', '0.5', '1', '9.99', '10', '19.99', '20', '20.00']) {
    assert.equal(repeaterCliCommand(`set rxdelay ${value}`).confirm, true)
  }
  for (const value of ['', '-1', '20.01', '21', '00', '0.001', '.5', '1e0', ' 1', '1 ', '1\n', '1\nreboot']) {
    assert.throws(() => repeaterCliCommand(`set rxdelay ${value}`), /receive-delay base/)
  }
})

test('transmit power uses the documented whole dBm range and requires confirmation', () => {
  assert.equal(repeaterCliCommand('get tx').command, 'get tx')
  for (const value of ['1', '9', '10', '21', '22']) {
    const command = repeaterTransmitPowerCommand(value)
    assert.equal(command.command, `set tx ${value}`)
    assert.equal(command.confirm, true)
    assert.equal(repeaterCliCommand(command.command).confirm, true)
  }
  for (const value of ['', '0', '-1', '23', '01', '1.5', '1e1', ' 1', '1 ', '999999999999999999999',
    '12\nreboot']) {
    assert.throws(() => repeaterTransmitPowerCommand(value), /transmit power from 1 to 22/)
    assert.throws(() => repeaterCliCommand(`set tx ${value}`), /transmit power from 1 to 22/)
  }
})

test('guest password changes are bounded, confirmation-gated, and never expose the getter', () => {
  for (const value of ['a', 'Guest-123', '!#$%&\'()*+,-.', 'x'.repeat(15)]) {
    const command = repeaterGuestPasswordCommand(value)
    assert.equal(command.command, `set guest.password ${value}`)
    assert.equal(command.confirm, true)
    assert.equal(repeaterCliCommand(command.command).confirm, true)
  }
  for (const value of ['', 'x'.repeat(16), 'with spaces', 'with|pipe', 'line\nbreak', 'café', '\u007f']) {
    assert.throws(() => repeaterGuestPasswordCommand(value), /guest password/)
    assert.throws(() => repeaterCliCommand(`set guest.password ${value}`), /guest password/)
  }
  assert.throws(() => repeaterCliCommand('get guest.password'), /supported/)
})

test('region inspection allows bounded names but rejects injected and unsupported commands', () => {
  for (const command of ['region', 'region home', 'region default']) {
    assert.equal(repeaterCliCommand(command).command, command)
  }
  for (const name of ['*', '#North', '$private', 'North-É']) {
    assert.equal(repeaterHomeRegionCommand(name).command, `region home ${name}`)
    assert.equal(repeaterCliCommand(`region home ${name}`).confirm, true)
  }
  for (const name of ['*', '#North', '$private', 'North-É', 'é'.repeat(15)]) {
    assert.equal(repeaterRegionQuery(name).command, `region get ${name}`)
    assert.equal(repeaterCliCommand(`region get ${name}`).command, `region get ${name}`)
  }
  for (const name of ['', '#', 'a b', 'a\tb', 'a\nregion save', 'a\0b', 'é'.repeat(16),
    'a\u0085b', '\ud800', '*x', 'bad/name']) {
    assert.throws(() => repeaterRegionQuery(name), /region name or prefix/)
  }
  for (const command of ['region load', 'region default North',
    'region denyf * extra',
    'region save extra', 'region get North\nregion save']) {
    assert.throws(() => repeaterCliCommand(command), /supported repeater CLI command|region name or prefix/)
  }
  for (const name of ['', '#', 'bad/name', 'a b', 'é'.repeat(16), 'North\nregion save']) {
    assert.throws(() => repeaterHomeRegionCommand(name), /region name or prefix/)
  }
  for (const command of ['region allowf *', 'region denyf *', 'region save', 'region home *']) {
    assert.equal(repeaterCliCommand(command).confirm, true)
  }
})

test('named region flood changes are validated and require confirmation', () => {
  for (const [action, allow] of [['allowf', true], ['denyf', false]]) {
    for (const name of ['#North', '$private', 'North-É', 'é'.repeat(15)]) {
      const command = repeaterRegionFloodCommand(name, allow)
      assert.equal(command.command, `region ${action} ${name}`)
      assert.equal(repeaterCliCommand(command.command).confirm, true)
      assert.match(command.warning, /OK reply does not identify/)
    }
    for (const name of ['', '#', 'bad/name', 'a b', 'é'.repeat(16), 'North\nregion save']) {
      assert.throws(() => repeaterRegionFloodCommand(name, allow), /region name or prefix/)
      assert.throws(() => repeaterCliCommand(`region ${action} ${name}`), /region name or prefix/)
    }
  }
})

test('region put validates names and always requires confirmation', () => {
  for (const name of ['#North', '$private', 'North', 'a'.repeat(29), `#${'a'.repeat(29)}`,
    `$${'a'.repeat(29)}`, `${'a'.repeat(27)}é`, `#${'a'.repeat(27)}é`]) {
    const command = repeaterRegionPutCommand(name)
    assert.equal(command.command, `region put ${name}`)
    assert.equal(repeaterCliCommand(command.command).confirm, true)
    assert.match(command.warning, /moved rather than created/)
  }
  for (const name of ['', '*', '#', 'bad/name', 'North root', 'a'.repeat(30), `${'a'.repeat(28)}é`,
    `#${'a'.repeat(30)}`, `$${'a'.repeat(30)}`, 'North\nregion save']) {
    assert.throws(() => repeaterRegionPutCommand(name), /region name|named region/)
    assert.throws(() => repeaterCliCommand(`region put ${name}`), /region name|named region/)
  }
})

test('region removal accepts exact names and requires confirmation', () => {
  for (const name of ['North', '#North', '$private', 'a'.repeat(30), '#'.concat('é'.repeat(14), 'a')]) {
    const command = repeaterRegionRemoveCommand(name)
    assert.equal(command.command, `region remove ${name}`)
    assert.equal(repeaterCliCommand(command.command).confirm, true)
    assert.match(command.warning, /does not reset the home reference/)
    assert.match(command.warning, /home query may misleadingly report \*/)
    assert.match(command.warning, /Private keys are not removed/)
  }
  for (const name of ['', '*', '#', 'bad/name', 'North South', 'a'.repeat(31), 'North\nregion save']) {
    assert.throws(() => repeaterRegionRemoveCommand(name), /region name|named region/)
    assert.throws(() => repeaterCliCommand(`region remove ${name}`), /region name|named region/)
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

test('advert path hash size is restricted to the three firmware modes and requires confirmation', () => {
  assert.equal(repeaterCliCommand('get path.hash.mode').command, 'get path.hash.mode')
  for (const mode of ['0', '1', '2']) {
    const command = repeaterCliCommand(`set path.hash.mode ${mode}`)
    assert.equal(command.confirm, true)
    assert.match(command.description, new RegExp(mode))
  }
  for (const command of ['set path.hash.mode', 'set path.hash.mode 3', 'set path.hash.mode 255',
    'set path.hash.mode -1', 'set path.hash.mode 01', 'set path.hash.mode 1 ',
    'set path.hash.mode 1 extra', 'set path.hash.mode 2\nreboot']) {
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
