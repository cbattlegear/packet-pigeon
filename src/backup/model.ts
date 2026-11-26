import { channelName, parseChannelSecret, secretHex } from '../radio/channel-commands.ts'
import { contactPublicKey } from '../radio/contact-commands.ts'
import { decodeContactPath, parseContactPath } from '../radio/contact-path.ts'
import type { ContactPathWidth } from '../radio/contact-path.ts'
import { backupPublicKey } from '../radio/identity-backup.ts'
import { validateChannelScope } from '../radio/channel-scope.ts'
import type { ChannelScope } from '../radio/channel-scope.ts'
import { setupRadioCommand } from '../radio/setup-commands.ts'
import type { AutoAddPolicy } from '../radio/discovery-commands.ts'
import type { DeviceEdits } from '../radio/device-settings.ts'
import type { CompanionContact, RadioParameters } from '../radio/protocol.ts'
import type { ChannelRetentionDays } from '../storage/index.ts'

export const backupOptions = [
  ['name', 'Radio name'], ['identity', 'Private identity key'], ['radio', 'Radio settings'],
  ['position', 'Position'], ['other', 'Other settings'], ['autoAdd', 'Auto-add policy'],
  ['channels', 'Channels and keys'], ['contacts', 'Contacts'], ['regions', 'Region transport keys'],
] as const
export type BackupSection = typeof backupOptions[number][0]
export type BackupContact = Omit<CompanionContact, 'lastModifiedAt'> & { lastModifiedAt?: number; customName?: string | null }
export type BackupChannel = { name: string; secret: string; scope?: ChannelScope; retentionSeconds?: number | null }
export type BackupRegion = { name: string; key: string }
type BackupRadio = { settings?: RadioParameters; txPower?: number; repeat?: boolean; pathWidth?: number }
type BackupOther = Pick<DeviceEdits, 'advertLocation' | 'extraAcknowledgements' | 'telemetry'> & { contactMode?: number }

export type BackupData = {
  source?: string
  name?: string
  identity?: { publicKey: string; privateKey: Uint8Array }
  radio?: BackupRadio
  position?: NonNullable<DeviceEdits['position']>
  other?: BackupOther
  autoAdd?: Omit<AutoAddPolicy, 'selectedRoles'>
  channels?: BackupChannel[]
  contacts?: BackupContact[]
  regions?: BackupRegion[]
  defaultRegion?: BackupRegion | null
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const secondsPerDay = 86_400
export const maxBackupBytes = 2_000_000

function object(value: unknown, label: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} in the backup.`)
  return value as Record<string, unknown>
}

function optional<T>(value: unknown, parse: (value: unknown) => T) {
  return value === undefined || value === null ? undefined : parse(value)
}

function numeric(value: unknown, label: string, min: number, max: number, integer = false) {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`Invalid ${label} in the backup.`)
  }
  return number
}

function string(value: unknown, label: string, bytes: number, allowEmpty = false) {
  if (typeof value !== 'string') throw new Error(`Invalid ${label} in the backup.`)
  const encoded = encoder.encode(value)
  if ((!allowEmpty && !value.trim()) || encoded.length > bytes || decoder.decode(encoded) !== value ||
    encoded.some((byte) => byte < 32 || byte === 127)) throw new Error(`Invalid ${label} in the backup.`)
  return value
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label} in the backup.`)
  return value
}

function hex(value: unknown, bytes: number, label: string) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[a-f0-9]+$/i.test(value)) {
    throw new Error(`Invalid ${label} in the backup.`)
  }
  return value.toLowerCase()
}

export function backupKeyBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}

function list<T>(value: unknown, label: string, limit: number, read: (value: unknown) => T) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`Invalid ${label} list in the backup.`)
  return value.map(read)
}

function unique<T>(entries: T[], key: (entry: T) => string, label: string) {
  if (new Set(entries.map(key)).size !== entries.length) throw new Error(`The backup contains duplicate ${label}.`)
  return entries
}

