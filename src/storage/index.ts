import type { AdvertPath } from '../radio/discovery-commands.ts'

declare const radioKeyBrand: unique symbol
export type RadioKey = string & { readonly [radioKeyBrand]: true }

export type StoredContact = {
  publicKey: string
  name: string
  details?: {
    type: number
    flags: number
    pathLength: number
    pathHex: string
    lastAdvertisedAt: number
    latitude: number
    longitude: number
    lastModifiedAt: number
  }
}

export type StoredChannel = {
  index: number
  name: string
}

export type ContactPreference = { publicKey: string; customName: string | null; favorite: boolean }
export type ContactPreferenceEdit = { publicKey: string; customName?: string | null; favorite?: boolean }

export type StoredDiscovery = {
  publicKey: string
  heardAt: number
  addedWhenHeard?: boolean
  name?: string
  type?: number
  latitude?: number
  longitude?: number
  path?: AdvertPath
}

export type StoredMessage = {
  /** Caller-generated ID, reused when retrying the same write. */
  id: string
  conversationId: string
  sender: string
  timestamp: number | null
  text: string
  region?: string
  receipt?: StoredReceipt
  /** Exact companion response bytes, including for unsupported receipt types. */
  rawHex?: string
  outgoing?: StoredOutgoing
}

export type DirectSendOptions = { directAttempts: number; floodAttempts: number }
export type StoredOutgoing = {
  recipient: string
  status: 'sending' | 'sent' | 'delivered' | 'failed'
  wireTimestamp: number
  attempt: number
  options: DirectSendOptions
  route: 'direct' | 'flood' | null
  acknowledgements: { code: string; confirmed: boolean }[]
  error: string | null
  roundTripMs: number | null
}

export type DirectChange =
  | { kind: 'begin'; id: string; recipient: string; text: string; options: DirectSendOptions; now: number }
  | { kind: 'retry'; id: string; options: DirectSendOptions; now: number }
  | { kind: 'attempt'; id: string; wireTimestamp: number; attempt: number; code: string }
  | { kind: 'accepted'; id: string; wireTimestamp: number; attempt: number; code: string; route: 'direct' | 'flood' }
  | { kind: 'failed'; id: string; wireTimestamp: number; error: string }
  | { kind: 'ack'; code: string; roundTripMs: number }
  | { kind: 'interrupt'; exceptId?: string }

export type DirectChangeResult = { data: RadioData; message: StoredMessage | null; ambiguous?: boolean }

export type StoredReceipt = {
  receiptId: string
  pathLength: number
  snrDb: number | null
} & (
  | { kind: 'direct-text'; senderKeyPrefix: string; signatureHex: string | null; textType: number; senderTimestamp: number; text: string }
  | { kind: 'channel-text'; channelIndex: number; textType: number; senderTimestamp: number; text: string }
  | { kind: 'channel-data'; channelIndex: number; dataType: number; dataHex: string }
)

export type StoredDraft = {
  conversationId: string
  text: string
}

export type LocalPreferences = {
  selectedConversationId: string | null
}

export type RadioData = {
  contacts: StoredContact[]
  channels: StoredChannel[]
  messages: StoredMessage[]
  drafts: StoredDraft[]
  preferences: LocalPreferences | null
  contactPreferences?: ContactPreference[]
  contactsCapturedAt?: number
  discoveries?: StoredDiscovery[]
  directSendOptions?: DirectSendOptions
  lastDirectTimestamp?: number
  readMessages?: string[]
}

export type RadioUpdate = {
  contacts?: readonly StoredContact[]
  channels?: readonly StoredChannel[]
  messages?: readonly StoredMessage[]
  draft?: { conversationId: string; text: string | null }
  preferences?: LocalPreferences
  contactPreference?: ContactPreferenceEdit
  contactsCapturedAt?: number
  discovery?: { upsert?: readonly StoredDiscovery[]; remove?: readonly string[] }
  directSendOptions?: DirectSendOptions
  markRead?: readonly string[]
}

