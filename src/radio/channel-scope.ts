import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'
import { parseChannelSecret } from './channel-commands.ts'

export type ChannelScope = { mode: 'default' } | { mode: 'unscoped' } | { mode: 'region'; name: string; key?: string }
export type NamedRegion = Extract<ChannelScope, { mode: 'region' }>

const encoder = new TextEncoder()

export function validateChannelScope(scope: ChannelScope): ChannelScope {
  if (!scope || typeof scope !== 'object') throw new Error('Choose a valid channel sending scope.')
  if (scope.mode === 'default' || scope.mode === 'unscoped') return { mode: scope.mode }
  if (scope.mode !== 'region' || typeof scope.name !== 'string') throw new Error('Choose a valid channel sending scope.')
  const trimmed = scope.name.trim()
  const name = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  const bytes = encoder.encode(name)
  if (name.length < 2 || new TextDecoder().decode(bytes) !== name
    || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Region names must be nonempty valid UTF-8 after #, without control characters.')
  }
  if (scope.key !== undefined) {
    if (typeof scope.key !== 'string' || !/^[\da-f]{32}$/i.test(scope.key) || /^0{32}$/.test(scope.key)) {
      throw new Error('A custom region key must be 32 hexadecimal characters and cannot be all zero.')
    }
    return { mode: 'region', name, key: scope.key.toLowerCase() }
  }
  return { mode: 'region', name }
}

export function assertScopeSupported(scope: ChannelScope, version: number) {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('The radio did not report a supported scope protocol version.')
  }
  if (scope.mode === 'region' && version < 8) throw new Error('Region-scoped sending requires companion protocol v8 or newer.')
  if (scope.mode === 'unscoped' && version < 12) throw new Error('Explicit unscoped sending requires companion protocol v12 or newer.')
}

export async function regionKey(scope: NamedRegion) {
  return scope.key ? parseChannelSecret(scope.key)
    : new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(scope.name))).slice(0, 16)
}

export async function channelScopeCommand(scope: ChannelScope) {
  const valid = validateChannelScope(scope)
  if (valid.mode === 'default') return Uint8Array.of(54, 0)
  if (valid.mode === 'unscoped') return Uint8Array.of(54, 1)
  const key = await regionKey(valid)
  try { return Uint8Array.of(54, 0, ...key) }
  finally { key.fill(0) }
}

export async function writeChannelScope(link: SerialLink, command: Uint8Array) {
  const response = await link.request(command, (frame) => {
    if (frame[0] !== Response.error && frame[0] !== Response.disabled) expectResponse(frame, Response.ok)
    return { value: frame[0] }
  })
  if (response !== Response.ok) throw new CompanionError('device-error', 'The radio rejected the scope command.')
}
