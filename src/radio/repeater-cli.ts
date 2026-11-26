import { decodeDirectSent, directMessageCommand } from './direct-message.ts'
import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

export const repeaterCliCommands = [
  { command: 'ver', description: 'Read the firmware version' },
  { command: 'board', description: 'Read the board manufacturer' },
  { command: 'clock', description: 'Read the repeater clock' },
  { command: 'get name', description: 'Read the advertised name' },
  { command: 'get radio', description: 'Read radio parameters' },
  { command: 'get tx', description: 'Read transmit power' },
  { command: 'get repeat', description: 'Read forwarding mode' },
  { command: 'get advert.interval', description: 'Read the local advert interval' },
  { command: 'get flood.advert.interval', description: 'Read the flood advert interval' },
  { command: 'get lat', description: 'Read advert latitude' },
  { command: 'get lon', description: 'Read advert longitude' },
  { command: 'get owner.info', description: 'Read operator information' },
  { command: 'get allow.read.only', description: 'Read guest access policy' },
  { command: 'advert', description: 'Send a flood advertisement', confirm: true },
  { command: 'advert.zerohop', description: 'Send a zero-hop advertisement', confirm: true },
] as const

export type RepeaterCliReceipt = {
  tag: string
  route: 'direct' | 'flood'
  timeoutMs: number
}

export class UncertainRepeaterCliError extends Error {
  readonly tag: string

  constructor(tag: string, cause: unknown) {
    super('The radio may have sent this command, but did not confirm it. Check for a reply before retrying.', { cause })
    this.tag = tag
  }
}

export function repeaterCliCommand(command: string) {
  const found = repeaterCliCommands.find((item) => item.command === command)
  if (!found) throw new Error('Choose a supported repeater CLI command.')
  return found
}

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function allocateRepeaterCliTag(used: Set<string>) {
  const count = alphabet.length * alphabet.length
  if (used.size >= count) throw new Error('No unused CLI reply tags remain in this tab. Reload only after pending replies have cleared.')
  const start = crypto.getRandomValues(new Uint16Array(1))[0] % count
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count
    const tag = alphabet[Math.floor(index / alphabet.length)] + alphabet[index % alphabet.length]
    if (!used.has(tag)) {
      used.add(tag)
      return tag
    }
  }
  throw new Error('No unused CLI reply tags remain in this tab.')
}

export async function sendRepeaterCli(link: SerialLink, key: string, command: string, tag: string): Promise<RepeaterCliReceipt> {
  const frame = directMessageCommand(key, 0, 0, `${tag}|${repeaterCliCommand(command).command}`)
  frame[1] = 1
  let rejected = false
  try {
    const response = await link.request(frame, (reply) => ({ value: reply }))
    rejected = (response[0] === Response.error && response.length === 2) ||
      (response[0] === Response.disabled && response.length === 1)
    expectResponse(response, Response.sent)
    const receipt = decodeDirectSent(response)
    if (response.length !== 10) throw new CompanionError('protocol', 'Invalid repeater CLI send confirmation.')
    return { tag, route: receipt.route, timeoutMs: Math.min(120_000, Math.max(10_000, receipt.timeoutMs + 5_000)) }
  } catch (cause) {
    if (rejected) throw cause
    throw new UncertainRepeaterCliError(tag, cause)
  }
}