type StorageErrorCode = 'identity' | 'update' | 'unavailable' | 'blocked' | 'open' | 'read' | 'write'

export class RadioStorageError extends Error {
  readonly code: StorageErrorCode

  constructor(code: StorageErrorCode, message: string) {
    super(message)
    this.name = 'RadioStorageError'
    this.code = code
  }
}

const databaseName = 'packet-pigeon'
const storeName = 'radios'

/** Call only with the full public key verified by the radio session. */
export function radioKeyFromPublicKey(publicKey: string): RadioKey {
  if (!/^[\da-f]{64}$/i.test(publicKey) || publicKey.length !== 64) {
    throw new RadioStorageError('identity', 'Expected a full MeshCore radio public key in hex.')
  }
  return publicKey.toLowerCase() as RadioKey
}

function mergeUpdate(current: RadioData, update: RadioUpdate): RadioData {
  const { contacts, channels, messages, draft, preferences, contactPreference, discovery, directSendOptions } = update
  const next = { ...current }
  if (contacts) {
    next.contacts = contacts.map(({ publicKey, name, details }) => ({
      publicKey, name, ...(details ? {
        details: {
          type: details.type, flags: details.flags, pathLength: details.pathLength, pathHex: details.pathHex,
          lastAdvertisedAt: details.lastAdvertisedAt, latitude: details.latitude,
          longitude: details.longitude, lastModifiedAt: details.lastModifiedAt,
        },
      } : {}),
    }))
    if (update.contactsCapturedAt !== undefined) next.contactsCapturedAt = update.contactsCapturedAt
  }
  if (channels) {
    next.channels = channels.map(({ index, name }) => ({ index, name }))
  }
  if (messages?.length) {
    const seen = new Set(current.messages.map(({ id }) => id))
    next.messages = [...current.messages]
    for (const { id, conversationId, sender, timestamp, text, region, receipt, rawHex, outgoing } of messages) {
      if (!id.trim()) {
        throw new RadioStorageError('update', 'A stable message identifier is required.')
      }
      if (seen.has(id)) continue
      seen.add(id)
      next.messages.push({
        id, conversationId, sender, timestamp, text,
        ...(region ? { region } : {}),
        ...(receipt ? { receipt: copyReceipt(receipt) } : {}),
        ...(rawHex !== undefined ? { rawHex } : {}),
        ...(outgoing ? { outgoing: copyOutgoing(outgoing) } : {}),
      })
    }
  }
  if (draft) {
    const { conversationId, text } = draft
    next.drafts = current.drafts.filter((existing) => existing.conversationId !== conversationId)
    if (text !== null) next.drafts.push({ conversationId, text })
  }
  if (preferences) {
    next.preferences = { selectedConversationId: preferences.selectedConversationId }
  }
  if (contactPreference) {
    const publicKey = radioKeyFromPublicKey(contactPreference.publicKey)
    const existing = current.contactPreferences ?? []
    const previous = existing.find((entry) => entry.publicKey === publicKey)
    const customName = contactPreference.customName === undefined
      ? previous?.customName ?? null
      : contactPreference.customName?.trim().slice(0, 120) || null
    const favorite = contactPreference.favorite ?? previous?.favorite ?? false
    next.contactPreferences = existing.filter((entry) => entry.publicKey !== publicKey)
    if (customName || favorite) next.contactPreferences.push({ publicKey, customName, favorite })
  }
  if (discovery) {
    const records = new Map((current.discoveries ?? []).map((record) => [record.publicKey, record]))
    for (const raw of discovery.upsert ?? []) {
      const publicKey = radioKeyFromPublicKey(raw.publicKey)
      if (!Number.isFinite(raw.heardAt) || raw.heardAt < 0) throw new RadioStorageError('update', 'Invalid advert timestamp.')
      const previous = records.get(publicKey)
      const newer = raw.heardAt >= (previous?.heardAt ?? 0)
      const merged = newer ? { ...previous, ...raw, publicKey } : { ...raw, ...previous, publicKey }
      if (previous?.path && (!raw.path || previous.path.receivedAt > raw.path.receivedAt)) merged.path = previous.path
      else if (raw.path) merged.path = raw.path
      records.set(publicKey, merged)
    }
    for (const key of discovery.remove ?? []) records.delete(radioKeyFromPublicKey(key))
    next.discoveries = [...records.values()].sort((a, b) => b.heardAt - a.heardAt).slice(0, 1_000)
  }
  if (directSendOptions) next.directSendOptions = validateDirectOptions(directSendOptions)
  if (update.markRead?.length) {
    const knownReceipts = new Set(next.messages.filter((message) => !message.outgoing).map(({ id }) => id))
    next.readMessages = [...new Set([...(current.readMessages ?? []),
      ...update.markRead.filter((id) => knownReceipts.has(id))])]
  }
  return next
}

