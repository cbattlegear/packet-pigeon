import { contactPublicKey } from './contact-commands.ts'
import { decodeDirectSent, directMessageCommand } from './direct-message.ts'
import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

const receiverGainWarning = 'Support depends on the repeater radio and firmware build. Changing gain may affect reception and power use. OK or matching read-back does not prove the radio applied the preference or saved it successfully. On some unsupported builds, a gain query returns radio parameters instead of on/off. In v1.14.1, saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent.'
const multiAckWarning = 'In repeater firmware v1.14.1, enabling this attempts to queue one extra multipart ACK when forwarding an eligible direct ACK, and can delay the normal ACK. It can use more airtime; other nodes may not support multipart ACKs, and delivery or improved reliability is not guaranteed. Already queued ACKs are unaffected. Firmware support varies. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove ACKs were sent or the preference was saved.'
const gpsWarning = 'GPS support depends on the repeater firmware and hardware. Enabling GPS can expose sensor coordinates in location telemetry and later advertisements when the advert policy is share; it may also change the device clock and disrupt later commands. Disabling GPS does not erase previously stored coordinates or recall queued or sent locations, and some boards cannot power off the receiver. In v1.14.1, saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An ok reply does not prove a fix, hardware state, or persistence; request the GPS activity setting separately.'
const bridgeSourceWarning = 'Changing the source can expose different mesh packets to the external bridge and affect routing or remote access. It does not stop packets entering from the bridge. In repeater v1.14.1, rx selects received packets and tx selects transmitted packets; the change applies to subsequent observations and attempts to save the preference. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove packets were bridged or the setting was saved. A delayed command may arrive later; firmware and build support vary.'

export const repeaterAdcMultiplierSafety = 'An incorrect multiplier can misreport battery voltage and affect battery-dependent behavior, including power management on some boards. Check board guidance and compare with an independently measured voltage. Zero requests the board default. Support varies by hardware and firmware.'
export const repeaterAdcMultiplierCaveats = 'In v1.14.1, a supported query returns the board-reported multiplier to three decimals, not whether it is the default or an override. An unsupported change resets the in-memory preference to zero, which a later save may persist. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove accurate voltage or persistence. Sync replies and read the multiplier and battery status separately; a delayed change may still arrive later.'
export const repeaterAdcMultiplierWarning = `${repeaterAdcMultiplierSafety} ${repeaterAdcMultiplierCaveats}`

export const repeaterRadioSettingsSafety = 'Changing radio parameters can disconnect this repeater from the mesh and prevent remote access. Check the board, local regulations, channel plan and recovery method before proceeding. Accepted input ranges do not guarantee hardware support or legal operation.'
export const repeaterRadioSettingsCaveats = 'In repeater v1.14.1 these preferences normally apply at reboot, but can apply sooner when an existing temporary radio override expires. A reboot or override may be initiated elsewhere. The reply does not prove persistence or successful application. Read-back reports preferences, not active radio settings; frequency uses floating-point precision and bandwidth is rounded to three decimals. Read-back can require more precision than this control accepts. A delayed change may arrive after a later read or change. Reboot is a separate action and is not sent automatically.'
export const repeaterRadioSettingsWarning = `${repeaterRadioSettingsSafety} ${repeaterRadioSettingsCaveats}`

export const repeaterTempRadioWarning = 'This can quickly disrupt mesh routes and remote access. Check the board, local regulations, channel plan and recovery method first; accepted ranges do not guarantee hardware support or legality. In repeater v1.14.1 the override is scheduled about 2 seconds after receipt and replaces an existing override without saving preferences. The reply may not transmit before the switch. On expiry the firmware attempts to apply its then-current preferences, not necessarily the previous active settings. A timer may be skipped if its target wraps to zero. Changes by another administrator, a reboot or a failed radio operation can also affect the outcome; automatic recovery is not guaranteed. A reply does not prove application or restoration. Delayed commands may still arrive later; get radio reports preferences, not active settings.'

export const repeaterClockWarning = 'Verify this UTC time against a trusted clock. Repeater v1.14.1 only moves its clock forward; a clock set too far ahead may disrupt later commands and cannot be corrected backwards with this action. The specified time is fixed and can be behind by the time the command arrives. GPS or another administrator may also change the clock. Firmware support varies. Sync the reply and read the clock separately; a delayed change may still arrive later.'

export const repeaterClockRebootWarning = 'Recovery action: repeater v1.14.1 attempts to set its clock to 2024-05-15 10:52:31 UTC, then reboot without a reply. This can move the clock backwards and disrupt time-sensitive messages, advertisements and remote access. The reboot can interrupt mesh traffic, lose unsaved access-list or region changes, and cancel temporary radio overrides. Check a local recovery method first. Firmware and clock hardware may behave differently; radio acceptance does not prove execution or that the clock stayed reset. A delayed command may still arrive later. Log in again, then read and set the clock separately using a trusted time; GPS or another administrator may change it again.'

export const repeaterBridgeDelayWarning = 'Changing the delay can affect latency, packet loss, routes and remote access. In repeater v1.14.1 it schedules packets entering from the bridge for later mesh processing, not packets sent to the bridge. Already queued packets retain their scheduled time. Zero removes this added delay but does not guarantee immediate processing; packets can be dropped if the queue is full. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove actual timing or persistence. A delayed command may arrive later; firmware and build support vary.'

