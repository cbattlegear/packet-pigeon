import { Point } from '@noble/ed25519'
import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import { writeSettingsCommand } from './setup-commands.ts'

export function backupPublicKey(privateKey: Uint8Array) {
  if (privateKey.length !== 64 || (privateKey[0] & 7) !== 0 || (privateKey[31] & 0xc0) !== 0x40) {
    throw new Error('The backup does not contain a valid MeshCore expanded identity key.')
  }
  let scalar = 0n
  for (let index = 31; index >= 0; index--) scalar = (scalar << 8n) | BigInt(privateKey[index])
  const publicKey = Point.BASE.multiply(scalar % Point.CURVE().n).toHex()
  if (publicKey.startsWith('00') || publicKey.startsWith('ff')) throw new Error('This identity uses a reserved public key prefix.')
  return publicKey
}

export async function readBackupIdentity(link: SerialLink, radioKey: string) {
  const frame = await link.request(Uint8Array.of(23), (frame) => ({ value: frame }))
  try {
    if (frame[0] === Response.disabled) throw new Error('This firmware build disables private identity export.')
    expectResponse(frame, 14)
    if (frame.length !== 65) throw new CompanionError('protocol', 'The identity reply was incomplete.')
    if (backupPublicKey(frame.subarray(1)) !== radioKey) throw new Error('The exported identity does not match the connected radio.')
    return frame.slice(1)
  } finally {
    frame.fill(0)
  }
}

export async function writeBackupIdentity(link: SerialLink, key: Uint8Array, expectedPublicKey: string) {
  if (backupPublicKey(key) !== expectedPublicKey) throw new Error('The backup private key does not match the public identity.')
  const command = Uint8Array.of(24, ...key)
  try {
    await writeSettingsCommand(link, command)
  } finally {
    command.fill(0)
  }
}

export async function waitForPendingContactSave(signal: AbortSignal) {
  // The firmware defers contact saves for five seconds and reloads them during identity import.
  signal.throwIfAborted()
  const settled = AbortSignal.any([signal, AbortSignal.timeout(5_100)])
  await new Promise<void>((resolve) => settled.addEventListener('abort', () => resolve(), { once: true }))
  signal.throwIfAborted()
}

export function maintenanceCommand(action: 'reboot' | 'reset') {
  const text = new TextEncoder().encode(action)
  return action === 'reboot' ? Uint8Array.of(19, ...text, 0) : Uint8Array.of(51, ...text)
}