export function validateDirectOptions(options: DirectSendOptions): DirectSendOptions {
  const { directAttempts, floodAttempts } = options
  if (!Number.isInteger(directAttempts) || !Number.isInteger(floodAttempts)
    || directAttempts < 0 || floodAttempts < 0 || directAttempts + floodAttempts < 1
    || directAttempts + floodAttempts > 8) {
    throw new RadioStorageError('update', 'Choose a total of 1 to 8 direct and flood attempts.')
  }
  return { directAttempts, floodAttempts }
}

function copyOutgoing(outgoing: StoredOutgoing): StoredOutgoing {
  return {
    ...outgoing,
    options: { ...outgoing.options },
    acknowledgements: outgoing.acknowledgements.map((ack) => ({ ...ack })),
  }
}

function directChange(current: RadioData, change: DirectChange): DirectChangeResult {
  let next = current
  let message: StoredMessage | null = null
  let ambiguous = false
  const replace = (updated: StoredMessage) => {
    message = updated
    next = { ...next, messages: next.messages.map((entry) => entry.id === updated.id ? updated : entry) }
  }
  if (change.kind === 'begin' || change.kind === 'retry') {
    const options = validateDirectOptions(change.options)
    if (!Number.isFinite(change.now) || change.now < 0) {
      throw new RadioStorageError('update', 'Invalid message time.')
    }
    const wireTimestamp = Math.max(Math.floor(change.now / 1000), (current.lastDirectTimestamp ?? 0) + 1)
    if (wireTimestamp > 0xffffffff) throw new RadioStorageError('update', 'The message timestamp is out of range.')
    if (change.kind === 'begin') {
      if (!change.id.trim() || current.messages.some((entry) => entry.id === change.id)) {
        throw new RadioStorageError('update', 'A new, unique message identifier is required.')
      }
      const recipient = radioKeyFromPublicKey(change.recipient)
      const conversationId = `direct:${recipient}`
      message = {
        id: change.id, conversationId, sender: 'You', timestamp: change.now, text: change.text,
        outgoing: {
          recipient, status: 'sending', wireTimestamp, attempt: 0, options, route: null,
          acknowledgements: [], error: null, roundTripMs: null,
        },
      }
      next = {
        ...current,
        lastDirectTimestamp: wireTimestamp,
        messages: [...current.messages, message],
        drafts: current.drafts.filter((draft) => draft.conversationId !== conversationId || draft.text !== change.text),
      }
    } else {
      const existing = current.messages.find((entry) => entry.id === change.id)
      if (!existing?.outgoing || existing.outgoing.status !== 'failed') {
        throw new RadioStorageError('update', 'Only a failed message can be retried.')
      }
      next = { ...current, lastDirectTimestamp: wireTimestamp }
      replace({
        ...existing,
        outgoing: {
          ...copyOutgoing(existing.outgoing), status: 'sending', wireTimestamp, attempt: 0,
          options, route: null, error: null, roundTripMs: null,
        },
      })
    }
  } else if (change.kind === 'interrupt') {
    const messages = current.messages.map((entry) => {
      if (!entry.outgoing || entry.id === change.exceptId
        || (entry.outgoing.status !== 'sending' && entry.outgoing.status !== 'sent')) return entry
      return {
        ...entry,
        outgoing: { ...entry.outgoing, status: 'failed' as const, error: 'Sending was interrupted. Retry manually if needed.' },
      }
    })
    if (messages.some((entry, index) => entry !== current.messages[index])) next = { ...current, messages }
  } else if (change.kind === 'ack') {
    const matches = current.messages.filter((entry) => entry.outgoing?.acknowledgements.some((ack) => ack.code === change.code))
    if (matches.length > 1) {
      ambiguous = true
    } else if (matches.length === 1 && matches[0].outgoing?.acknowledgements.some((ack) => ack.code === change.code && ack.confirmed)) {
      const existing = matches[0]
      if (existing.outgoing?.status === 'delivered') {
        message = existing
      } else if (existing.outgoing) {
        replace({
          ...existing,
          outgoing: { ...existing.outgoing, status: 'delivered', error: null, roundTripMs: change.roundTripMs },
        })
      }
    }
  } else {
    const existing = current.messages.find((entry) => entry.id === change.id)
    if (!existing?.outgoing) throw new RadioStorageError('update', 'The outgoing message is no longer in the cache.')
    const outgoing = existing.outgoing
    message = existing
    if (outgoing.wireTimestamp !== change.wireTimestamp || outgoing.status === 'delivered') {
      return { data: next, message }
    }
    if (change.kind === 'attempt') {
      if (outgoing.status !== 'sending' && outgoing.status !== 'sent') {
        throw new RadioStorageError('update', 'The message is no longer being sent.')
      }
      if (change.attempt !== outgoing.attempt + 1 || change.attempt > 8 || !/^[0-9a-f]{8}$/.test(change.code)
        || change.code === '00000000') {
        throw new RadioStorageError('update', 'Invalid message attempt or acknowledgement code.')
      }
      if (current.messages.some((entry) => entry.id !== existing.id
        && entry.outgoing?.acknowledgements.some((ack) => ack.code === change.code))) {
        throw new RadioStorageError('update', 'The acknowledgement code collides with another message. No packet was sent for this attempt.')
      }
      const acknowledgements = outgoing.acknowledgements.some((ack) => ack.code === change.code)
        ? outgoing.acknowledgements : [...outgoing.acknowledgements, { code: change.code, confirmed: false }]
      replace({ ...existing, outgoing: { ...outgoing, status: 'sending', attempt: change.attempt, route: null, acknowledgements } })
    } else if (change.kind === 'accepted') {
      if (change.attempt !== outgoing.attempt || !outgoing.acknowledgements.some((ack) => ack.code === change.code)) {
        throw new RadioStorageError('update', 'The accepted message does not match the saved attempt.')
      }
      replace({
        ...existing,
        outgoing: {
          ...outgoing, status: outgoing.status === 'failed' ? 'failed' : 'sent', route: change.route,
          acknowledgements: outgoing.acknowledgements.map((ack) => ack.code === change.code ? { ...ack, confirmed: true } : ack),
        },
      })
    } else {
      replace({ ...existing, outgoing: { ...outgoing, status: 'failed', error: change.error } })
    }
  }
  return { data: next, message, ...(ambiguous ? { ambiguous } : {}) }
}