export const repeaterBridgeChannelWarning = 'Changing the ESP-NOW channel can disconnect bridge peers, interrupt routes and prevent remote access. Verify peer settings, local regulations, device support and a local recovery method first; the accepted range does not guarantee a legal or supported channel. In repeater v1.14.1, a running bridge turns Wi-Fi off before attempting an immediate restart; a stopped bridge is not started. Restart or saving can fail. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove the channel was applied, a peer is connected, or the setting was saved. A delayed command may arrive later; firmware and build support vary.'

export const repeaterBridgeBaudWarning = 'Changing the RS-232 baud rate can interrupt bridge traffic, routes and remote access. Check the peer baud rate, device support and a local recovery method first; the accepted range does not guarantee that the hardware or peer supports the rate. In repeater v1.14.1, a running bridge immediately attempts to restart its serial interface; a stopped bridge is not started. In-flight data may be lost, and partial received frames may remain across the restart. Saving can fail and also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An OK reply or matching read-back does not prove the interface or peer is working or the setting was saved. A delayed command may arrive later; firmware and build support vary.'

export const repeaterCliCommands = [
  { command: 'ver', description: 'Read the firmware version' },
  { command: 'board', description: 'Read the board manufacturer' },
  { command: 'get bootloader.ver', description: 'Read the bootloader version' },
  { command: 'clock', description: 'Read the repeater clock' },
  { command: 'clock sync', description: 'Sync repeater clock from the connected radio', confirm: true,
    warning: 'Check the radio clock in Settings first. The repeater cannot move its clock backwards; a clock set too far ahead may disrupt later commands. Older companion firmware can cause the repeater to ignore this request.' },
  { command: 'clear stats', description: 'Reset repeater statistics', confirm: true,
    warning: 'This irreversibly clears packet and duplicate counters and error flags. In repeater v1.14.1, uptime, cumulative airtime, transmit budget, signal readings and duplicate caches are not reset. Counters can increase immediately, including when the reply is sent. Firmware support varies. An OK reply does not verify every effect. Request status separately; a delayed reset may still arrive after a new status read.' },
  { command: 'log start', description: 'Start repeater packet logging', confirm: true,
    warning: 'Repeater v1.14.1 records packet metadata, including timestamps and some address prefixes, on the repeater. This may expose traffic patterns and consume storage. Logging remains active until stopped or rebooted and may append to an existing log. Storage writes can fail; a reply does not prove that records were saved. The log cannot be read remotely by this app. A delayed command may still arrive later; firmware behavior varies.' },
  { command: 'log stop', description: 'Stop repeater packet logging', confirm: true,
    warning: 'Stopping does not erase the existing log or its backups. Records can be written until this command is processed, and a delayed start or another administrator can enable logging again. A reply does not prove the current state; firmware behavior varies.' },
  { command: 'log erase', description: 'Erase repeater packet log', confirm: true,
    warning: 'This can permanently delete the repeater packet log. It does not stop logging; if logging is active, the file can be recreated immediately. In v1.14.1 the reply does not report whether removal succeeded. Erasure does not guarantee secure deletion or remove backups. A delayed erase may remove later records; firmware behavior varies.' },
  { command: 'neighbors', description: 'List recently heard neighbors' },
  { command: 'discover.neighbors', description: 'Discover nearby repeaters', confirm: true,
    warning: 'Supported by repeater firmware v1.14.1; support on other builds varies. This asks the repeater to broadcast a zero-hop discovery request; nearby repeaters may also transmit replies. It replaces any discovery already in progress. Replies may update the limited neighbor cache and evict older entries. Discovery responses are unauthenticated and do not prove identity. An OK reply does not prove a broadcast occurred or that any neighbors replied. Wait up to 60 seconds, then request neighbors separately; old entries may remain and the list can be incomplete.' },
  { command: 'get name', description: 'Read the advertised name' },
  { command: 'get public.key', description: 'Read the reported public key' },
  { command: 'get role', description: 'Read the firmware role' },
  { command: 'get pwrmgt.support', description: 'Read power-management support' },
  { command: 'get pwrmgt.source', description: 'Read reported power source' },
  { command: 'get pwrmgt.bootreason', description: 'Read boot reset and shutdown reasons' },
  { command: 'get pwrmgt.bootmv', description: 'Read voltage recorded at boot' },
  { command: 'get adc.multiplier', description: 'Read battery ADC multiplier' },
  { command: 'get bridge.type', description: 'Read compiled bridge type' },
  { command: 'get bridge.enabled', description: 'Read bridge enabled preference' },
  { command: 'get bridge.delay', description: 'Read bridge delay preference' },
  { command: 'get bridge.source', description: 'Read bridge packet source preference' },
  { command: 'get bridge.baud', description: 'Read RS-232 bridge baud preference' },
  { command: 'get bridge.channel', description: 'Read ESP-NOW bridge channel preference' },
  { command: 'set bridge.enabled on', description: 'Enable repeater bridge', confirm: true,
    warning: 'A bridge can expose mesh packets to an external interface and introduce packets from it into the mesh. Verify the interface, peer and local recovery method first. Repeater v1.14.1 attempts to start the bridge immediately and save the preference; initialization or saving can fail. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. A reply or preference read-back does not prove the bridge is working or saved. A delayed command may arrive later; firmware and build support vary.' },
  { command: 'set bridge.enabled off', description: 'Disable repeater bridge', confirm: true,
    warning: 'Disabling the bridge can interrupt routes and remote access that depend on it. Packets already queued can still be processed. Repeater v1.14.1 attempts to stop the bridge immediately and save the preference. Saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. A reply or preference read-back does not prove the bridge stopped or was saved. A delayed command may arrive later; firmware and build support vary.' },
  { command: 'set bridge.source rx', description: 'Bridge received radio packets', confirm: true, warning: bridgeSourceWarning },
  { command: 'set bridge.source tx', description: 'Bridge transmitted radio packets', confirm: true, warning: bridgeSourceWarning },
  { command: 'powersaving', description: 'Read repeater power-saving preference' },
  { command: 'powersaving on', description: 'Enable repeater power-saving preference', confirm: true,
    warning: 'Depending on the board and firmware, the repeater may sleep when idle and be less responsive. An on reply reports the preference, not actual sleep. Verify the reply and preference.' },
  { command: 'powersaving off', description: 'Disable repeater power-saving preference', confirm: true,
    warning: 'This may increase repeater power consumption on boards that support sleep. Firmware support varies; verify the reply and preference.' },
  { command: 'get radio', description: 'Read radio parameter preferences' },
  { command: 'get radio.rxgain', description: 'Read receiver boosted-gain preference' },
  { command: 'get agc.reset.interval', description: 'Read AGC reset interval' },
  { command: 'get int.thresh', description: 'Read interference threshold' },
  { command: 'get multi.acks', description: 'Read extra direct ACK preference' },
  { command: 'set multi.acks 1', description: 'Enable extra direct ACKs', confirm: true, warning: multiAckWarning },
  { command: 'set multi.acks 0', description: 'Disable extra direct ACKs', confirm: true, warning: multiAckWarning },
  { command: 'set radio.rxgain on', description: 'Enable receiver boosted-gain preference', confirm: true,
    warning: receiverGainWarning },
  { command: 'set radio.rxgain off', description: 'Disable receiver boosted-gain preference', confirm: true,
    warning: receiverGainWarning },
  { command: 'get tx', description: 'Read stored transmit power preference' },
  { command: 'get repeat', description: 'Read forwarding mode' },
  { command: 'get af', description: 'Read airtime factor' },
  { command: 'get rxdelay', description: 'Read receive-delay base' },
  { command: 'get txdelay', description: 'Read flood retransmission delay factor' },
  { command: 'get direct.txdelay', description: 'Read direct retransmission delay factor' },
  { command: 'get flood.max', description: 'Read the overall flood hop limit' },
  { command: 'get flood.max.unscoped', description: 'Read the unscoped flood hop limit' },
  { command: 'get flood.max.advert', description: 'Read the flood advertisement hop limit' },
  { command: 'get loop.detect', description: 'Read flood loop detection mode' },
  { command: 'get path.hash.mode', description: 'Read advert path hash size' },
  { command: 'region', description: 'Read the region tree' },
  { command: 'region home', description: 'Read the home region' },
  { command: 'region default', description: 'Read the default scope region' },
  { command: 'region list allowed', description: 'List regions with flood permission' },
  { command: 'region list denied', description: 'List regions without flood permission' },
  { command: 'region home *', description: 'Set the home region to the wildcard', confirm: true,
    warning: 'This changes the active home-region setting. Firmware may resolve a prefix to a different region; check the reply and tree. The change is not saved until region save, which writes the entire region map.' },
  { command: 'region allowf *', description: 'Allow unscoped flood forwarding', confirm: true,
    warning: 'Other routing rules can still block forwarding. This changes the live region map but does not save it.' },
  { command: 'region denyf *', description: 'Deny unscoped flood forwarding', confirm: true,
    warning: 'This can disrupt mesh routes and remote access. The live region map changes without being saved.' },
  { command: 'region save', description: 'Save the entire region map', confirm: true,
    warning: 'This saves all current region settings, including unrelated changes made by other administrators.' },
  { command: 'set repeat on', description: 'Enable packet forwarding', confirm: true,
    warning: 'Forwarding is still subject to the repeater routing and region settings.' },
  { command: 'set repeat off', description: 'Disable packet forwarding', confirm: true,
    warning: 'This stops the repeater forwarding packets and can disrupt mesh routes. Some firmware also stops responding to discovery requests.' },
  { command: 'get advert.interval', description: 'Read the local advert interval' },
  { command: 'get flood.advert.interval', description: 'Read the flood advert interval' },
  { command: 'get lat', description: 'Read stored latitude' },
  { command: 'get lon', description: 'Read stored longitude' },
  { command: 'sensor get gps', description: 'Read GPS activity setting' },
  { command: 'gps on', description: 'Enable GPS receiver', confirm: true, warning: gpsWarning },
  { command: 'gps off', description: 'Disable GPS receiver', confirm: true, warning: gpsWarning },
  { command: 'gps sync', description: 'Request GPS clock synchronization', confirm: true,
    warning: 'This does not enable GPS. On repeater v1.14.1, an ok reply only acknowledges the request, not a fix or clock change; some providers do not apply it. A supported provider may change the clock later, even after a read-back, and may move it forwards or backwards, disrupting later commands. GPS may already adjust the clock automatically. Firmware and hardware support vary. Sync replies and read the clock separately.' },
  { command: 'gps setloc', description: 'Copy sensor coordinates to stored position', confirm: true,
    warning: 'This replaces both stored coordinates with the sensor values, which may be stale or zero even without a GPS fix or receiver. New advertisements can publish them when the policy is prefs. This does not send an advertisement or recall queued or sent locations. In v1.14.1, saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent. An ok reply does not prove a valid fix or persistence. Sync replies and read both stored coordinates separately.' },
  { command: 'gps advert', description: 'Read GPS advert policy' },
  { command: 'gps advert none', description: 'Set GPS advert policy to none', confirm: true,
    warning: 'If applied, new advertisements omit location, but already queued or transmitted locations cannot be recalled. This does not send an advertisement. Some firmware builds do not support this command; check the reply and read the policy.' },
  { command: 'gps advert prefs', description: 'Set GPS advert policy to prefs', confirm: true,
    warning: 'If applied, new advertisements can publish the stored coordinates over the mesh. This does not send an advertisement. Some firmware builds do not support this command; check the reply and read the policy.' },
  { command: 'gps advert share', description: 'Set GPS advert policy to share', confirm: true,
    warning: 'If applied, new advertisements can publish sensor coordinates over the mesh. Coordinates may be stale or zero; this does not enable GPS or send an advertisement. Some firmware builds do not support this command; check the reply and read the policy.' },
  { command: 'get owner.info', description: 'Read operator information' },
  { command: 'reboot', description: 'Reboot the repeater', confirm: true,
    warning: 'The repeater may be unavailable and mesh traffic may be interrupted. No reply is expected; radio acceptance does not prove a reboot.' },
  { command: 'clkreboot', description: 'Reset repeater clock and reboot', confirm: true, warning: repeaterClockRebootWarning },
  { command: 'advert', description: 'Send a flood advertisement', confirm: true },
  { command: 'advert.zerohop', description: 'Send a zero-hop advertisement', confirm: true },
] as const

