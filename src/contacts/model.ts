import { readCoordinates, roles } from '../map/nodes.ts'
import type { NodeRole } from '../map/nodes.ts'
import type { ContactPreference, StoredContact, StoredMessage } from '../storage/index.ts'
import { decodeContactPath, pathUnknown } from '../radio/contact-path.ts'

export type ContactSort = 'name' | 'heard' | 'message'
export type ContactEntry = StoredContact & {
  displayName: string
  favorite: boolean
  customName: string | null
  latestMessage: number | null
}

export function contactRole(type: number | undefined): NodeRole | null {
  return type === 1 || type === 2 || type === 3 || type === 4 ? type : null
}

export function roleLabel(type: number | undefined) {
  const role = contactRole(type)
  return role ? roles[role] : 'Unknown role'
}

export function contactPosition(details: StoredContact['details']) {
  if (!details || (details.latitude === 0 && details.longitude === 0)) return null
  return readCoordinates(details.latitude, details.longitude)
}

export function contactRoute(details: StoredContact['details']) {
  if (!details || details.pathLength === pathUnknown) return 'No saved route'
  const path = decodeContactPath(details.pathLength, details.pathHex)
  if (!path) return 'Route unavailable'
  const count = path.hops.length
  return count === 0 ? 'Zero hop' : `${count} ${count === 1 ? 'hop' : 'hops'} · ${path.hops.join(' → ')}`
}

export function contactEntries(
  contacts: readonly StoredContact[],
  preferences: readonly ContactPreference[],
  messages: readonly StoredMessage[],
): ContactEntry[] {
  const byPreference = new Map(preferences.map((preference) => [preference.publicKey, preference]))
  const byKey = new Map(contacts.map(({ publicKey }) => [publicKey.toLowerCase(), publicKey]))
  const prefixes = new Map<string, string | null>()
  for (const { publicKey } of contacts) {
    const prefix = publicKey.slice(0, 12).toLowerCase()
    prefixes.set(prefix, prefixes.has(prefix) ? null : publicKey)
  }
  const latest = new Map<string, number>()
  for (const message of messages) {
    if (!message.conversationId.startsWith('direct:') || message.timestamp === null
      || !Number.isFinite(message.timestamp) || Math.abs(message.timestamp) > 8.64e15) continue
    const sender = message.conversationId.slice(7).toLowerCase()
    const key = byKey.get(sender) ?? prefixes.get(sender)
    if (key && message.timestamp > (latest.get(key) ?? -Infinity)) latest.set(key, message.timestamp)
  }

  return contacts.map((contact) => {
    const preference = byPreference.get(contact.publicKey.toLowerCase())
    return {
      ...contact,
      displayName: preference?.customName || contact.name || 'Unnamed contact',
      favorite: preference?.favorite ?? false,
      customName: preference?.customName ?? null,
      latestMessage: latest.get(contact.publicKey) ?? null,
    }
  })
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const compareNames = (first: ContactEntry, second: ContactEntry) => (
  collator.compare(first.displayName, second.displayName) || first.publicKey.localeCompare(second.publicKey)
)

export function visibleContacts(
  contacts: readonly ContactEntry[],
  filters: { search: string; role: NodeRole | 'all'; favorites: boolean; sort: ContactSort },
) {
  const search = filters.search.trim().toLowerCase()
  return contacts.filter((contact) => (
    (!filters.favorites || contact.favorite)
      && (filters.role === 'all' || filters.role === contact.details?.type)
      && (contact.displayName.toLowerCase().includes(search)
        || contact.name.toLowerCase().includes(search) || contact.publicKey.toLowerCase().includes(search))
  )).sort((first, second) => {
    if (filters.sort === 'heard') {
      return (second.details?.lastAdvertisedAt ?? 0) - (first.details?.lastAdvertisedAt ?? 0)
        || compareNames(first, second)
    }
    if (filters.sort === 'message') {
      return (second.latestMessage ?? -Infinity) - (first.latestMessage ?? -Infinity) || compareNames(first, second)
    }
    return compareNames(first, second)
  })
}