function copyReceipt(receipt: StoredReceipt): StoredReceipt {
  const { receiptId, pathLength, snrDb } = receipt
  const base = { receiptId, pathLength, snrDb }
  switch (receipt.kind) {
    case 'direct-text':
      return {
        ...base, kind: receipt.kind, senderKeyPrefix: receipt.senderKeyPrefix, signatureHex: receipt.signatureHex,
        textType: receipt.textType, senderTimestamp: receipt.senderTimestamp, text: receipt.text,
      }
    case 'channel-text':
      return {
        ...base, kind: receipt.kind, channelIndex: receipt.channelIndex,
        textType: receipt.textType, senderTimestamp: receipt.senderTimestamp, text: receipt.text,
      }
    case 'channel-data':
      return {
        ...base, kind: receipt.kind, channelIndex: receipt.channelIndex,
        dataType: receipt.dataType, dataHex: receipt.dataHex,
      }
  }
}

function runTransaction<T>(
  db: IDBDatabase,
  mode: 'readonly' | 'readwrite',
  action: (
    store: IDBObjectStore,
    finish: (value: T) => void,
    abort: (error: unknown) => void,
  ) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const failure = mode === 'readonly'
      ? new RadioStorageError('read', 'Could not read the cached radio data.')
      : new RadioStorageError('write', 'Could not save radio data. The previous cache was not changed.')
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(storeName, mode)
    } catch {
      reject(failure)
      return
    }
    let abortError = failure
    const abort = (error: unknown) => {
      if (error instanceof RadioStorageError) abortError = error
      transaction.abort()
    }
    transaction.onabort = () => reject(abortError)
    transaction.oncomplete = () => reject(failure)
    try {
      action(transaction.objectStore(storeName), (value) => {
        transaction.oncomplete = () => resolve(value)
      }, abort)
    } catch (error) {
      abort(error)
    }
  })
}