export function isRepeaterRebootCommand(command: string): boolean {
  return command === 'reboot' || command === 'clkreboot'
}

export type RepeaterCliReceipt = {
  tag: string
  route: 'direct' | 'flood'
  timeoutMs: number
}

export type RepeaterNeighbor = {
  keyPrefix: string
  secondsAgo: number
  snrQuarterDb: number
}

export function compareRepeaterPublicKey(reply: string, expectedKey: string): 'match' | 'mismatch' | 'unrecognized' {
  const match = /^> ([0-9a-f]{64})$/i.exec(reply)
  if (!match) return 'unrecognized'
  return match[1].toLowerCase() === expectedKey.toLowerCase() ? 'match' : 'mismatch'
}

export function parseRepeaterNeighbors(reply: string): RepeaterNeighbor[] {
  if (reply === '-none-') return []
  if (!reply || reply.length > 4096) throw new Error('The repeater returned an invalid neighbor list.')
  const lines = reply.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 64) throw new Error('The repeater returned too many neighbor records.')
  return lines.map((line) => {
    const match = /^([0-9a-f]{8}):([0-9]+):(-?[0-9]+)$/i.exec(line)
    if (!match) throw new Error('The repeater returned an unrecognized neighbor record.')
    const secondsAgo = Number(match[2])
    const snrQuarterDb = Number(match[3])
    if (!Number.isSafeInteger(secondsAgo) || secondsAgo > 0xffff_ffff
      || !Number.isSafeInteger(snrQuarterDb) || snrQuarterDb < -0x8000 || snrQuarterDb > 0x7fff) {
      throw new Error('The repeater returned an out-of-range neighbor record.')
    }
    return { keyPrefix: match[1].toLowerCase(), secondsAgo, snrQuarterDb }
  })
}

