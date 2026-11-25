import type { CompanionContact } from '../radio/index.ts'
import type { StoredContact } from '../storage/index.ts'

export function storedContact(contact: CompanionContact): StoredContact {
  return {
    publicKey: contact.publicKey,
    name: contact.name,
    details: {
      type: contact.type, flags: contact.flags, pathLength: contact.pathLength, pathHex: contact.pathHex,
      lastAdvertisedAt: contact.lastAdvertisedAt, latitude: contact.latitude,
      longitude: contact.longitude, lastModifiedAt: contact.lastModifiedAt,
    },
  }
}
