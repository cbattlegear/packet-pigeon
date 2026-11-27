import type { AdvertPath } from '../radio/discovery-commands.ts'
import { validSenderName } from '../channels/senders.ts'
import { channelTextBytes } from '../radio/channel-message.ts'
import { assertScopeSupported, validateChannelScope } from '../radio/channel-scope.ts'
import type { ChannelScope } from '../radio/channel-scope.ts'
import { maxTelemetryPayloadLength } from '../radio/telemetry.ts'
import { resolveReactions } from '../chats/reactions.ts'
import type { MessageReaction, ReactionSummary } from '../chats/reactions.ts'

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

export type ChannelRetentionDays = 1 | 7 | 30 | 90
export type ChannelRetention = { index: number; channelName: string; days: ChannelRetentionDays; paused?: boolean }
export type ChannelScopeSetting = { index: number; channelName: string; scope: ChannelScope; paused?: boolean }
export type StoredRegionKey = { name: string; key: string }
export type ChannelNotificationMode = 'all' | 'mentions' | 'muted'
export type ChannelNotification = { index: number; channelName: string; mode: ChannelNotificationMode; paused?: boolean }

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
  channelOutgoing?: StoredChannelOutgoing
  receivedAt?: number
  /** Earlier wire timestamps retained when a failed DM is retried. */
  reactionTimestamps?: number[]
  /** Derived from the saved receipts, never trusted as input to a cache write. */
  reaction?: MessageReaction
  reactions?: ReactionSummary[]
}

export type StoredChannelOutgoing = {
  channelName: string
  senderName: string
  wireTimestamp: number
  status: 'sending' | 'accepted' | 'uncertain'
  error: string | null
  scope?: ChannelScope
}

export type ChannelMessageChange =
  | { kind: 'begin'; id: string; index: number; channelName: string; senderName: string; text: string; now: number; clearDraft: boolean; firmwareProtocolVersion: number }
  | { kind: 'accepted'; id: string; wireTimestamp: number }
  | { kind: 'uncertain'; id: string; wireTimestamp: number; error: string }
  | { kind: 'interrupt'; exceptId?: string }
  | { kind: 'remove'; id: string }

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
  | { kind: 'begin'; id: string; recipient: string; text: string; options: DirectSendOptions; now: number; clearDraft?: boolean }
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

export type StoredTelemetry = {
  subjectKey: string
  receivedAt: number
  payload: Uint8Array
}

export type RadioData = {
  scopeRecovery?: boolean
  channelScopes?: ChannelScopeSetting[]
  regionTransportKeys?: StoredRegionKey[]
  blockedChannelSenders?: string[]
  channelRetention?: ChannelRetention[]
  channelNotifications?: ChannelNotification[]
  mutedDirectConversations?: string[]
  contacts: StoredContact[]
  channels: StoredChannel[]
  messages: StoredMessage[]
  drafts: StoredDraft[]
  preferences: LocalPreferences | null
  contactPreferences?: ContactPreference[]
  contactsCapturedAt?: number
  discoveries?: StoredDiscovery[]
  telemetry?: StoredTelemetry[]
  directSendOptions?: DirectSendOptions
  lastDirectTimestamp?: number
  lastChannelTimestamp?: number
  readMessages?: string[]
  reactionError?: string
}

