import { contactPublicKey } from './contact-commands.ts'
import { decodeDirectSent, directMessageCommand } from './direct-message.ts'
import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

const receiverGainWarning = 'Support depends on the repeater radio and firmware build. Changing gain may affect reception and power use. OK or matching read-back does not prove the radio applied the preference or saved it successfully. On some unsupported builds, a gain query returns radio parameters instead of on/off. In v1.14.1, saving also sets a local advert interval below 60 minutes to zero; an already scheduled advert may still be sent.'

export const repeaterCliCommands = [
  { command: 'ver', description: 'Read the firmware version' },
  { command: 'board', description: 'Read the board manufacturer' },
  { command: 'clock', description: 'Read the repeater clock' },
  { command: 'clock sync', description: 'Sync repeater clock from the connected radio', confirm: true,
    warning: 'Check the radio clock in Settings first. The repeater cannot move its clock backwards; a clock set too far ahead may disrupt later commands. Older companion firmware can cause the repeater to ignore this request.' },
  { command: 'neighbors', description: 'List recently heard neighbors' },
  { command: 'discover.neighbors', description: 'Discover nearby repeaters', confirm: true,
    warning: 'Supported by repeater firmware v1.14.1; support on other builds varies. This asks the repeater to broadcast a zero-hop discovery request; nearby repeaters may also transmit replies. It replaces any discovery already in progress. Replies may update the limited neighbor cache and evict older entries. Discovery responses are unauthenticated and do not prove identity. An OK reply does not prove a broadcast occurred or that any neighbors replied. Wait up to 60 seconds, then request neighbors separately; old entries may remain and the list can be incomplete.' },
  { command: 'get name', description: 'Read the advertised name' },
  { command: 'powersaving', description: 'Read repeater power-saving preference' },
  { command: 'powersaving on', description: 'Enable repeater power-saving preference', confirm: true,
    warning: 'Depending on the board and firmware, the repeater may sleep when idle and be less responsive. An on reply reports the preference, not actual sleep. Verify the reply and preference.' },
  { command: 'powersaving off', description: 'Disable repeater power-saving preference', confirm: true,
    warning: 'This may increase repeater power consumption on boards that support sleep. Firmware support varies; verify the reply and preference.' },
  { command: 'get radio', description: 'Read radio parameters' },
  { command: 'get radio.rxgain', description: 'Read receiver boosted-gain preference' },
  { command: 'set radio.rxgain on', description: 'Enable receiver boosted-gain preference', confirm: true,
    warning: receiverGainWarning },
  { command: 'set radio.rxgain off', description: 'Disable receiver boosted-gain preference', confirm: true,
    warning: receiverGainWarning },
  { command: 'get tx', description: 'Read stored transmit power preference' },
  { command: 'get repeat', description: 'Read forwarding mode' },
  { command: 'get af', description: 'Read airtime factor' },
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
  { command: 'advert', description: 'Send a flood advertisement', confirm: true },
  { command: 'advert.zerohop', description: 'Send a zero-hop advertisement', confirm: true },
] as const

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

export function repeaterCliCommand(command: string) {
  const found = repeaterCliCommands.find((item) => item.command === command)
  if (found) return found
  const removeAccess = /^setperm ([0-9a-f]{64}) 0$/i.exec(command)
  if (removeAccess && removeAccess[0] === command) return repeaterRemoveAccessCommand(removeAccess[1])
  const grantAdmin = /^setperm ([0-9a-f]{64}) 3$/i.exec(command)
  if (grantAdmin && grantAdmin[0] === command) return repeaterGrantAdminCommand(grantAdmin[1])
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
