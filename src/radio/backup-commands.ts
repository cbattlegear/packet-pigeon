import { channelName, makeChannelSecret, parseChannelSecret, readChannelSlot, secretHex, writeChannelSlot } from './channel-commands.ts'
import { backupContactCommand, writeContactCommand } from './contact-commands.ts'
import { CompanionError } from './protocol.ts'
import type { SerialLink } from './serial-link.ts'
import type { CompanionChannel, CompanionContact } from './protocol.ts'

export type BackupWrite = { label: string; status: 'saved' | 'matched' | 'failed' | 'uncertain' | 'skipped'; reason?: string }
type ChannelBackup = { name: string; secret: string }
type ChannelResult = BackupWrite & { source: ChannelBackup; channel?: CompanionChannel }
type BackupContact = Omit<CompanionContact, 'lastModifiedAt'>
type ContactResult = BackupWrite & { publicKey: string }
type ContactBackupTarget = {
  ownKey: string
  firmware: number
  capacity: number
  connected: () => boolean
  readContacts: () => Promise<readonly CompanionContact[]>
}
type Slot = { channel: CompanionChannel; secret: Uint8Array } | null

function failure(error: unknown) {
  return error instanceof Error ? error.message : 'The device did not confirm this change.'
}

function writeStatus(error: unknown) {
  return error instanceof CompanionError && ['timeout', 'disconnected', 'serial-io', 'protocol'].includes(error.code)
    ? 'uncertain' : 'failed'
}

function sameKey(first: Uint8Array, second: Uint8Array) {
  return first.length === second.length && first.every((byte, index) => byte === second[index])
}

async function readSlots(link: SerialLink, capacity: number, signal: AbortSignal) {
  const slots: Slot[] = []
  try {
    for (let index = 0; index < capacity; index++) {
      signal.throwIfAborted()
      slots.push(await readChannelSlot(link, index))
    }
    return slots
  } catch (error) {
    for (const slot of slots) slot?.secret.fill(0)
    throw error
  }
}

export async function readBackupChannels(link: SerialLink, capacity: number, signal: AbortSignal) {
  const slots = await readSlots(link, capacity, signal)
  try {
    return slots.flatMap((slot) => slot?.channel.name && slot.secret.some(Boolean)
      ? [{ index: slot.channel.index, name: slot.channel.name, secret: secretHex(slot.secret) }] : [])
  } finally {
    for (const slot of slots) slot?.secret.fill(0)
  }
}

export async function restoreBackupChannels(link: SerialLink, capacity: number, entries: readonly ChannelBackup[],
  signal: AbortSignal, connected: () => boolean) {
  const slots = await readSlots(link, capacity, signal)
  const results: ChannelResult[] = []
  let unconfirmed = false
  try {
    for (const source of entries) {
      const label = source.name
      if (unconfirmed) {
        results.push({ source, label, status: 'skipped', reason: 'Check the radio channel slots after an unconfirmed write.' })
        continue
      }
      if (signal.aborted || !connected()) {
        results.push({ source, label, status: 'skipped', reason: 'The operation stopped before this channel.' })
        continue
      }
      try {
        const name = channelName(source.name)
        const key = parseChannelSecret(source.secret)
        try {
          const matches = slots.filter((slot) => slot && sameKey(slot.secret, key))
          if (matches.length > 1) throw new Error('More than one existing channel uses this key.')
          if (matches[0]?.channel.name) {
            results.push({ source, label, status: 'matched', channel: matches[0].channel })
            continue
          }
          if (slots.some((slot) => slot?.channel.name === name)) throw new Error('An existing channel has this name and a different key.')
          if (name.startsWith('#')) {
            const expected = await makeChannelSecret('hashtag', name, '')
            const matches = sameKey(expected, key)
            expected.fill(0)
            if (!matches) throw new Error('The backup key does not match this hashtag name.')
          }
          const index = slots.findIndex((slot) => !slot || (!slot.channel.name && slot.secret.every((byte) => byte === 0)))
          if (index < 0) throw new Error('No empty channel slot is available.')
          if (signal.aborted || !connected()) {
            results.push({ source, label, status: 'skipped', reason: 'The operation stopped before this channel.' })
            continue
          }
          await writeChannelSlot(link, index, name, key)
          const channel = { index, name }
          slots[index]?.secret.fill(0)
          slots[index] = { channel, secret: key.slice() }
          results.push({ source, label, status: 'saved', channel })
        } finally {
          key.fill(0)
        }
      } catch (error) {
        const status = writeStatus(error)
        unconfirmed = status === 'uncertain'
        results.push({ source, label, status, reason: failure(error) })
      }
    }
    const channels = slots.flatMap((slot) => slot?.channel.name ? [slot.channel] : [])
    return { results, channels }
  } finally {
    for (const slot of slots) slot?.secret.fill(0)
  }
}

