import { CompanionError, Response } from './protocol.ts'
import type { CompanionContact } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

export type NewContact = { publicKey: string; name: string; type: 1 | 2 | 3 | 4 }

const addOrUpdateContact = 9
const removeContact = 15
const ok = 0

export function contactPublicKey(input: string): string {
  const key = input.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Enter a 64-character hex public key.')
  return key
}

function keyBytes(publicKey: string) {
  return Uint8Array.from(publicKey.match(/../g)!, (pair) => Number.parseInt(pair, 16))
}

export function addContactCommand(input: NewContact) {
  const publicKey = contactPublicKey(input.publicKey)
  const name = input.name.trim()
  const bytes = new TextEncoder().encode(name)
  if (bytes.length === 0 || bytes.length > 31 || name.includes('\0')) {
    throw new Error('Enter a contact name of 1 to 31 UTF-8 bytes.')
  }
  if (input.type !== 1 && input.type !== 2 && input.type !== 3 && input.type !== 4) {
    throw new Error('Choose a supported contact role.')
  }
  const command = new Uint8Array(144)
  command[0] = addOrUpdateContact
  command.set(keyBytes(publicKey), 1)
  command[33] = input.type
  command[35] = 0xff
  command.set(bytes, 100)
  const contact: CompanionContact = {
    publicKey, name, type: input.type, flags: 0, pathLength: 0xff, pathHex: '00'.repeat(64),
    lastAdvertisedAt: 0, latitude: 0, longitude: 0, lastModifiedAt: 0,
  }
  return { command, contact }
}

export function removeContactCommand(publicKey: string) {
  return Uint8Array.of(removeContact, ...keyBytes(contactPublicKey(publicKey)))
}

export async function writeContactCommand(link: SerialLink, command: Uint8Array) {
  const frame = await link.request(command, (response) => {
    if (response[0] !== Response.error && response[0] !== Response.disabled) {
      expectResponse(response, ok)
    }
    return { value: response }
  })
  if (frame[0] === ok || (command[0] === removeContact && frame[0] === Response.error && frame[1] === 2)) return
  const message = frame[0] === Response.disabled || frame[1] === 1
    ? 'This firmware does not support this contact action.'
    : frame[1] === 3 ? 'Radio contact storage is full.' : 'The radio rejected the contact change.'
  throw new CompanionError('device-error', message)
}