function readChannel(raw: unknown): BackupChannel {
  const entry = object(raw, 'channel')
  const name = channelName(string(entry.name, 'channel name', 31))
  const secret = hex(entry.secret, 16, 'channel key')
  parseChannelSecret(secret).fill(0)
  let scope: ChannelScope | undefined
  if (entry.packet_pigeon_scope === 'unscoped') scope = { mode: 'unscoped' }
  else if (entry.packet_pigeon_scope === 'default') scope = { mode: 'default' }
  else if (entry.region_scope_name !== undefined && entry.region_scope_name !== null) {
    const region = string(entry.region_scope_name, 'channel region name', 120)
    const key = optional(entry.region_scope_key, (value) => hex(value, 16, 'channel region key'))
    scope = validateChannelScope({ mode: 'region', name: region, ...(key ? { key } : {}) })
  }
  const retention = optional(entry.message_retention_duration_seconds, (value) => numeric(value, 'channel retention', 0, 0xffffffff, true))
  const retentionSeconds = entry.message_retention_duration_seconds === null || retention === 0 ? null : retention
  return { name, secret, scope, retentionSeconds }
}

function readContact(raw: unknown): BackupContact {
  const entry = object(raw, 'contact')
  const publicKey = contactPublicKey(hex(entry.public_key, 32, 'contact public key'))
  const route = optional(entry.out_path_list, (value) => string(value, 'saved contact route', 192, true))
  const hops = route?.trim() ? route.split(',').map((hash) => hash.trim()) : []
  const width = (hops.length ? hops[0].length / 2 : 1) as ContactPathWidth
  if (hops.some((hash) => hash.length !== width * 2)) throw new Error('A saved contact route has mixed hash widths.')
  const path = route === undefined ? null : parseContactPath(hops.join(','), width)
  const customName = entry.custom_name === null ? null
    : optional(entry.custom_name, (value) => string(value, 'custom contact name', 480, true))
  return {
    publicKey, name: string(entry.name, 'contact name', 31),
    type: numeric(entry.type, 'contact type', 1, 4, true),
    flags: optional(entry.flags, (value) => numeric(value, 'contact flags', 0, 255, true)) ?? 0,
    pathLength: path?.encoded ?? 255, pathHex: path?.hex ?? '',
    latitude: optional(entry.latitude, (value) => numeric(value, 'contact latitude', -90, 90)) ?? 0,
    longitude: optional(entry.longitude, (value) => numeric(value, 'contact longitude', -180, 180)) ?? 0,
    lastAdvertisedAt: optional(entry.last_advert, (value) => numeric(value, 'contact advert time', 0, 0xffffffff, true)) ?? 0,
    lastModifiedAt: optional(entry.last_modified, (value) => numeric(value, 'contact edit time', 0, 0xffffffff, true)),
    customName,
  }
}

function readRegion(raw: unknown): BackupRegion {
  const entry = object(raw, 'region')
  const name = string(entry.name, 'region name', 120)
  const key = hex(entry.key, 16, 'region key')
  const scope = validateChannelScope({ mode: 'region', name, key })
  if (scope.mode !== 'region') throw new Error('Invalid region in the backup.')
  return { name: scope.name, key }
}