export class UncertainRepeaterCliError extends Error {
  readonly tag: string

  constructor(tag: string, cause: unknown) {
    super('The radio may have sent this command, but did not confirm it. Check for a reply before retrying.', { cause })
    this.tag = tag
  }
}

export function repeaterOwnerInfoCommand(value: string) {
  if (value.includes('|')) throw new Error('Owner information cannot contain |; use a line break instead.')
  return repeaterCliCommand(`set owner.info ${value.replace(/\r\n/g, '\n').replace(/\n/g, '|')}`)
}

export function repeaterPositionCommand(axis: 'lat' | 'lon', value: string) {
  validatePosition(axis, value)
  return repeaterCliCommand(`set ${axis} ${value}`)
}

export function repeaterTransmitPowerCommand(value: string) {
  return repeaterCliCommand(`set tx ${value}`)
}

export function repeaterClockCommand(value: string) {
  const normalized = value.length === 16 ? `${value}:00` : value
  const timestamp = Date.parse(`${normalized}Z`) / 1000
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized) ||
    !Number.isInteger(timestamp) || timestamp < 1 || timestamp > 0xffff_ffff ||
    new Date(timestamp * 1000).toISOString() !== `${normalized}.000Z`) {
    throw new Error('Enter a valid UTC time from 1970-01-01 00:00:01 through 2106-02-07 06:28:15.')
  }
  return repeaterCliCommand(`time ${timestamp}`)
}

function validateGuestPassword(value: string) {
  const bytes = new TextEncoder().encode(value)
  if (!value || bytes.length > 15 || bytes.some((byte) => byte < 33 || byte > 126 || byte === 124) ||
    new TextDecoder().decode(bytes) !== value) {
    throw new Error('Enter a guest password of 1–15 printable ASCII characters without spaces or |.')
  }
}

