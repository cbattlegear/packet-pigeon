import { CompanionError } from './protocol.ts'

export const companionConnectionKey = 'packet-pigeon:companion-connection'

export type CompanionConnectionTarget =
  | {
      version: 1
      transport: 'usb'
      publicKey: string
      vendorId: number
      productId: number
    }
  | {
      version: 1
      transport: 'bluetooth'
      publicKey: string
      deviceId: string
    }

export interface CompanionConnectionPersistence {
  load(): CompanionConnectionTarget | null
  save(target: CompanionConnectionTarget): void
  clear(): void
}

function savedConnectionError(message: string, cause?: unknown) {
  return new CompanionError('reconnect-failed', message, cause === undefined ? undefined : { cause })
}

export function parseCompanionConnection(json: string | null): CompanionConnectionTarget | null {
  if (json === null) return null
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null) throw new Error('Invalid connection data.')
    const candidate = value as Partial<CompanionConnectionTarget>
    if (candidate.version !== 1 || typeof candidate.publicKey !== 'string'
      || !/^[0-9a-f]{64}$/i.test(candidate.publicKey)) {
      throw new Error('Invalid radio identity.')
    }
    if (candidate.transport === 'usb' && Number.isInteger(candidate.vendorId)
      && candidate.vendorId! >= 0 && candidate.vendorId! <= 0xffff
      && Number.isInteger(candidate.productId)
      && candidate.productId! >= 0 && candidate.productId! <= 0xffff) {
      return {
        version: 1,
        transport: 'usb',
        publicKey: candidate.publicKey.toLowerCase(),
        vendorId: candidate.vendorId!,
        productId: candidate.productId!,
      }
    }
    if (candidate.transport === 'bluetooth' && typeof candidate.deviceId === 'string' && candidate.deviceId) {
      return {
        version: 1,
        transport: 'bluetooth',
        publicKey: candidate.publicKey.toLowerCase(),
        deviceId: candidate.deviceId,
      }
    }
    throw new Error('Invalid transport identity.')
  } catch (cause) {
    throw savedConnectionError(
      'The saved radio connection is invalid. Use a connection button to choose the radio again.',
      cause,
    )
  }
}

export const browserCompanionConnectionPersistence: CompanionConnectionPersistence = {
  load() {
    if (!globalThis.localStorage) return null
    try {
      return parseCompanionConnection(globalThis.localStorage.getItem(companionConnectionKey))
    } catch (error) {
      if (error instanceof CompanionError) throw error
      throw savedConnectionError(
        'Could not read the saved radio connection. Check browser storage and choose the radio again.',
        error,
      )
    }
  },
  save(target) {
    if (!globalThis.localStorage) return
    try {
      globalThis.localStorage.setItem(companionConnectionKey, JSON.stringify(target))
    } catch (cause) {
      throw savedConnectionError(
        'The radio is connected, but this browser could not remember it for refresh recovery.',
        cause,
      )
    }
  },
  clear() {
    if (!globalThis.localStorage) return
    try {
      globalThis.localStorage.removeItem(companionConnectionKey)
    } catch (cause) {
      throw savedConnectionError(
        'The radio was disconnected, but this browser could not clear its saved connection. Clear site data before refreshing.',
        cause,
      )
    }
  },
}
