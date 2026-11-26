import { CompanionError, decodeContact, Response } from './protocol.ts'
import type { CompanionContact } from './protocol.ts'
import type { SerialLink } from './serial-link.ts'
import { expectResponse } from './serial-link.ts'
import { contactPublicKey } from './contact-commands.ts'

export type AdvertPath = { receivedAt: number; hops: number; width: number; hex: string }
export type AutoAddPolicy = { flags: number; maxHops?: number | null; selectedRoles: boolean }

const keyBytes = (key: string) => Uint8Array.from(contactPublicKey(key).match(/../g)!, (byte) => parseInt(byte, 16))
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
export const advertCachePrefixLength = 14

export function decodeAdvert(code: number, payload: Uint8Array): {
  publicKey: string; contact?: CompanionContact; added: boolean
} | null {
  if (code === 0x80 && payload.length === 32) return { publicKey: hex(payload), added: true }
  if (code !== 0x8a || payload.length !== 147) return null
  const contact = decodeContact(Uint8Array.of(Response.contact, ...payload))
  return { publicKey: contact.publicKey, contact, added: false }
}

async function discoveryResponse(link: SerialLink, command: Uint8Array, response: number) {
  return link.request(command, (frame) => {
    if (frame[0] !== Response.error && frame[0] !== Response.disabled) {
      expectResponse(frame, response)
      if (response === 0 && frame.length !== 1) {
        throw new CompanionError('protocol', 'The radio returned an invalid discovery acknowledgement.')
      }
    }
    return { value: frame }
  })
}

function checkResponse(frame: Uint8Array) {
  if (frame[0] === Response.disabled || (frame[0] === Response.error && frame[1] === 1)) {
    throw new CompanionError('unsupported-firmware', 'This firmware does not support this discovery setting or command.')
  }
  if (frame[0] === Response.error) throw new CompanionError('device-error', 'The radio rejected the discovery command.')
}

export async function readNoiseFloor(link: SerialLink): Promise<number> {
  const response = await discoveryResponse(link, Uint8Array.of(56, 1), 24)
  checkResponse(response)
  if (response.length !== 14 || response[1] !== 1) {
    throw new CompanionError('protocol', 'The radio returned invalid radio statistics.')
  }
  return new DataView(response.buffer, response.byteOffset, response.byteLength).getInt16(2, true)
}

export async function readAdvertPath(link: SerialLink, key: string): Promise<AdvertPath | null> {
  const response = await discoveryResponse(link, Uint8Array.of(42, 0, ...keyBytes(key)), 22)
  if (response[0] === Response.error && response[1] === 2) return null
  checkResponse(response)
  const length = response[5]
  const hops = length & 63
  const width = (length >> 6) + 1
  if (response.length < 6 || width > 3 || response.length !== 6 + hops * width || hops * width > 64) {
    throw new CompanionError('protocol', 'The radio returned an invalid or fragmented advert path.')
  }
  const receivedAt = new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(1, true) * 1000
  return { receivedAt, hops, width, hex: hex(response.slice(6)) }
}

export async function readAutoAddPolicy(link: SerialLink, contactMode: number): Promise<AutoAddPolicy> {
  const reply = await discoveryResponse(link, Uint8Array.of(59), 25)
  checkResponse(reply)
  if (reply.length < 2 || reply.length > 3 || reply[2] > 64) {
    throw new CompanionError('protocol', 'The radio returned an invalid auto-add policy.')
  }
  return {
    flags: reply[1],
    ...(reply.length === 3 ? { maxHops: reply[2] === 0 ? null : reply[2] - 1 } : {}),
    selectedRoles: (contactMode & 1) !== 0,
  }
}

export async function writeAutoAddPolicy(link: SerialLink, policy: AutoAddPolicy, contactMode: number) {
  const current = await readAutoAddPolicy(link, contactMode)
  if (policy.maxHops !== undefined && policy.maxHops !== null
    && (!Number.isInteger(policy.maxHops) || policy.maxHops < 0 || policy.maxHops > 63)) {
    throw new Error('Enter a hop limit from 0 through 63.')
  }
  if (!Number.isInteger(policy.flags) || policy.flags < 0 || policy.flags > 0x1f) throw new Error('The auto-add roles are invalid.')
  if (policy.maxHops !== undefined && current.maxHops === undefined) {
    throw new Error('This firmware does not expose a configurable hop limit.')
  }
  const flags = (current.flags & ~0x1f) | policy.flags
  const max = policy.maxHops === null ? 0 : policy.maxHops === undefined ? undefined : policy.maxHops + 1
  checkResponse(await discoveryResponse(link, Uint8Array.of(58, flags, ...(max === undefined ? [] : [max])), 0))
  const mode = (contactMode & ~1) | Number(policy.selectedRoles)
  if (mode !== contactMode) {
    try {
      checkResponse(await discoveryResponse(link, Uint8Array.of(38, mode), 0))
    } catch (cause) {
      throw new CompanionError('device-error', 'Auto-add settings were saved, but the radio mode could not be changed. Reconnect and check the policy.', { cause })
    }
  }
  return { mode, policy: await readAutoAddPolicy(link, mode) }
}
