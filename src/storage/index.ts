declare const radioKeyBrand: unique symbol
export type RadioKey = string & { readonly [radioKeyBrand]: true }

export type StoredContact = {
  publicKey: string
  name: string
}

export type StoredChannel = {
  index: number
  name: string
}

export type StoredMessage = {
  /** Caller-generated receipt ID, reused when retrying the same write. */
  id: string
  conversationId: string
  sender: string
  timestamp: number
  text: string
}

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
}

export type RadioUpdate = {
  contacts?: readonly StoredContact[]
  channels?: readonly StoredChannel[]
  messages?: readonly StoredMessage[]
  draft?: { conversationId: string; text: string | null }
  preferences?: LocalPreferences
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
  const { contacts, channels, messages, draft, preferences } = update
  const next = { ...current }
  if (contacts) {
    next.contacts = contacts.map(({ publicKey, name }) => ({ publicKey, name }))
  }
  if (channels) {
    next.channels = channels.map(({ index, name }) => ({ index, name }))
  }
  if (messages?.length) {
    const seen = new Set(current.messages.map(({ id }) => id))
    next.messages = [...current.messages]
    for (const { id, conversationId, sender, timestamp, text } of messages) {
      if (!id.trim()) {
        throw new RadioStorageError('update', 'A stable message identifier is required.')
      }
      if (seen.has(id)) continue
      seen.add(id)
      next.messages.push({ id, conversationId, sender, timestamp, text })
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
  return next
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
  }
}