export type RadioUpdate = {
  scopeRecovery?: boolean
  channelScope?: ChannelScopeSetting
  regionTransportKeys?: readonly StoredRegionKey[]
  resetChannelScopes?: true
  blockedChannelSender?: { name: string; blocked: boolean }
  channelRetention?: { index: number; channelName: string; days: ChannelRetentionDays | null }
  channelNotification?: { index: number; channelName: string; mode: ChannelNotificationMode }
  directNotification?: { conversationId: string; muted: boolean }
  channelRetentionRename?: { index: number; from: string; to: string }
  resetChannelRetention?: true
  contacts?: readonly StoredContact[]
  channels?: readonly StoredChannel[]
  messages?: readonly StoredMessage[]
  draft?: { conversationId: string; text: string | null }
  preferences?: LocalPreferences
  contactPreference?: ContactPreferenceEdit
  contactsCapturedAt?: number
  discovery?: { upsert?: readonly StoredDiscovery[]; remove?: readonly string[] }
  telemetry?: StoredTelemetry
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
  if (update.scopeRecovery !== undefined) {
    if (typeof update.scopeRecovery !== 'boolean') throw new RadioStorageError('update', 'Invalid scope recovery marker.')
    next.scopeRecovery = update.scopeRecovery
  }
  if (update.resetChannelScopes === true) next.channelScopes = []
  if (update.resetChannelRetention !== undefined) {
    if (update.resetChannelRetention !== true) throw new RadioStorageError('update', 'Invalid retention reset.')
    next.channelRetention = []
  }
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
    if (next.channelNotifications) {
      const slots = new Map(next.channels.map(({ index, name }) => [index, name]))
      next.channelNotifications = next.channelNotifications.map((entry) =>
        slots.get(entry.index) !== entry.channelName ? { ...entry, paused: true } : entry)
    }
    if (next.channelRetention) {
      const slots = new Map(next.channels.map(({ index, name }) => [index, name]))
      next.channelRetention = next.channelRetention.filter(({ index }) => slots.has(index)).map((entry) =>
        slots.get(entry.index) !== entry.channelName ? { ...entry, paused: true } : entry)
    }
    if (next.channelScopes) {
      if (!validChannelScopeSettings(next.channelScopes)) throw new RadioStorageError('update', 'Invalid saved channel scopes.')
      const slots = new Map(next.channels.map(({ index, name }) => [index, name]))
      next.channelScopes = next.channelScopes.filter(({ index }) => slots.has(index)).map((entry) =>
        slots.get(entry.index) !== entry.channelName ? { ...entry, paused: true } : entry)
    }
  }
  if (update.channelNotification) {
    const { index, channelName, mode } = update.channelNotification
    if (!validChannelIndex(index) || !['all', 'mentions', 'muted'].includes(mode)
      || !next.channels.some((channel) => channel.index === index && channel.name === channelName)) {
      throw new RadioStorageError('update', 'The channel or notification setting changed. Refresh the channel list and retry.')
    }
    next.channelNotifications = (next.channelNotifications ?? []).filter((entry) => entry.index !== index)
    next.channelNotifications.push({ index, channelName, mode })
  }
  if (update.directNotification) {
    const { conversationId, muted } = update.directNotification
    if (!/^direct:(?:[\da-f]{12}|[\da-f]{64})$/.test(conversationId) || typeof muted !== 'boolean') {
      throw new RadioStorageError('update', 'Invalid direct conversation notification setting.')
    }
    const prefix = conversationId.slice(0, 'direct:'.length + 12)
    next.mutedDirectConversations = (next.mutedDirectConversations ?? []).filter((id) => id !== prefix)
    if (muted) next.mutedDirectConversations.push(prefix)
  }
  if (update.channelScope) {
    const { index, channelName } = update.channelScope
    if (!validChannelIndex(index) || !next.channels.some((entry) => entry.index === index && entry.name === channelName)
      || (next.channelScopes !== undefined && !validChannelScopeSettings(next.channelScopes))) {
      throw new RadioStorageError('update', 'The channel or scope setting changed. Refresh the channel list and retry.')
    }
    const scope = validateChannelScope(update.channelScope.scope)
    next.channelScopes = (next.channelScopes ?? []).filter((entry) => entry.index !== index)
    if (scope.mode !== 'default') next.channelScopes.push({ index, channelName, scope })
  }
  if (update.regionTransportKeys) {
    const keys = new Map((current.regionTransportKeys ?? []).map((entry) => [entry.name, entry]))
    for (const { name, key } of update.regionTransportKeys) {
      const scope = validateChannelScope({ mode: 'region', name, key })
      if (scope.mode !== 'region' || !scope.key) throw new RadioStorageError('update', 'Invalid saved region key.')
      keys.set(scope.name, { name: scope.name, key: scope.key })
    }
    next.regionTransportKeys = [...keys.values()]
  }
  if (update.channelRetention) {
    const { index, channelName, days } = update.channelRetention
    if (!validChannelIndex(index) || (days !== null && !validRetentionDays(days))
      || !next.channels.some((channel) => channel.index === index && channel.name === channelName)) {
      throw new RadioStorageError('update', 'The channel or retention setting changed. Refresh the channel list and retry.')
    }
    const settings = (next.channelRetention ?? []).filter((entry) => entry.index !== index)
    if (days !== null) settings.push({ index, channelName, days })
    next.channelRetention = settings
  }
  if (update.channelRetentionRename) {
    const { index, from, to } = update.channelRetentionRename
    if (!validChannelIndex(index) || typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
      throw new RadioStorageError('update', 'Invalid channel retention rename.')
    }
    if (next.channelRetention) {
      next.channelRetention = next.channelRetention.map((entry) =>
        entry.index === index && entry.channelName === from && !entry.paused ? { ...entry, channelName: to } : entry)
    }
  }
  if (messages?.length) {
    const seen = new Set(current.messages.map(({ id }) => id))
    next.messages = [...current.messages]
    for (const { id, conversationId, sender, timestamp, text, region, receipt, rawHex, outgoing, channelOutgoing, receivedAt, reactionTimestamps } of messages) {
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
        ...(channelOutgoing ? { channelOutgoing: { ...channelOutgoing } } : {}),
        ...(receivedAt !== undefined ? { receivedAt } : {}),
        ...(reactionTimestamps ? { reactionTimestamps: [...reactionTimestamps] } : {}),
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
  if (update.blockedChannelSender) {
    const { name, blocked } = update.blockedChannelSender
    if (!validSenderName(name) || typeof blocked !== 'boolean') {
      throw new RadioStorageError('update', 'Invalid channel sender name.')
    }
    const senders = (current.blockedChannelSenders ?? []).filter((entry) => entry !== name)
    if (blocked) senders.push(name)
    next.blockedChannelSenders = senders
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
  if (update.telemetry) {
    const { subjectKey, receivedAt, payload } = update.telemetry
    const key = radioKeyFromPublicKey(subjectKey)
    if (!Number.isFinite(receivedAt) || receivedAt < 0 || receivedAt > 8.64e15
      || !(payload instanceof Uint8Array) || payload.length > maxTelemetryPayloadLength) {
      throw new RadioStorageError('update', 'Invalid telemetry sample.')
    }
    const samples = current.telemetry ?? []
    const previous = samples.find((sample) => sample.subjectKey === key)
    if (!previous || receivedAt >= previous.receivedAt) {
      next.telemetry = [...samples.filter((sample) => sample.subjectKey !== key), {
        subjectKey: key, receivedAt, payload: payload.slice(),
      }]
    }
  }
  if (directSendOptions) next.directSendOptions = validateDirectOptions(directSendOptions)
  if (update.markRead?.length) {
    const knownReceipts = new Set(next.messages.filter((message) => !message.outgoing).map(({ id }) => id))
    next.readMessages = [...new Set([...(current.readMessages ?? []),
      ...update.markRead.filter((id) => knownReceipts.has(id))])]
  }
  return next
}

function validChannelIndex(index: number) {
  return Number.isInteger(index) && index >= 0 && index <= 255
}

function validRetentionDays(days: unknown): days is ChannelRetentionDays {
  return days === 1 || days === 7 || days === 30 || days === 90
}

export function validChannelRetentionSettings(value: unknown): value is ChannelRetention[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<number>()
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object') return false
    const setting = raw as { index?: unknown; channelName?: unknown; days?: unknown; paused?: unknown }
    if (typeof setting.index !== 'number' || !validChannelIndex(setting.index)
      || typeof setting.channelName !== 'string' || !setting.channelName
      || !validRetentionDays(setting.days) || (setting.paused !== undefined && typeof setting.paused !== 'boolean')
      || seen.has(setting.index)) return false
    seen.add(setting.index)
  }
  return true
}

export function validChannelScopeSettings(value: unknown): value is ChannelScopeSetting[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<number>()
  for (const entry of value as ChannelScopeSetting[]) {
    if (!entry || !validChannelIndex(entry.index) || typeof entry.channelName !== 'string' || !entry.channelName
      || (entry.paused !== undefined && typeof entry.paused !== 'boolean') || seen.has(entry.index)) return false
    try { validateChannelScope(entry.scope) } catch { return false }
    seen.add(entry.index)
  }
  return true
}

function pruneChannelMessages(data: RadioData, now: number, radio: string) {
  if (data.channelRetention === undefined) return { data, removed: 0 }
  if (!validChannelRetentionSettings(data.channelRetention)) {
    throw new RadioStorageError('update', `Invalid saved channel retention settings for radio ${radio.slice(0, 12)}.`)
  }
  const slots = new Map(data.channels.map(({ index, name }) => [index, name]))
  const policies = new Map<number, ChannelRetentionDays>()
  for (const setting of data.channelRetention) {
    if (!setting.paused && slots.get(setting.index) === setting.channelName) policies.set(setting.index, setting.days)
  }
  const removed = new Set<string>()
  const messages = data.messages.filter((message) => {
    const match = /^channel:(0|[1-9]\d*)$/.exec(message.conversationId)
    if (!match || message.outgoing) return true
    const index = Number(match[1])
    const days = policies.get(index)
    if (!days || (message.receipt && (message.receipt.kind === 'direct-text' || message.receipt.channelIndex !== index))
      || message.timestamp === null || !Number.isFinite(message.timestamp) || message.timestamp <= 0
      || message.timestamp >= now - days * 86_400_000) return true
    removed.add(message.id)
    return false
  })
  if (!removed.size) return { data, removed: 0 }
  return {
    data: {
      ...data,
      messages,
      ...(data.readMessages ? { readMessages: data.readMessages.filter((id) => !removed.has(id)) } : {}),
    },
    removed: removed.size,
  }
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

function channelMessageChange(current: RadioData, change: ChannelMessageChange): DirectChangeResult {
  if (change.kind === 'begin') {
    if (!change.id.trim() || current.messages.some((entry) => entry.id === change.id)) {
      throw new RadioStorageError('update', 'A new, unique message identifier is required.')
    }
    if (!validChannelIndex(change.index) || !change.channelName
      || !current.channels.some((channel) => channel.index === change.index && channel.name === change.channelName)) {
      throw new RadioStorageError('update', 'The channel changed. Refresh the channel list before sending.')
    }
    try { channelTextBytes(change.text, change.senderName) }
    catch (error) {
      throw new RadioStorageError('update', error instanceof Error ? error.message : 'Invalid channel message.')
    }
    if (current.channelScopes !== undefined && !validChannelScopeSettings(current.channelScopes)) {
      throw new RadioStorageError('update', 'Invalid saved channel scopes. Reset them in Channels before sending.')
    }
    const setting = current.channelScopes?.find((entry) => entry.index === change.index)
    if (setting && (setting.paused || setting.channelName !== change.channelName)) {
      throw new RadioStorageError('update', 'Sending scope is paused because this slot changed names. Choose a scope in Channels.')
    }
    const scope = validateChannelScope(setting?.scope ?? { mode: 'default' })
    try { assertScopeSupported(scope, change.firmwareProtocolVersion) }
    catch (error) { throw new RadioStorageError('update', error instanceof Error ? error.message : 'Unsupported channel scope.') }
    if (!Number.isFinite(change.now) || change.now < 0) throw new RadioStorageError('update', 'Invalid message time.')
    const wireTimestamp = Math.max(Math.floor(change.now / 1000), (current.lastChannelTimestamp ?? 0) + 1)
    if (wireTimestamp > 0xffffffff) throw new RadioStorageError('update', 'The message timestamp is out of range.')
    const conversationId = `channel:${change.index}`
    const message: StoredMessage = {
      id: change.id, conversationId, sender: 'You', timestamp: change.now, text: change.text,
      channelOutgoing: {
        channelName: change.channelName, senderName: change.senderName, wireTimestamp, status: 'sending', error: null, scope,
      },
    }
    return {
      data: {
        ...current, lastChannelTimestamp: wireTimestamp, messages: [...current.messages, message],
        drafts: change.clearDraft
          ? current.drafts.filter((draft) => draft.conversationId !== conversationId || draft.text !== change.text)
          : current.drafts,
      },
      message,
    }
  }
  if (change.kind === 'interrupt') {
    const messages = current.messages.map((entry) => {
      if (!entry.channelOutgoing || entry.id === change.exceptId || entry.channelOutgoing.status !== 'sending') return entry
      return {
        ...entry,
        channelOutgoing: {
          ...entry.channelOutgoing, status: 'uncertain' as const,
          error: 'Sending was interrupted. The packet may have been transmitted.',
        },
      }
    })
    return { data: messages.some((entry, index) => entry !== current.messages[index]) ? { ...current, messages } : current, message: null }
  }
  const existing = current.messages.find((entry) => entry.id === change.id)
  if (!existing || !existing.conversationId.startsWith('channel:')) {
    throw new RadioStorageError('update', 'The channel message is no longer in the cache.')
  }
  if (change.kind === 'remove') {
    if (existing.channelOutgoing?.status === 'sending') {
      throw new RadioStorageError('update', 'Wait for sending to finish before deleting this message.')
    }
    return {
      data: {
        ...current, messages: current.messages.filter((entry) => entry.id !== change.id),
        ...(current.readMessages ? { readMessages: current.readMessages.filter((id) => id !== change.id) } : {}),
      },
      message: null,
    }
  }
  if (!existing.channelOutgoing || existing.channelOutgoing.wireTimestamp !== change.wireTimestamp) {
    throw new RadioStorageError('update', 'The channel send no longer matches the saved message.')
  }
  const message: StoredMessage = {
    ...existing,
    channelOutgoing: {
      ...existing.channelOutgoing,
      status: change.kind === 'accepted' ? 'accepted' : 'uncertain',
      error: change.kind === 'accepted' ? null : change.error,
    },
  }
  return { data: { ...current, messages: current.messages.map((entry) => entry.id === change.id ? message : entry) }, message }
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
        drafts: change.clearDraft === false ? current.drafts
          : current.drafts.filter((draft) => draft.conversationId !== conversationId || draft.text !== change.text),
      }
    } else {
      const existing = current.messages.find((entry) => entry.id === change.id)
      if (!existing?.outgoing || existing.outgoing.status !== 'failed') {
        throw new RadioStorageError('update', 'Only a failed message can be retried.')
      }
      next = { ...current, lastDirectTimestamp: wireTimestamp }
      replace({
        ...existing,
        reactionTimestamps: [...new Set([...(existing.reactionTimestamps ?? []), existing.outgoing.wireTimestamp])],
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
  strict = false,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const failure = mode === 'readonly'
      ? new RadioStorageError('read', 'Could not read the cached radio data.')
      : new RadioStorageError('write', 'Could not save radio data. The previous cache was not changed.')
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(storeName, mode, strict ? { durability: 'strict' } : undefined)
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
    if (strict && transaction.durability !== 'strict') {
      abort(new RadioStorageError('write', 'This browser cannot durably save scope recovery markers.'))
      return
    }
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
    }).then((data) => data ? resolveReactions(data, key) : null),
    purge: (key: RadioKey) => runTransaction<void>(db, 'readwrite', (store, finish) => {
      const request = store.delete(radioKeyFromPublicKey(key))
      request.onsuccess = () => finish(undefined)
    }),
    pruneChannelMessages: (now: number) => runTransaction<number>(db, 'readwrite', (store, finish, abort) => {
      if (!Number.isFinite(now) || now < 0) throw new RadioStorageError('update', 'Invalid retention cleanup time.')
      let removed = 0
      const request = store.openCursor()
      request.onsuccess = () => {
        try {
          const cursor = request.result
          if (!cursor) {
            finish(removed)
            return
          }
          const result = pruneChannelMessages(cursor.value as RadioData, now, String(cursor.key))
          if (result.removed) cursor.update(result.data)
          removed += result.removed
          cursor.continue()
        } catch (error) {
          abort(error)
        }
      }
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
      update.scopeRecovery !== undefined,
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
    ).then(async (result) => ({ ...result, data: await resolveReactions(result.data, key) })),
    changeChannelMessage: (key: RadioKey, change: ChannelMessageChange) => runTransaction<DirectChangeResult>(
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
            const result = channelMessageChange(current, change)
            if (result.data !== current) store.put(result.data, normalized)
            finish(result)
          } catch (error) {
            abort(error)
          }
        }
      },
    ).then(async (result) => ({ ...result, data: await resolveReactions(result.data, key) })),
  }
}
