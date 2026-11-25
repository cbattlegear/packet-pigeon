import type { RadioParameters } from '../radio/protocol.ts'
import { setupRadioCommand } from '../radio/setup-commands.ts'
import { parseMeshCoreShare } from './meshcoreLinks.ts'
import type { ChannelShare, ContactShare } from './meshcoreLinks.ts'

export type SetupShare = {
  kind: 'setup'
  title?: string
  description?: string
  settings?: RadioParameters
  pathWidth?: 1 | 2 | 3
  channels: ChannelShare[]
  contacts: ContactShare[]
}

const setupOrigin = 'meshcore://companion-setup/v1'

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid setup entry.')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid setup list.')
  return value
}

function valueText(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function numeric(value: unknown) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return NaN
}

export function parseCompanionSetup(input: string): SetupShare | null {
  const url = URL.parse(input.trim())
  if (!url || url.protocol !== 'meshcore:' || url.hostname !== 'companion-setup') return null
  if (url.pathname !== '/v1' || url.username || url.password || url.port || url.hash || /[\r\n\t]/.test(input.trim())) {
    throw new Error('The companion setup link version or address is unsupported.')
  }
  const payload = url.searchParams.getAll('json')
  if (input.length > 32_768 || payload.length !== 1) throw new Error('The companion setup link needs one valid setup payload.')
  try {
    decodeURIComponent(url.search)
    const data = fields(JSON.parse(payload[0]))
    const radio = data.radio_settings == null ? null : fields(data.radio_settings)
    const network = radio?.network_settings == null ? null : fields(radio.network_settings)
    const pathWidth = network?.path_hash_size
    if (pathWidth != null && pathWidth !== 1 && pathWidth !== 2 && pathWidth !== 3) {
      throw new Error('Unsupported path hash size.')
    }
    const settings = radio ? {
      frequencyMHz: numeric(radio.frequency), bandwidthKHz: numeric(radio.bandwidth),
      spreadingFactor: numeric(radio.spreading_factor), codingRate: numeric(radio.coding_rate),
    } : undefined
    if (settings) setupRadioCommand(settings, null)
    const contacts = list(data.contacts).map((entry) => {
      const contact = fields(entry)
      return parseSetupItem('contact', {
        name: valueText(contact.name), public_key: valueText(contact.public_key), type: String(contact.type),
      }) as ContactShare
    })
    const channels = list(data.channels).map((entry) => {
      const channel = fields(entry)
      if (channel.region_scope != null && typeof channel.region_scope !== 'string') {
        throw new Error('Invalid channel region scope.')
      }
      return parseSetupItem('channel', {
        name: valueText(channel.name), secret: valueText(channel.secret), region_scope: valueText(channel.region_scope),
      }) as ChannelShare
    })
    if (!settings && !channels.length && !contacts.length) throw new Error('The setup has no changes.')
    return {
      kind: 'setup', title: valueText(data.title), description: valueText(data.description),
      settings, pathWidth: pathWidth ?? undefined, contacts, channels,
    }
  } catch {
    throw new Error('The companion setup link contains invalid or unsupported radio settings, contacts or channels.')
  }
}

function parseSetupItem(kind: 'contact' | 'channel', values: Record<string, string>) {
  return parseMeshCoreShare(`meshcore://${kind}/add?${new URLSearchParams(values)}`)
}

export function formatCompanionSetup(title: string, settings: RadioParameters, pathWidth?: number) {
  setupRadioCommand(settings, null)
  const { frequencyMHz, bandwidthKHz, spreadingFactor, codingRate } = settings
  const radio_settings = {
    title, description: 'Shared radio preset', frequency: String(frequencyMHz), bandwidth: String(bandwidthKHz),
    spreading_factor: String(spreadingFactor), coding_rate: String(codingRate),
    ...(pathWidth === 1 || pathWidth === 2 || pathWidth === 3 ? { network_settings: { path_hash_size: pathWidth } } : {}),
  }
  return `${setupOrigin}?${new URLSearchParams({ json: JSON.stringify({ title, radio_settings }) })}`
}