export async function restoreBackupContacts(link: SerialLink, entries: readonly BackupContact[], signal: AbortSignal,
  target: ContactBackupTarget) {
  if (!entries.length) return []
  const current = signal.aborted || !target.connected() ? [] : await target.readContacts().catch(() => null)
  if (!current) {
    return entries.map(({ name: label, publicKey }): ContactResult => ({ label, publicKey, status: 'skipped',
      reason: 'The current contact table could not be verified.' }))
  }
  const knownKeys = new Set(current.map(({ publicKey }) => publicKey))
  const results: ContactResult[] = []
  for (const entry of entries) {
    const { name: label, publicKey } = entry
    if (signal.aborted || !target.connected()) {
      results.push({ label, publicKey, status: 'skipped', reason: 'The operation stopped before this contact.' })
      continue
    }
    if (!knownKeys.has(publicKey) && (target.capacity <= 0 || knownKeys.size >= target.capacity)) {
      const reason = target.capacity <= 0 ? 'The radio did not report its contact capacity.' : 'Radio contact storage is full.'
      results.push({ label, publicKey, status: 'skipped', reason })
      continue
    }
    try {
      if (publicKey === target.ownKey) throw new Error('The connected radio cannot be its own contact.')
      await writeContactCommand(link, backupContactCommand(entry, target.firmware))
      knownKeys.add(publicKey)
      results.push({ label, publicKey, status: 'saved' })
    } catch (error) {
      const status = writeStatus(error)
      if (status === 'uncertain') knownKeys.add(publicKey)
      results.push({ label, publicKey, status, reason: failure(error) })
    }
  }
  return results
}

function pendingContactChanges(before: readonly CompanionContact[], loaded: readonly CompanionContact[]) {
  const byKey = new Map(loaded.map((contact) => [contact.publicKey, contact]))
  return before.filter((contact) => {
    const persisted = byKey.get(contact.publicKey)
    if (!persisted) return true
    if (persisted.lastModifiedAt > contact.lastModifiedAt) return false
    return persisted.flags !== contact.flags || persisted.name !== contact.name || persisted.type !== contact.type ||
      persisted.pathLength !== contact.pathLength || persisted.pathHex !== contact.pathHex ||
      persisted.latitude !== contact.latitude || persisted.longitude !== contact.longitude ||
      persisted.lastAdvertisedAt !== contact.lastAdvertisedAt
  })
}

export async function restoreContactsAfterIdentity(link: SerialLink, before: readonly CompanionContact[],
  contacts: readonly BackupContact[], signal: AbortSignal, target: ContactBackupTarget, reboot: Uint8Array) {
  // The firmware reloads contacts from flash when the identity changes.
  const loaded = await target.readContacts()
  const pending = pendingContactChanges(before, loaded).filter((contact) => contact.publicKey !== target.ownKey)
  // Complete preservation even if the user stops the remaining selected imports.
  const preservation = new AbortController()
  const preserved = await restoreBackupContacts(link, pending, preservation.signal, { ...target, readContacts: async () => loaded })
  const results = preserved.map(({ label, ...result }) => ({ ...result, publicKey: '', label: `Preserve ${label}` }))
  results.push(...await restoreBackupContacts(link, contacts, signal, target))
  if (results.some(({ status }) => status === 'saved')) {
    try { await link.sendWithoutReply(reboot) }
    catch {
      results.push({ publicKey: '', label: 'Save pending contacts', status: 'uncertain',
        reason: 'Reconnect and verify the restored contacts before powering off the radio.' })
    }
  }
  return results
}
