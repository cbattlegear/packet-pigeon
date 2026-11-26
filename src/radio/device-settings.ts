import { channelScopeCommand, validateChannelScope } from './channel-scope.ts'
import { CompanionError, Response } from './protocol.ts'
import type { CompanionDevice, RadioParameters } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import { parseChannelSecret, secretHex } from './channel-commands.ts'
import { setupPathWidthCommand, setupRadioCommand, writeSettingsCommand } from './setup-commands.ts'

export type TelemetryPolicies = { base?: number; location?: number; environment?: number }
export type DeviceEdits = {
  name?: string
  position?: { latitude: number; longitude: number }
  radio?: RadioParameters
  repeat?: boolean
  txPower?: number
  pathWidth?: number
  advertLocation?: boolean
  telemetry?: TelemetryPolicies
  contactMode?: number
  extraAcknowledgements?: boolean
}

export type DeviceDetails = {
  clock: number | null
  storage: { usedKb: number; totalKb: number } | null
  repeatRanges: { minimumMHz: number; maximumMHz: number }[] | null
  region: { name: string | null } | null
  gps: { enabled: boolean; intervalSeconds: number | null } | null
  wifi: { enabled: boolean; ssid: string | null } | null
}

export type AdvancedDeviceEdits = {
  syncClock?: true
  region?: string | null
  gpsEnabled?: boolean
  gpsIntervalSeconds?: number
  pin?: string
  wifiSsid?: string
  wifiPassword?: string
  wifiEnabled?: boolean
}

export type DeviceOperation = {
  label: string
  write: (link: SerialLink) => Promise<void>
  update?: (device: CompanionDevice) => CompanionDevice
}

