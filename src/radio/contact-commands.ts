import { CompanionError, decodeContact, Response } from './protocol.ts'
import type { CompanionContact } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import { parseContactPath, pathUnknown } from './contact-path.ts'
import type { ContactPathWidth } from './contact-path.ts'

export type NewContact = {
  publicKey: string; name: string; type: 1 | 2 | 3 | 4
  position?: { latitude: number; longitude: number }
}

const addOrUpdateContact = 9
const removeContact = 15
const ok = 0
const getContactByKey = 30
const contactUpdateLength = 144

export const contactPermissions = {
  telemetry: 0x02,
  location: 0x04,
  environment: 0x08,
  remoteCli: 0x10,
} as const
export type ContactPermissions = Partial<Record<keyof typeof contactPermissions, boolean>>

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
  const { latitude, longitude } = input.position ?? { latitude: 0, longitude: 0 }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('The contact position is invalid.')
  }
  const command = new Uint8Array(144)
  command[0] = addOrUpdateContact
  command.set(keyBytes(publicKey), 1)
  command[33] = input.type
  command[35] = 0xff
  command.set(bytes, 100)
  const view = new DataView(command.buffer)
  view.setInt32(136, Math.round(latitude * 1e6), true)
  view.setInt32(140, Math.round(longitude * 1e6), true)
  const contact: CompanionContact = {
    publicKey, name, type: input.type, flags: 0, pathLength: 0xff, pathHex: '00'.repeat(64),
    lastAdvertisedAt: 0, latitude, longitude, lastModifiedAt: 0,
  }
  return { command, contact }
}

export function removeContactCommand(publicKey: string) {
  return Uint8Array.of(removeContact, ...keyBytes(contactPublicKey(publicKey)))
}

export async function readContactFrame(link: SerialLink, publicKey: string) {
  const frame = await link.request(Uint8Array.of(getContactByKey, ...keyBytes(publicKey)), (response) => {
    if (response[0] !== Response.error && response[0] !== Response.disabled) expectResponse(response, Response.contact)
    return { value: response }
  })
  if (frame[0] === Response.error && frame[1] === 2) throw new Error('This contact is no longer saved on the radio.')
  if (frame[0] !== Response.contact) throw new Error('The radio could not read this contact. Check firmware support and try again.')
  if (decodeContact(frame).publicKey !== publicKey) throw new Error('The radio returned a different contact.')
  return frame
}

function contactUpdate(frame: Uint8Array) {
  // The optional final four bytes override the firmware's last-modified clock.
  const command = frame.slice(0, contactUpdateLength)
  command[0] = addOrUpdateContact
  return command
}

export function contactPathUpdate(frame: Uint8Array, input: { width: ContactPathWidth; text: string } | null) {
  const path = input ? parseContactPath(input.text, input.width) : null
  const command = contactUpdate(frame)
  command[35] = path?.encoded ?? pathUnknown
  command.fill(0, 36, 100)
  if (path?.hex) command.set(keyBytes(path.hex), 36)
  return command
}

export function contactPermissionsUpdate(frame: Uint8Array, permissions: ContactPermissions) {
  const command = contactUpdate(frame)
  for (const name of Object.keys(contactPermissions) as (keyof ContactPermissions)[]) {
    const enabled = permissions[name]
    if (typeof enabled !== 'boolean') continue
    const mask = contactPermissions[name]
    command[34] = enabled ? command[34] | mask : command[34] & ~mask
  }
  return command
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