export async function openRadioStorage(factory?: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      const indexedDB = factory ?? globalThis.indexedDB
      if (!indexedDB) {
        reject(new RadioStorageError('unavailable', 'IndexedDB is unavailable in this browser.'))
        return
      }
      request = indexedDB.open(databaseName, 1)
    } catch {
      reject(new RadioStorageError('open', 'Could not open the radio cache.'))
      return
    }
    let blocked = false
    request.onblocked = () => {
      blocked = true
      reject(new RadioStorageError('blocked', 'Close the other tab using the radio cache and retry.'))
    }
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onerror = () => reject(new RadioStorageError('open', 'Could not open the radio cache.'))
    request.onsuccess = () => {
      const connection = request.result
      if (blocked) {
        connection.close()
        return
      }
      connection.onversionchange = () => connection.close()
      resolve(connection)
    }
  })

  return {
    close: () => db.close(),
    listRadioKeys: () => runTransaction<RadioKey[]>(db, 'readonly', (store, finish, abort) => {
      const request = store.getAllKeys()
      request.onsuccess = () => {
        try {
          finish(request.result.map((key) => radioKeyFromPublicKey(String(key))))
        } catch (error) {
          abort(error)
        }
      }
    }),
    read: (key: RadioKey) => runTransaction<RadioData | null>(db, 'readonly', (store, finish) => {
      const request = store.get(radioKeyFromPublicKey(key))
      request.onsuccess = () => finish(request.result ?? null)
    }),
    update: (key: RadioKey, update: RadioUpdate) => runTransaction<void>(
      db,
      'readwrite',
      (store, finish, abort) => {
        const normalized = radioKeyFromPublicKey(key)
        const request = store.get(normalized)
        request.onsuccess = () => {
          try {
            const current: RadioData = request.result ?? {
              contacts: [], channels: [], messages: [], drafts: [], preferences: null,
            }
            store.put(mergeUpdate(current, update), normalized)
            finish(undefined)
          } catch (error) {
            abort(error)
          }
        }
      },
    ),
    changeDirect: (key: RadioKey, change: DirectChange) => runTransaction<DirectChangeResult>(
      db,
      'readwrite',
      (store, finish, abort) => {
        const normalized = radioKeyFromPublicKey(key)
        const request = store.get(normalized)
        request.onsuccess = () => {
          try {
            const current: RadioData = request.result ?? {
              contacts: [], channels: [], messages: [], drafts: [], preferences: null,
            }
            const result = directChange(current, change)
            if (result.data !== current) store.put(result.data, normalized)
            finish(result)
          } catch (error) {
            abort(error)
          }
        }
      },
    ),
  }
}