export function repeaterGuestPasswordCommand(value: string) {
  validateGuestPassword(value)
  return repeaterCliCommand(`set guest.password ${value}`)
}

export const repeaterRemoveNeighborWarning = 'The neighbor list shows only four-byte prefixes, which can collide; verify the full public key independently. ' +
  'This removes matching entries from the repeater neighbor cache, not access or future discovery. The neighbor can reappear when heard again. ' +
  'In repeater firmware v1.14.1, OK is returned even if no entry matched. Older snapshots and maps remain stale; a new neighbor list can be incomplete. Firmware support varies.'

export function repeaterRemoveNeighborCommand(value: string) {
  const key = contactPublicKey(value)
  return {
    command: `neighbor.remove ${key}`,
    description: 'Remove neighbor from repeater cache',
    confirm: true as const,
    neighborTarget: key,
    warning: repeaterRemoveNeighborWarning,
  }
}

export function repeaterRemoveAccessCommand(value: string) {
  const accessTarget = contactPublicKey(value)
  return {
    command: `setperm ${accessTarget} 0`,
    description: 'Remove repeater access-list entry',
    confirm: true as const,
    accessTarget,
    warning: 'This removes the entire entry, not its passwords. The client can log in again with a valid password; a blank guest password may allow guest access. The connected radio and repeater cannot be removed here. Repeater firmware v1.14.1 may misdirect the reply after removal. An OK reply does not verify persistence: saving is delayed and can fail. The access list can omit entries, so absence does not prove removal.',
  }
}

export const repeaterGrantAdminWarning = 'This grants full administrator control, including password changes, access changes and reboot. ' +
  'Verify the complete public key independently; access-list prefixes can collide. The client can log in without the password while its entry remains. ' +
  'Existing permission bits are replaced. On repeater firmware v1.14.1, adding a new entry to a full table can evict another client, even an administrator or the connected radio, and may misdirect the reply. ' +
  'The reported login role may then be stale. Logging in again can also evict an entry if the table is full. ' +
  'Saving is delayed and can fail; an OK reply does not verify persistence. The access list can omit entries, so it cannot prove the complete state.'

export function repeaterGrantAdminCommand(value: string) {
  const accessTarget = contactPublicKey(value)
  return {
    command: `setperm ${accessTarget} 3`,
    description: 'Grant repeater administrator access',
    confirm: true as const,
    accessTarget,
    warning: repeaterGrantAdminWarning,
  }
}

export const repeaterLimitedAccessWarning = 'Read-only and read-write are generic ACL role names; repeater v1.14.1 treats both as non-admin and they do not imply distinct repeater capabilities. They may allow more telemetry than guest access; other firmware may differ. ' +
  'Verify the complete public key independently; access-list prefixes can collide. The client can log in without the password while its entry remains. ' +
  'This replaces all permission bits and can demote an administrator, but does not change passwords; a client with the administrator password may regain admin access. ' +
  'On repeater firmware v1.14.1, adding a new entry to a full table can evict another client, even an administrator or the connected radio, and may misdirect the reply. ' +
  'The reported login role may then be stale. Logging in again can also evict an entry if the table is full. ' +
  'Saving is delayed and can fail; an OK reply does not verify persistence. The access list can omit entries, so it cannot prove the complete state.'

export function repeaterLimitedAccessCommand(value: string, role: 'read-only' | 'read-write') {
  if (role !== 'read-only' && role !== 'read-write') throw new Error('Choose a supported non-admin role.')
  const accessTarget = contactPublicKey(value)
  return {
    command: `setperm ${accessTarget} ${role === 'read-only' ? 1 : 2}`,
    description: `Set repeater client role to ${role}`,
    confirm: true as const,
    accessTarget,
    warning: repeaterLimitedAccessWarning,
  }
}

export function repeaterNameCommand(value: string) {
  return repeaterCliCommand(`set name ${value}`)
}

export function repeaterRegionQuery(value: string) {
  validateRegionName(value)
  return { command: `region get ${value}`, description: `Read region ${value}` }
}

function validateRegionName(value: string) {
  const bytes = new TextEncoder().encode(value)
  if (value !== '*' && (!value || value === '#' || bytes.length > 30 ||
    new TextDecoder().decode(bytes) !== value || /[\s\p{Cc}]/u.test(value) ||
    bytes.some((byte) => byte !== 35 && byte !== 36 && byte !== 45 &&
      !(byte >= 48 && byte <= 57) && !(byte >= 65 && byte !== 127)))) {
    throw new Error('Enter * or a valid region name or prefix of up to 30 UTF-8 bytes without spaces or control characters.')
  }
}

export function repeaterHomeRegionCommand(value: string) {
  validateRegionName(value)
  return {
    command: `region home ${value}`,
    description: value === '*' ? 'Set home region to the wildcard' : `Set repeater home region to ${value}`,
    confirm: true as const,
    warning: 'Firmware prefers an exact name but may resolve an incomplete prefix to a different region. Read the reply and home setting after changing it. This change is not saved until region save, which writes the entire region map.',
  }
}