export function parseBackup(value: unknown): BackupData {
  const file = object(value, 'configuration')
  const extension = optional(file.packet_pigeon, (value) => object(value, 'Packet Pigeon settings'))
  if (extension && extension.version !== 1) throw new Error('This Packet Pigeon backup version is unsupported.')
  const data: BackupData = {}
  try {
    data.source = optional(file.public_key, (value) => hex(value, 32, 'public identity'))
    data.name = optional(file.name, (value) => string(value, 'radio name', 31))
    if (file.private_key !== null && file.private_key !== undefined) {
      const privateKey = backupKeyBytes(hex(file.private_key, 64, 'private identity'))
      try {
        const publicKey = backupPublicKey(privateKey)
        if (data.source && data.source !== publicKey) throw new Error('The backup private key does not match its public identity.')
        data.identity = { publicKey, privateKey }
      } catch (error) {
        privateKey.fill(0)
        throw error
      }
    }
    const radio = optional(file.radio_settings, (value) => object(value, 'radio settings'))
    if (radio) {
      const txPower = optional(radio.tx_power, (value) => numeric(value, 'transmit power', -9, 127, true))
      let settings: RadioParameters | undefined
      if ([radio.frequency, radio.bandwidth, radio.spreading_factor, radio.coding_rate].some((field) => field != null)) {
        settings = {
          frequencyMHz: numeric(radio.frequency, 'frequency', 150000, 2500000, true) / 1000,
          bandwidthKHz: numeric(radio.bandwidth, 'bandwidth', 7000, 500000, true) / 1000,
          spreadingFactor: numeric(radio.spreading_factor, 'spreading factor', 5, 12, true),
          codingRate: numeric(radio.coding_rate, 'coding rate', 5, 8, true),
        }
        setupRadioCommand(settings, null)
      }
      const repeat = optional(extension?.repeat, (value) => boolean(value, 'repeat mode'))
      const pathWidth = optional(extension?.path_hash_width, (value) => numeric(value, 'path hash width', 1, 3, true))
      if (settings || txPower !== undefined || repeat !== undefined || pathWidth !== undefined) data.radio = { settings, txPower, repeat, pathWidth }
    }
    data.position = optional(file.position_settings, (value) => {
      const position = object(value, 'position')
      return { latitude: numeric(position.latitude, 'latitude', -90, 90), longitude: numeric(position.longitude, 'longitude', -180, 180) }
    })
    const other = optional(file.other_settings, (value) => object(value, 'other settings'))
    if (other) {
      const advertLocation = optional(other.advert_location_policy, (value) => numeric(value, 'advert location policy', 0, 1, true) === 1)
      const contactMode = optional(other.manual_add_contacts, (value) => numeric(value, 'auto-add contact mode', 0, 255, true))
      const acknowledgements = optional(extension?.extra_acknowledgements, (value) => boolean(value, 'extra acknowledgements'))
      const raw = optional(extension?.telemetry_policy, (value) => numeric(value, 'telemetry policy', 0, 63, true))
      const telemetry = raw === undefined ? undefined : { base: raw & 3, location: (raw >> 2) & 3, environment: (raw >> 4) & 3 }
      if (telemetry && Object.values(telemetry).some((value) => value === 3)) throw new Error('The backup contains an unsupported telemetry policy.')
      if (advertLocation !== undefined || contactMode !== undefined || acknowledgements !== undefined || telemetry) {
        data.other = { advertLocation, contactMode, extraAcknowledgements: acknowledgements, telemetry }
      }
    }
    data.autoAdd = optional(file.auto_add_settings, (value) => {
      const config = object(value, 'auto-add policy')
      const names = ['overwrite_oldest', 'auto_add_chat', 'auto_add_repeater', 'auto_add_room_server', 'auto_add_sensor']
      const flags = names.reduce((flags, name, index) => flags | (Number(optional(config[name], (value) => boolean(value, name)) ?? false) << index), 0)
      const raw = optional(config.auto_add_max_hops, (value) => numeric(value, 'auto-add hop limit', 0, 64, true))
      return { flags, maxHops: raw === undefined ? undefined : raw === 0 ? null : raw - 1 }
    })
    data.channels = optional(file.channels, (value) => unique(list(value, 'channels', 256, readChannel), (entry) => entry.secret, 'channel keys'))
    data.contacts = optional(file.contacts, (value) => unique(list(value, 'contacts', 1024, readContact), (entry) => entry.publicKey, 'contacts'))
    data.regions = optional(file.region_transport_keys, (value) => unique(list(value, 'regions', 256, readRegion), (entry) => entry.name, 'region names'))
    data.defaultRegion = extension?.default_region === null ? null : optional(extension?.default_region, (value) => {
      const region = object(value, 'default region')
      const name = string(region.name, 'default region name', 30)
      const key = hex(region.key, 16, 'default region key')
      parseChannelSecret(key).fill(0)
      return { name, key }
    })
    if (data.defaultRegion !== undefined && data.regions === undefined) data.regions = []
    if (!backupOptions.some(([key]) => data[key] !== undefined)) throw new Error('The file does not contain supported MeshCore configuration fields.')
    return data
  } catch (error) {
    data.identity?.privateKey.fill(0)
    throw error
  }
}

