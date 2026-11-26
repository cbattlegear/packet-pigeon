import { contactRole } from '../contacts/model.ts'
import { mapPosition, objectRecord, readCoordinates } from '../map/nodes.ts'
import type { MapNode, NodeRole } from '../map/nodes.ts'
import type { AdvertPath } from '../radio/discovery-commands.ts'
import type { RadioData, StoredContact, StoredDiscovery } from '../storage/index.ts'

export type DiscoveryEntry = StoredDiscovery & { displayName: string; role: NodeRole | null; alreadyAdded: boolean }

export function discoveryEntries(data: RadioData | null, liveContacts?: readonly StoredContact[]): DiscoveryEntry[] {
  const contacts = new Map((liveContacts ?? data?.contacts ?? []).map((entry) => [entry.publicKey, entry]))
  return (data?.discoveries ?? []).map((advert) => {
    const contact = contacts.get(advert.publicKey)
    const role = contactRole(advert.type ?? contact?.details?.type)
    return {
      ...advert,
      type: role ?? undefined,
      latitude: advert.latitude ?? contact?.details?.latitude,
      longitude: advert.longitude ?? contact?.details?.longitude,
      displayName: advert.name || contact?.name || `Node ${advert.publicKey.slice(0, 8)}`,
      role,
      alreadyAdded: Boolean(contact) || Boolean(advert.addedWhenHeard && advert.heardAt > (data?.contactsCapturedAt ?? 0)),
    }
  })
}

export function discoveryPosition(entry: StoredDiscovery) {
  return entry.latitude === 0 && entry.longitude === 0 ? null : readCoordinates(entry.latitude, entry.longitude)
}

export function discoveryPathNodes(entries: readonly DiscoveryEntry[]) {
  return entries.map((entry) => ({
    publicKey: entry.publicKey, name: entry.displayName, position: discoveryPosition(entry), role: entry.role,
  }))
}

export function discoveryMapNodes(entries: readonly DiscoveryEntry[]): MapNode[] {
  return entries.flatMap((entry) => {
    const position = discoveryPosition(entry)
    return entry.role && mapPosition(position) ? [{
      publicKey: entry.publicKey, name: entry.displayName, role: entry.role, position,
      source: 'discovery', favorite: false,
    }] : []
  })
}

export function filterDiscoveries(
  entries: readonly DiscoveryEntry[],
  settings: { query: string; role: number; width: number; includeAdded: boolean; sort: 'recent' | 'hops' },
) {
  const query = settings.query.trim().toLowerCase()
  return entries.filter((entry) => (
    (settings.includeAdded || !entry.alreadyAdded)
      && (settings.role === 0 || entry.role === settings.role)
      && (settings.width === 0 || entry.path?.width === settings.width)
      && (entry.displayName.toLowerCase().includes(query) || entry.publicKey.includes(query))
  )).sort((a, b) => (
    (settings.sort === 'hops' ? (a.path?.hops ?? Infinity) - (b.path?.hops ?? Infinity) : 0)
      || b.heardAt - a.heardAt || a.publicKey.localeCompare(b.publicKey)
  ))
}

function readPath(value: unknown): AdvertPath | undefined {
  if (value === undefined) return undefined
  const data = objectRecord(value)
  const { receivedAt, hops, width, hex } = data ?? {}
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt < 0 || receivedAt > 8.64e15
    || typeof hops !== 'number' || !Number.isInteger(hops) || hops < 0 || hops > 63
    || (width !== 1 && width !== 2 && width !== 3) || width * hops > 64
    || typeof hex !== 'string' || !/^[a-f0-9]*$/i.test(hex) || hex.length !== width * hops * 2) {
    throw new Error('The file contains an invalid advert path.')
  }
  return { receivedAt, hops, width, hex: hex.toLowerCase() }
}

export function importDiscoveries(value: unknown): StoredDiscovery[] {
  const document = objectRecord(value)
  if (document?.version !== 1 || !Array.isArray(document.adverts) || document.adverts.length > 1_000) {
    throw new Error('Choose a Packet Pigeon discovery file with up to 1,000 entries.')
  }
  return (document.adverts as unknown[]).map((raw) => {
    const entry = objectRecord(raw)
    if (!entry || typeof entry.publicKey !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.publicKey)
      || typeof entry.heardAt !== 'number' || !Number.isFinite(entry.heardAt)
      || entry.heardAt < 0 || entry.heardAt > 8.64e15) {
      throw new Error('The file contains an invalid public key or advert time.')
    }
    const position = readCoordinates(entry.latitude, entry.longitude)
    return {
      publicKey: entry.publicKey.toLowerCase(), heardAt: entry.heardAt,
      ...(typeof entry.name === 'string' ? { name: entry.name.trim().slice(0, 120) } : {}),
      ...(typeof entry.type === 'number' && contactRole(entry.type) ? { type: entry.type } : {}),
      ...(position ? { latitude: position.lat, longitude: position.lon } : {}),
      ...(entry.path === undefined ? {} : { path: readPath(entry.path) }),
    }
  })
}

export function exportDiscoveries(entries: readonly StoredDiscovery[]) {
  const adverts = entries.map(({ publicKey, heardAt, name, type, latitude, longitude, path }) => ({
    publicKey, heardAt, name, type, latitude, longitude, path,
  }))
  return JSON.stringify({ version: 1, adverts }, null, 2)
}