export function repeaterRegionFloodCommand(value: string, allow: boolean) {
  validateRegionName(value)
  return {
    command: `region ${allow ? 'allowf' : 'denyf'} ${value}`,
    description: `${allow ? 'Allow' : 'Deny'} flood forwarding for region ${value}`,
    confirm: true as const,
    warning: 'Firmware may match a different region, and its OK reply does not identify the changed entry. Read and compare the region before and after changing it; read-back uses the same matching and cannot eliminate ambiguity. Denying can disrupt routes and remote access; allowing does not override other rules. This change is not saved until the separate region-map save.',
  }
}

export function repeaterRegionPutCommand(value: string) {
  validateRegionName(value)
  if (value === '*') throw new Error('Enter a named region, not the wildcard.')
  // Firmware prepends '#' in a fixed-size buffer when matching unprefixed names.
  if (!value.startsWith('#') && !value.startsWith('$') && new TextEncoder().encode(value).length > 29) {
    throw new Error('An unprefixed region name must be at most 29 UTF-8 bytes.')
  }
  return {
    command: `region put ${value}`,
    description: `Add or move region ${value} under the wildcard`,
    confirm: true as const,
    warning: 'An existing exact name, including one differing only by a leading #, is moved rather than created. New regions deny floods by default; existing permissions are preserved. Changes can affect routing and remote access. This change is not saved until the separate region-map save, which saves the entire map.',
  }
}

export function repeaterRegionRemoveCommand(value: string) {
  validateRegionName(value)
  if (value === '*') throw new Error('Enter a named region, not the wildcard.')
  return {
    command: `region remove ${value}`,
    description: `Remove region ${value}`,
    confirm: true as const,
    warning: 'Firmware removes an exact name, including one differing only by a leading #, and refuses regions with children. Removing a region can disrupt routes and remote access. Set another home region first if needed: removal does not reset the home reference, and a later home query may misleadingly report *. Private keys are not removed. This change is not saved until the separate region-map save, which saves the entire map.',
  }
}

function validatePosition(axis: 'lat' | 'lon', value: string) {
  const maximum = axis === 'lat' ? 90 : 180
  const coordinate = Number(value)
  const match = /^-?\d+(?:\.\d{1,6})?$/.exec(value)
  if (!match || match[0] !== value || !Number.isFinite(coordinate) ||
    coordinate < -maximum || coordinate > maximum) {
    throw new Error(`Enter a ${axis === 'lat' ? 'latitude from -90 to 90' : 'longitude from -180 to 180'} with up to 6 decimal places.`)
  }
}