export function backupJson(data: BackupData) {
  const { identity, radio, position, other, autoAdd, channels, contacts, regions } = data
  const telemetry = other?.telemetry
  return JSON.stringify({
    name: data.name,
    public_key: identity?.publicKey ?? data.source,
    private_key: identity ? secretHex(identity.privateKey) : undefined,
    radio_settings: radio ? {
      frequency: radio.settings ? Math.round(radio.settings.frequencyMHz * 1000) : undefined,
      bandwidth: radio.settings ? Math.round(radio.settings.bandwidthKHz * 1000) : undefined,
      spreading_factor: radio.settings?.spreadingFactor, coding_rate: radio.settings?.codingRate, tx_power: radio.txPower,
    } : undefined,
    position_settings: position ? { latitude: String(position.latitude), longitude: String(position.longitude) } : undefined,
    other_settings: other ? { manual_add_contacts: other.contactMode,
      advert_location_policy: other.advertLocation === undefined ? undefined : Number(other.advertLocation) } : undefined,
    auto_add_settings: autoAdd ? {
      overwrite_oldest: Boolean(autoAdd.flags & 1), auto_add_chat: Boolean(autoAdd.flags & 2),
      auto_add_repeater: Boolean(autoAdd.flags & 4), auto_add_room_server: Boolean(autoAdd.flags & 8),
      auto_add_sensor: Boolean(autoAdd.flags & 16),
      auto_add_max_hops: autoAdd.maxHops === undefined ? undefined : autoAdd.maxHops === null ? 0 : autoAdd.maxHops + 1,
    } : undefined,
    channels: channels?.map(({ name, secret, scope, retentionSeconds }) => ({
      name, secret, region_scope_name: scope?.mode === 'region' ? scope.name : undefined,
      region_scope_key: scope?.mode === 'region' ? scope.key : undefined,
      packet_pigeon_scope: scope?.mode === 'default' || scope?.mode === 'unscoped' ? scope.mode : undefined,
      message_retention_duration_seconds: retentionSeconds,
    })),
    contacts: contacts?.map((contact) => ({
      type: contact.type, name: contact.name, custom_name: contact.customName, public_key: contact.publicKey, flags: contact.flags,
      latitude: String(contact.latitude), longitude: String(contact.longitude), last_advert: contact.lastAdvertisedAt,
      last_modified: contact.lastModifiedAt, out_path_list: decodeContactPath(contact.pathLength, contact.pathHex)?.hops.join(',') ?? null,
    })),
    region_transport_keys: regions,
    packet_pigeon: { version: 1, default_region: data.defaultRegion, repeat: radio?.repeat, path_hash_width: radio?.pathWidth,
      extra_acknowledgements: other?.extraAcknowledgements, telemetry_policy: telemetry
        ? (telemetry.base ?? 0) | ((telemetry.location ?? 0) << 2) | ((telemetry.environment ?? 0) << 4) : undefined,
    },
  }, null, 2)
}

export function retentionDays(seconds: number): ChannelRetentionDays | undefined {
  const days = seconds / secondsPerDay
  return days === 1 || days === 7 || days === 30 || days === 90 ? days : undefined
}