export type DeviceSaveResult = { label: string; status: 'saved' | 'failed' | 'uncertain' | 'skipped'; reason?: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function assertInteger(value: number, minimum: number, maximum: number, message: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(message)
}

function textBytes(value: string, maximum: number, field: string, minimum = 1) {
  const bytes = encoder.encode(value)
  if (bytes.length < minimum || bytes.length > maximum || decoder.decode(bytes) !== value ||
    bytes.some((byte) => byte < 32 || byte === 127)) {
    throw new Error(`${field} must use ${minimum}–${maximum} UTF-8 bytes without control characters.`)
  }
  return bytes
}

function view(frame: Uint8Array) {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
}

function badReply(label: string) {
  return new CompanionError('protocol', `The radio returned invalid ${label}.`)
}

async function readReply(link: SerialLink, command: number, expected: number, data: Uint8Array = new Uint8Array()) {
  const reply = await link.request(Uint8Array.of(command, ...data), (frame) => ({ value: frame }))
  if (reply[0] === Response.disabled || (reply[0] === Response.error && reply[1] === 1)) return null
  expectResponse(reply, expected)
  return reply
}

async function readClock(link: SerialLink) {
  const frame = await readReply(link, 5, 9)
  if (!frame) return null
  if (frame.length !== 5) throw badReply('clock data')
  return view(frame).getUint32(1, true)
}

async function readStorage(link: SerialLink) {
  const frame = await readReply(link, 20, 12)
  if (!frame || frame.length === 3) return null
  if (frame.length !== 11) throw badReply('storage data')
  const usedKb = view(frame).getUint32(3, true)
  const totalKb = view(frame).getUint32(7, true)
  return totalKb > 0 ? { usedKb, totalKb } : null
}

async function readRepeatRanges(link: SerialLink) {
  const frame = await readReply(link, 60, 26)
  if (!frame) return null
  if ((frame.length - 1) % 8 !== 0) throw badReply('repeat frequency ranges')
  const data = view(frame)
  return Array.from({ length: (frame.length - 1) / 8 }, (_, index) => ({
    minimumMHz: data.getUint32(1 + index * 8, true) / 1_000,
    maximumMHz: data.getUint32(5 + index * 8, true) / 1_000,
  }))
}

async function readDefaultRegionFrame(link: SerialLink) {
  const frame = await readReply(link, 64, 28)
  if (!frame) return null
  if (frame.length === 1) return { name: null, frame }
  try {
    if (frame.length !== 48) throw badReply('default region data')
    const end = frame.subarray(1, 32).indexOf(0)
    if (end <= 0) throw badReply('default region name')
    return { name: decoder.decode(frame.subarray(1, end + 1)), frame }
  } catch (error) {
    frame.fill(0, 32)
    throw error
  }
}

async function readRegion(link: SerialLink) {
  const region = await readDefaultRegionFrame(link)
  if (!region) return null
  region.frame.fill(0, 32)
  return { name: region.name }
}

export async function readBackupDefaultRegion(link: SerialLink) {
  const region = await readDefaultRegionFrame(link)
  if (!region) return undefined
  try {
    return region.name === null ? null : { name: region.name, key: secretHex(region.frame.subarray(32)) }
  } finally {
    region.frame.fill(0, 32)
  }
}

async function readGps(link: SerialLink) {
  const frame = await readReply(link, 40, 21)
  if (!frame) return null
  const entries = decoder.decode(frame.subarray(1)).split(',').map((entry) => entry.split(':', 2))
  const fields = new Map(entries.map(([name, value]) => [name, value]))
  const gps = fields.get('gps')
  const interval = fields.get('gps_interval')
  if (gps !== '0' && gps !== '1') return null
  const intervalSeconds = interval === undefined || !/^\d+$/.test(interval) || Number(interval) > 86400 ? null : Number(interval)
  return { enabled: gps === '1', intervalSeconds }
}

async function runSettingsCli(link: SerialLink, command: string) {
  const reply = await readReply(link, 66, 29, encoder.encode(command))
  if (!reply) return null
  const text = decoder.decode(reply.subarray(1)).trim()
  return text.startsWith('>') ? text.slice(1).trim() : null
}

async function readWifi(link: SerialLink) {
  const enabled = await runSettingsCli(link, 'get wifi.enabled')
  if (enabled !== '0' && enabled !== '1') return null
  const ssid = await runSettingsCli(link, 'get wifi.ssid')
  return { enabled: enabled === '1', ssid: (ssid && ssid !== '(not set)') ? ssid : null }
}

export async function readDeviceDetails(link: SerialLink, version: number): Promise<DeviceDetails> {
  return {
    clock: await readClock(link),
    storage: await readStorage(link),
    repeatRanges: version >= 9 ? await readRepeatRanges(link) : null,
    region: version >= 12 ? await readRegion(link) : null,
    gps: version >= 5 ? await readGps(link) : null,
    wifi: version >= 14 ? await readWifi(link) : null,
  }
}

function binary(label: string, command: Uint8Array): DeviceOperation {
  return { label, write: (link) => writeSettingsCommand(link, command) }
}

export function deviceOperations(device: CompanionDevice, edits: DeviceEdits) {
  const operations: DeviceOperation[] = []
  const { capabilities, preferences } = device
  if (edits.name !== undefined) {
    const name = edits.name.trim()
    operations.push({
      ...binary('Radio name', Uint8Array.of(8, ...textBytes(name, 31, 'Radio name'))),
      update: (current) => ({ ...current, name }),
    })
  }
  if (edits.position) {
    const position = edits.position
    if (!Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90) throw new Error('Latitude must be between −90 and 90 degrees.')
    if (!Number.isFinite(position.longitude) || Math.abs(position.longitude) > 180) throw new Error('Longitude must be between −180 and 180 degrees.')
    const latitude = Math.round(position.latitude * 1e6)
    const longitude = Math.round(position.longitude * 1e6)
    const command = new Uint8Array(9)
    command[0] = 14
    view(command).setInt32(1, latitude, true)
    view(command).setInt32(5, longitude, true)
    operations.push({
      ...binary('Advert position', command),
      update: (current) => ({ ...current, preferences: { ...current.preferences, latitude: latitude / 1e6, longitude: longitude / 1e6 } }),
    })
  }
  if (edits.radio || edits.repeat !== undefined) {
    const settings = edits.radio ?? device.radioParameters
    if (!settings) throw new Error('The radio did not report its current radio parameters.')
    if (capabilities.repeatEnabled === null && (edits.repeat !== undefined || capabilities.firmwareProtocolVersion >= 9)) {
      throw new Error('The current repeat setting is unavailable.')
    }
    const repeat = edits.repeat ?? capabilities.repeatEnabled
    const command = setupRadioCommand(settings, repeat)
    operations.push({
      label: 'Radio parameters and repeat mode',
      async write(link) {
        if (repeat) {
          const ranges = await readRepeatRanges(link)
          if (ranges && !ranges.some(({ minimumMHz, maximumMHz }) =>
            settings.frequencyMHz >= minimumMHz && settings.frequencyMHz <= maximumMHz)) {
            throw new Error('The radio does not allow repeat mode on this frequency.')
          }
        }
        await writeSettingsCommand(link, command)
      },
      update: (current) => ({ ...current, radioParameters: settings,
        capabilities: { ...current.capabilities, repeatEnabled: repeat },
      }),
    })
  }
  if (edits.txPower !== undefined) {
    const power = edits.txPower
    assertInteger(power, -9, preferences.maxTxPowerDbm, `Transmit power must be between −9 and ${preferences.maxTxPowerDbm} dBm.`)
    operations.push({
      ...binary('Transmit power', Uint8Array.of(12, power)),
      update: (current) => ({ ...current, preferences: { ...current.preferences, txPowerDbm: power } }),
    })
  }
  if (edits.pathWidth !== undefined) {
    if (capabilities.pathHashMode === null) throw new Error('This firmware does not expose a configurable path hash width.')
    const width = edits.pathWidth
    operations.push({
      ...binary('Default path hash width', setupPathWidthCommand(width)),
      update: (current) => ({ ...current, capabilities: { ...current.capabilities, pathHashMode: width - 1 } }),
    })
  }
  if (edits.telemetry || edits.advertLocation !== undefined || edits.extraAcknowledgements !== undefined
    || edits.contactMode !== undefined) {
    const contactMode = edits.contactMode ?? device.contactMode
    assertInteger(contactMode, 0, 255, 'Invalid auto-add contact mode.')
    const changesPolicies = edits.telemetry || edits.advertLocation !== undefined || edits.extraAcknowledgements !== undefined
    if (!changesPolicies) {
      operations.push({
        ...binary('Auto-add contact mode', Uint8Array.of(38, contactMode)),
        update: (current) => ({ ...current, contactMode }),
      })
      return operations
    }
    if (preferences.telemetryPolicy === null) throw new Error('This firmware does not expose the additional policy settings.')
    let policy = preferences.telemetryPolicy
    for (const [field, shift] of [['base', 0], ['location', 2], ['environment', 4]] as const) {
      const value = edits.telemetry?.[field]
      if (value === undefined) continue
      assertInteger(value, 0, 2, 'Choose a valid telemetry policy.')
      policy = (policy & ~(3 << shift)) | (value << shift)
    }
    const location = edits.advertLocation ?? preferences.advertLocation
    const acknowledgements = edits.extraAcknowledgements ?? preferences.extraAcknowledgements
    if (edits.extraAcknowledgements !== undefined && (preferences.extraAcknowledgements === null || location === null)) {
      throw new Error('This firmware does not report the acknowledgement or advert location setting.')
    }
    const command = [38, contactMode, policy]
    if (edits.advertLocation !== undefined || edits.extraAcknowledgements !== undefined) command.push(Number(location))
    if (edits.extraAcknowledgements !== undefined) command.push(Number(acknowledgements))
    operations.push({
      ...binary('Advert and message policies', Uint8Array.from(command)),
      update: (current) => ({ ...current, contactMode, preferences: { ...current.preferences,
        advertLocation: location, telemetryPolicy: policy, extraAcknowledgements: acknowledgements,
      } }),
    })
  }
  return operations
}

function encodeDefaultRegion(name: string, key: Uint8Array) {
  const bytes = textBytes(name, 30, 'Default region')
  const command = new Uint8Array(48)
  command[0] = 63
  command.set(bytes, 1)
  command.set(key, 32)
  return command
}

async function regionCommand(region: string | null) {
  if (region === null) return Uint8Array.of(63)
  const scope = validateChannelScope({ mode: 'region', name: region })
  if (scope.mode !== 'region') throw new Error('Enter a region name.')
  const keyCommand = await channelScopeCommand(scope)
  try { return encodeDefaultRegion(scope.name, keyCommand.subarray(2)) }
  finally { keyCommand.fill(0, 2) }
}

export async function writeBackupDefaultRegion(link: SerialLink, region: { name: string; key: string } | null) {
  const key = region ? parseChannelSecret(region.key) : null
  let command: Uint8Array | undefined
  try {
    command = region && key ? encodeDefaultRegion(region.name, key) : Uint8Array.of(63)
    await writeSettingsCommand(link, command)
  } finally {
    key?.fill(0)
    command?.fill(0)
  }
}

export async function advancedDeviceOperations(version: number, edits: AdvancedDeviceEdits) {
  const operations: DeviceOperation[] = []
  if (edits.syncClock) operations.push({
    label: 'Radio clock',
    async write(link) {
      const current = await readClock(link)
      const now = Math.floor(Date.now() / 1_000)
      if (current === null) throw new Error('This radio does not expose its clock.')
      if (current > now) throw new Error('The radio clock is ahead of this browser. Firmware only permits advancing its clock.')
      assertInteger(now, 0, 0xffffffff, 'The browser clock is out of range.')
      const command = new Uint8Array(5)
      command[0] = 6
      view(command).setUint32(1, now, true)
      await writeSettingsCommand(link, command)
    },
  })
  if (edits.region !== undefined) {
    if (version < 12) throw new Error('This firmware does not support setting the default region.')
    operations.push(binary('Default region', await regionCommand(edits.region)))
  }
  if (edits.gpsEnabled !== undefined || edits.gpsIntervalSeconds !== undefined) {
    if (version < 5) throw new Error('This firmware does not expose GPS settings.')
    for (const [field, value, label] of [
      ['gps', edits.gpsEnabled === undefined ? undefined : Number(edits.gpsEnabled), 'GPS enabled'],
      ['gps_interval', edits.gpsIntervalSeconds, 'GPS update interval'],
    ] as const) {
      if (value === undefined) continue
      assertInteger(value, 0, 86400, 'GPS interval must be from 0 to 86,400 seconds.')
      operations.push({
        label,
        async write(link) {
          const gps = await readGps(link)
          if (!gps || (field === 'gps_interval' && gps.intervalSeconds === null)) throw new Error('This device does not advertise that GPS setting.')
          await writeSettingsCommand(link, Uint8Array.of(41, ...encoder.encode(`${field}:${value}`)))
        },
      })
    }
  }
  if (edits.pin !== undefined) {
    if (version < 5) throw new Error('This firmware does not support changing the BLE PIN.')
    if (!/^(?:0|[1-9]\d{5})$/.test(edits.pin)) throw new Error('Enter a six-digit BLE PIN from 100000 to 999999, or 0 for the firmware default.')
    const command = new Uint8Array(5)
    command[0] = 37
    view(command).setUint32(1, Number(edits.pin), true)
    operations.push(binary('BLE pairing PIN', command))
  }
  if (edits.wifiSsid !== undefined || edits.wifiPassword !== undefined || edits.wifiEnabled !== undefined) {
    if (version < 14) throw new Error('Wi-Fi configuration requires companion protocol v14.')
    if (edits.wifiSsid !== undefined) textBytes(edits.wifiSsid, 32, 'Wi-Fi network name')
    if (edits.wifiPassword !== undefined) textBytes(edits.wifiPassword, 63, 'Wi-Fi password', 0)
    for (const [field, value, label, expected] of [
      ['ssid', edits.wifiSsid, 'Wi-Fi network name', 'wifi.ssid is now '],
      ['pwd', edits.wifiPassword, 'Wi-Fi password', 'wifi.pwd updated'],
      ['enabled', edits.wifiEnabled === undefined ? undefined : String(Number(edits.wifiEnabled)), 'Wi-Fi mode', 'wifi.enabled is now '],
    ] as const) {
      if (value === undefined) continue
      operations.push({
        label,
        async write(link) {
          const supported = await runSettingsCli(link, 'get wifi.enabled')
          if (supported !== '0' && supported !== '1') throw new Error('This firmware build does not support Wi-Fi configuration.')
          const result = await runSettingsCli(link, `set wifi.${field} ${value}`)
          if (!result?.startsWith(expected)) throw new Error('The radio did not confirm the Wi-Fi change.')
        },
      })
    }
  }
  return operations
}