function validateRadioParams(value: string) {
  const match = /^((?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?),((?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?),([5-9]|1[0-2]),([5-8])$/.exec(value)
  if (!match || match[0] !== value || Number(match[1]) < 400 || Number(match[1]) > 2500 ||
    Number(match[2]) < 7.8 || Number(match[2]) > 500) {
    throw new Error('Enter frequency 400–2500 MHz and bandwidth 7.8–500 kHz with up to 3 decimals, spreading factor 5–12, and coding rate 5–8.')
  }
}

export function repeaterCliCommand(command: string) {
  const found = repeaterCliCommands.find((item) => item.command === command)
  if (found) return found
  const clock = /^time ([1-9][0-9]*)$/.exec(command)
  if (clock && clock[0] === command && Number(clock[1]) <= 0xffff_ffff) {
    return { command, description: 'Set repeater clock', confirm: true as const, warning: repeaterClockWarning }
  }
  const removeNeighbor = /^neighbor\.remove ([0-9a-f]{64})$/i.exec(command)
  if (removeNeighbor && removeNeighbor[0] === command) return repeaterRemoveNeighborCommand(removeNeighbor[1])
  const removeAccess = /^setperm ([0-9a-f]{64}) 0$/i.exec(command)
  if (removeAccess && removeAccess[0] === command) return repeaterRemoveAccessCommand(removeAccess[1])
  const grantAdmin = /^setperm ([0-9a-f]{64}) 3$/i.exec(command)
  if (grantAdmin && grantAdmin[0] === command) return repeaterGrantAdminCommand(grantAdmin[1])
  const limitedAccess = /^setperm ([0-9a-f]{64}) ([12])$/i.exec(command)
  if (limitedAccess && limitedAccess[0] === command) {
    return repeaterLimitedAccessCommand(limitedAccess[1], limitedAccess[2] === '1' ? 'read-only' : 'read-write')
  }
  const homeRegionPrefix = 'region home '
  if (command.startsWith(homeRegionPrefix)) return repeaterHomeRegionCommand(command.slice(homeRegionPrefix.length))
  const regionPrefix = 'region get '
  if (command.startsWith(regionPrefix)) return repeaterRegionQuery(command.slice(regionPrefix.length))
  const regionPutPrefix = 'region put '
  if (command.startsWith(regionPutPrefix)) return repeaterRegionPutCommand(command.slice(regionPutPrefix.length))
  const regionRemovePrefix = 'region remove '
  if (command.startsWith(regionRemovePrefix)) return repeaterRegionRemoveCommand(command.slice(regionRemovePrefix.length))
  const regionFlood = /^region (allowf|denyf) ([\s\S]*)$/.exec(command)
  if (regionFlood) return repeaterRegionFloodCommand(regionFlood[2], regionFlood[1] === 'allowf')
  const namePrefix = 'set name '
  if (command.startsWith(namePrefix)) {
    const value = command.slice(namePrefix.length)
    const bytes = new TextEncoder().encode(value)
    if (!value || value !== value.trim() || bytes.length > 31 ||
      bytes.some((byte) => byte < 32 || byte === 127) ||
      [...'[]/\\:,?*'].some((character) => value.includes(character)) ||
      new TextDecoder().decode(bytes) !== value) {
      throw new Error('Enter a name of 1 to 31 UTF-8 bytes without leading or trailing spaces, control characters, or []/\\:,?*.')
    }
    return { command, description: 'Set repeater name', confirm: true as const }
  }
  const txPowerPrefix = 'set tx '
  if (command.startsWith(txPowerPrefix)) {
    const value = command.slice(txPowerPrefix.length)
    if (!/^(?:[1-9]|1[0-9]|2[0-2])$/.test(value)) {
      throw new Error('Enter a whole repeater transmit power from 1 to 22 dBm.')
    }
    return { command, description: 'Set repeater transmit power', confirm: true as const }
  }
  const radioPrefix = 'set radio '
  if (command.startsWith(radioPrefix)) {
    validateRadioParams(command.slice(radioPrefix.length))
    return { command, description: 'Set repeater radio preferences', confirm: true as const, warning: repeaterRadioSettingsWarning }
  }
  const tempRadioPrefix = 'tempradio '
  if (command.startsWith(tempRadioPrefix)) {
    const value = command.slice(tempRadioPrefix.length)
    const separator = value.lastIndexOf(',')
    validateRadioParams(value.slice(0, separator))
    const duration = value.slice(separator + 1)
    const durationMatch = /^[1-9][0-9]*$/.exec(duration)
    if (!durationMatch || durationMatch[0] !== duration || Number(duration) > 35791) {
      throw new Error('Enter a whole override duration from 1 to 35791 minutes.')
    }
    return { command, description: 'Set temporary radio override', confirm: true as const, warning: repeaterTempRadioWarning }
  }
  const adcMultiplierPrefix = 'set adc.multiplier '
  if (command.startsWith(adcMultiplierPrefix)) {
    const value = command.slice(adcMultiplierPrefix.length)
    const match = /^(?:0|[1-9]|10)(?:\.[0-9]{1,3})?$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 10) {
      throw new Error('Enter a battery ADC multiplier from 0 to 10 with up to 3 decimal places.')
    }
    return { command, description: 'Set battery ADC multiplier', confirm: true as const, warning: repeaterAdcMultiplierWarning }
  }
  const agcResetPrefix = 'set agc.reset.interval '
  if (command.startsWith(agcResetPrefix)) {
    const value = command.slice(agcResetPrefix.length)
    const match = /^(0|[1-9][0-9]*)$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 1020 || Number(value) % 4 !== 0) {
      throw new Error('Enter an AGC reset interval from 0 to 1020 seconds in multiples of 4.')
    }
    return { command, description: 'Set AGC reset interval', confirm: true as const }
  }
  const bridgeDelayPrefix = 'set bridge.delay '
  if (command.startsWith(bridgeDelayPrefix)) {
    const value = command.slice(bridgeDelayPrefix.length)
    const match = /^(0|[1-9][0-9]*)$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 10000) {
      throw new Error('Enter a whole bridge delay from 0 to 10000 milliseconds.')
    }
    return { command, description: 'Set bridge inbound delay', confirm: true as const, warning: repeaterBridgeDelayWarning }
  }
  const bridgeChannelPrefix = 'set bridge.channel '
  if (command.startsWith(bridgeChannelPrefix)) {
    const value = command.slice(bridgeChannelPrefix.length)
    const match = /^(?:[1-9]|1[0-4])$/.exec(value)
    if (!match || match[0] !== value) {
      throw new Error('Enter a whole ESP-NOW bridge channel from 1 to 14.')
    }
    return { command, description: 'Set ESP-NOW bridge channel', confirm: true as const, warning: repeaterBridgeChannelWarning }
  }
  const bridgeBaudPrefix = 'set bridge.baud '
  if (command.startsWith(bridgeBaudPrefix)) {
    const value = command.slice(bridgeBaudPrefix.length)
    const match = /^[1-9][0-9]*$/.exec(value)
    if (!match || match[0] !== value || Number(value) < 9600 || Number(value) > 115200) {
      throw new Error('Enter a whole RS-232 bridge baud rate from 9600 to 115200.')
    }
    return { command, description: 'Set RS-232 bridge baud rate', confirm: true as const, warning: repeaterBridgeBaudWarning }
  }
  const interferencePrefix = 'set int.thresh '
  if (command.startsWith(interferencePrefix)) {
    const value = command.slice(interferencePrefix.length)
    const match = /^(0|[1-9][0-9]*)$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 255) {
      throw new Error('Enter a whole interference threshold from 0 to 255.')
    }
    return { command, description: 'Set interference threshold', confirm: true as const }
  }
  const guestPasswordPrefix = 'set guest.password '
  if (command.startsWith(guestPasswordPrefix)) {
    validateGuestPassword(command.slice(guestPasswordPrefix.length))
    return { command, description: 'Change guest login password', confirm: true as const }
  }
  const ownerPrefix = 'set owner.info '
  if (command.startsWith(ownerPrefix)) {
    const value = command.slice(ownerPrefix.length)
    const bytes = new TextEncoder().encode(value)
    if (bytes.length > 119 || bytes.some((byte) => byte < 32 || byte === 127) ||
      new TextDecoder().decode(bytes) !== value) {
      throw new Error('Owner information must be at most 119 UTF-8 bytes without control characters.')
    }
    return { command, description: 'Set owner information', confirm: true as const }
  }
  const position = /^set (lat|lon) (.*)$/.exec(command)
  if (position && position[0] === command) {
    const axis = position[1] === 'lat' ? 'lat' : 'lon'
    validatePosition(axis, position[2])
    return { command, description: `Set stored ${axis === 'lat' ? 'latitude' : 'longitude'}`, confirm: true as const }
  }
  const interval = /^set (advert\.interval|flood\.advert\.interval) (.*)$/.exec(command)
  if (interval && interval[0] === command) {
    const local = interval[1] === 'advert.interval'
    const value = Number(interval[2])
    if (!/^(0|[1-9][0-9]*)$/.test(interval[2]) || !Number.isSafeInteger(value) ||
      (local ? value !== 0 && (value < 60 || value > 240 || value % 2 !== 0)
        : value !== 0 && (value < 3 || value > 168))) {
      throw new Error(local
        ? 'Enter 0 to disable or an even local interval from 60 to 240 minutes.'
        : 'Enter 0 to disable or a flood interval from 3 to 168 hours.')
    }
    return { command, description: `Set ${local ? 'local' : 'flood'} advertisement interval`, confirm: true as const }
  }
  const floodLimit = /^set (flood\.max(?:\.unscoped|\.advert)?) (.*)$/.exec(command)
  if (floodLimit && floodLimit[0] === command) {
    const value = floodLimit[2]
    if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 64) {
      throw new Error('Enter a whole flood hop limit from 0 to 64.')
    }
    return { command, description: `Set ${floodLimit[1]} hop limit`, confirm: true as const }
  }
  const retransmitDelay = /^set (txdelay|direct\.txdelay) ([\s\S]*)$/.exec(command)
  if (retransmitDelay) {
    const value = retransmitDelay[2]
    const match = /^(?:0|1|2)(?:\.[0-9]{1,2})?$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 2) {
      throw new Error('Enter a retransmission delay factor from 0 to 2 with up to 2 decimal places.')
    }
    return { command, description: `Set ${retransmitDelay[1] === 'txdelay' ? 'flood' : 'direct'} retransmission delay factor`, confirm: true as const }
  }
  const receiveDelayPrefix = 'set rxdelay '
  if (command.startsWith(receiveDelayPrefix)) {
    const value = command.slice(receiveDelayPrefix.length)
    const match = /^(?:0|[1-9]|1[0-9]|20)(?:\.[0-9]{1,2})?$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 20) {
      throw new Error('Enter a receive-delay base from 0 to 20 with up to 2 decimal places.')
    }
    return { command, description: 'Set receive-delay base', confirm: true as const }
  }
  const airtimePrefix = 'set af '
  if (command.startsWith(airtimePrefix)) {
    const value = command.slice(airtimePrefix.length)
    const match = /^[0-9](?:\.[0-9]{1,2})?$/.exec(value)
    if (!match || match[0] !== value || Number(value) > 9) {
      throw new Error('Enter an airtime factor from 0 to 9 with up to 2 decimal places.')
    }
    return { command, description: 'Set airtime factor', confirm: true as const }
  }
  const loopDetection = /^set loop\.detect (off|minimal|moderate|strict)$/.exec(command)
  if (loopDetection && loopDetection[0] === command) {
    return { command, description: `Set flood loop detection to ${loopDetection[1]}`, confirm: true as const }
  }
  const pathHashMode = /^set path\.hash\.mode ([0-2])$/.exec(command)
  if (pathHashMode && pathHashMode[0] === command) {
    return { command, description: `Set advert path hash size to ${pathHashMode[1]}`, confirm: true as const }
  }
  throw new Error('Choose a supported repeater CLI command.')
}

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function allocateRepeaterCliTag(used: Set<string>) {
  const count = alphabet.length * alphabet.length
  if (used.size >= count) throw new Error('No unused CLI reply tags remain in this tab. Reload only after pending replies have cleared.')
  const start = crypto.getRandomValues(new Uint16Array(1))[0] % count
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count
    const tag = alphabet[Math.floor(index / alphabet.length)] + alphabet[index % alphabet.length]
    if (!used.has(tag)) {
      used.add(tag)
      return tag
    }
  }
  throw new Error('No unused CLI reply tags remain in this tab.')
}

export async function sendRepeaterCli(link: SerialLink, key: string, command: string, tag: string): Promise<RepeaterCliReceipt> {
  const frame = directMessageCommand(key, 0, 0, `${tag}|${repeaterCliCommand(command).command}`)
  frame[1] = 1
  let rejected = false
  try {
    const response = await link.request(frame, (reply) => ({ value: reply }))
    rejected = (response[0] === Response.error && response.length === 2) ||
      (response[0] === Response.disabled && response.length === 1)
    expectResponse(response, Response.sent)
    const receipt = decodeDirectSent(response)
    if (response.length !== 10) throw new CompanionError('protocol', 'Invalid repeater CLI send confirmation.')
    return { tag, route: receipt.route, timeoutMs: Math.min(120_000, Math.max(10_000, receipt.timeoutMs + 5_000)) }
  } catch (cause) {
    if (rejected) throw cause
    throw new UncertainRepeaterCliError(tag, cause)
  }
}
