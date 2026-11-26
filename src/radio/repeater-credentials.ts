import { contactPublicKey } from './contact-commands.ts'

const prefix = 'packet-pigeon:repeater-credential:v1:'
const iterations = 600_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function repeaterCredentialKey(radioKey: string, contactKey: string) {
  return `${prefix}${contactPublicKey(radioKey)}:${contactPublicKey(contactKey)}`
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
}

function passphraseBytes(passphrase: string, creating: boolean) {
  const length = [...passphrase].length
  const bytes = encoder.encode(passphrase)
  if (length < (creating ? 12 : 1) || length > 1024 || decoder.decode(bytes) !== passphrase) {
    bytes.fill(0)
    throw new Error(creating
      ? 'Use a passphrase of 12 to 1024 valid characters.'
      : 'Enter the passphrase used to save this password.')
  }
  return bytes
}

function passwordBytes(password: string) {
  const bytes = encoder.encode(password)
  if (!bytes.length || bytes.length > 15 || bytes.includes(0) || decoder.decode(bytes) !== password) {
    bytes.fill(0)
    throw new Error('Enter a nonempty repeater password of at most 15 valid UTF-8 bytes without a null character.')
  }
  return bytes
}

type CredentialRecord = { version: 1; salt: string; iv: string; ciphertext: string }

function parseRecord(value: string): CredentialRecord {
  if (value.length > 256) throw new Error('The saved encrypted password is damaged or unsupported.')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new Error('The saved encrypted password is damaged or unsupported.')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('The saved encrypted password is damaged or unsupported.')
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || typeof record.salt !== 'string' || record.salt.length !== 32 || !/^[0-9a-f]{32}$/.test(record.salt) ||
    typeof record.iv !== 'string' || record.iv.length !== 24 || !/^[0-9a-f]{24}$/.test(record.iv) ||
    typeof record.ciphertext !== 'string' || record.ciphertext.length < 34 || record.ciphertext.length > 62 ||
    record.ciphertext.length % 2 !== 0 || !/^(?:[0-9a-f]{2}){17,31}$/.test(record.ciphertext)) {
    throw new Error('The saved encrypted password is damaged or unsupported.')
  }
  return { version: 1, salt: record.salt, iv: record.iv, ciphertext: record.ciphertext }
}

export class RepeaterCredentialVault {
  private readonly storage: Storage
  private readonly locks: LockManager
  private readonly cryptography: Crypto

  constructor(storage: Storage, locks: LockManager, cryptography: Crypto) {
    this.storage = storage
    this.locks = locks
    this.cryptography = cryptography
  }

  snapshot(radioKey: string, contactKey: string) {
    return this.storage.getItem(repeaterCredentialKey(radioKey, contactKey))
  }

  has(radioKey: string, contactKey: string) {
    return this.snapshot(radioKey, contactKey) !== null
  }

  private async derive(passphrase: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>) {
    const material = await this.cryptography.subtle.importKey('raw', passphrase, 'PBKDF2', false, ['deriveKey'])
    return this.cryptography.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    )
  }

  async save(radioKey: string, contactKey: string, password: string, passphrase: string, expected: string | null, signal: AbortSignal) {
    const key = repeaterCredentialKey(radioKey, contactKey)
    const plain = passwordBytes(password)
    let pass: Uint8Array<ArrayBuffer> | undefined
    try {
      const passBytes = passphraseBytes(passphrase, true)
      pass = passBytes
      await this.locks.request(key, { signal }, async () => {
        signal.throwIfAborted()
        if (this.storage.getItem(key) !== expected) {
          throw new Error('The saved password changed in another tab. Review it before trying again.')
        }
        const salt = this.cryptography.getRandomValues(new Uint8Array(16))
        const iv = this.cryptography.getRandomValues(new Uint8Array(12))
        const cipherKey = await this.derive(passBytes, salt)
        const ciphertext = new Uint8Array(await this.cryptography.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(key) }, cipherKey, plain,
        ))
        signal.throwIfAborted()
        if (this.storage.getItem(key) !== expected) {
          throw new Error('The saved password changed while saving. Review it before trying again.')
        }
        this.storage.setItem(key, JSON.stringify({ version: 1, salt: hex(salt), iv: hex(iv), ciphertext: hex(ciphertext) }))
      })
    } finally { plain.fill(0); pass?.fill(0) }
  }

  async unlock(radioKey: string, contactKey: string, passphrase: string, signal: AbortSignal) {
    const key = repeaterCredentialKey(radioKey, contactKey)
    const pass = passphraseBytes(passphrase, false)
    try {
      return await this.locks.request(key, { signal }, async () => {
        signal.throwIfAborted()
        const value = this.storage.getItem(key)
        if (value === null) throw new Error('No encrypted password is saved for this radio and repeater.')
        const record = parseRecord(value)
        const cipherKey = await this.derive(pass, fromHex(record.salt))
        let plain: Uint8Array<ArrayBuffer>
        try {
          plain = new Uint8Array(await this.cryptography.subtle.decrypt(
            { name: 'AES-GCM', iv: fromHex(record.iv), additionalData: encoder.encode(key) },
            cipherKey, fromHex(record.ciphertext),
          ))
        } catch (error) {
          if (error instanceof DOMException && error.name === 'OperationError') {
            throw new Error('The passphrase is incorrect or the saved password is damaged.')
          }
          throw error
        }
        try {
          signal.throwIfAborted()
          return decoder.decode(plain)
        } finally { plain.fill(0) }
      })
    } finally { pass.fill(0) }
  }

  async forget(radioKey: string, contactKey: string, expected: string, signal: AbortSignal) {
    const key = repeaterCredentialKey(radioKey, contactKey)
    await this.locks.request(key, { signal }, () => {
      signal.throwIfAborted()
      if (this.storage.getItem(key) !== expected) {
        throw new Error('The saved password changed in another tab. Review it before trying again.')
      }
      this.storage.removeItem(key)
    })
  }
}

export function browserRepeaterCredentialVault() {
  if (!globalThis.crypto?.subtle || !globalThis.navigator?.locks) {
    throw new Error('Encrypted password storage requires Web Crypto and browser tab coordination.')
  }
  return new RepeaterCredentialVault(globalThis.localStorage, globalThis.navigator.locks, globalThis.crypto)
}
