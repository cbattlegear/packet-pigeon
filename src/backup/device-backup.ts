import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioData, RadioKey, RadioUpdate } from '../storage/index.ts'
import type { CompanionSession } from '../radio/companion-session.ts'
import type { DeviceEdits, DeviceSaveResult } from '../radio/device-settings.ts'
import type { BackupWrite } from '../radio/backup-commands.ts'
import { regionKey } from '../radio/channel-scope.ts'
import { secretHex } from '../radio/channel-commands.ts'
import { backupJson, retentionDays } from './model.ts'
import type { BackupChannel, BackupData, BackupSection } from './model.ts'

export type BackupSession = Pick<CompanionSession, 'getSnapshot' | 'exportDeviceIdentity' | 'restoreDeviceIdentity'
  | 'exportBackupChannels' | 'exportBackupContacts' | 'importBackupChannels' | 'importBackupContacts'
  | 'exportBackupDefaultRegion' | 'importBackupDefaultRegion'
  | 'getAutoAdd' | 'setAutoAdd' | 'saveDevicePreferences' | 'sendMaintenance'>

export type BackupResult = BackupWrite | DeviceSaveResult
type RestoredChannels = Awaited<ReturnType<BackupSession['importBackupChannels']>>

function message(error: unknown) {
  return error instanceof Error ? error.message : 'The operation could not be completed.'
}

function connectedDevice(session: BackupSession, radioKey: RadioKey) {
  const snapshot = session.getSnapshot()
  if (snapshot.phase !== 'ready' || snapshot.device?.publicKey !== radioKey) {
    throw new Error('Connect the selected radio and wait for it to finish syncing.')
  }
  return snapshot.device
}

async function readCache(radioKey: RadioKey) {
  const storage = await openRadioStorage()
  try { return await storage.read(radioKey) }
  finally { storage.close() }
}

async function includeScope(entry: BackupChannel) {
  if (entry.scope?.mode !== 'region' || entry.scope.key) return entry
  const key = await regionKey(entry.scope)
  try { return { ...entry, scope: { ...entry.scope, key: secretHex(key) } } }
  finally { key.fill(0) }
}

export async function exportBackup(session: BackupSession, key: RadioKey, sections: ReadonlySet<BackupSection>, signal: AbortSignal) {
  const data: BackupData = { source: key }
  const failures: BackupResult[] = []
  const cached = await readCache(key).catch((error: unknown) => {
    failures.push({ label: 'Browser cache', status: 'failed', reason: message(error) })
    return null
  })
  async function read(section: BackupSection, label: string, operation: () => Promise<void> | void) {
    if (!sections.has(section)) return
    signal.throwIfAborted()
    try { await operation() }
    catch (error) { failures.push({ label, status: 'failed', reason: message(error) }) }
  }
  try {
    await read('name', 'Radio name', () => { data.name = connectedDevice(session, key).name })
    await read('radio', 'Radio settings', () => {
      const device = connectedDevice(session, key)
      data.radio = {
        settings: device.radioParameters, txPower: device.preferences.txPowerDbm,
        repeat: device.capabilities.repeatEnabled ?? undefined,
        pathWidth: device.capabilities.pathHashMode === null ? undefined : device.capabilities.pathHashMode + 1,
      }
    })
    await read('position', 'Position', () => {
      const { latitude, longitude } = connectedDevice(session, key).preferences
      data.position = { latitude, longitude }
    })
    await read('other', 'Other settings', () => {
      const device = connectedDevice(session, key)
      const { telemetryPolicy: raw, advertLocation, extraAcknowledgements } = device.preferences
      const policies = raw === null ? undefined : { base: raw & 3, location: (raw >> 2) & 3, environment: (raw >> 4) & 3 }
      data.other = {
        contactMode: device.contactMode, advertLocation: advertLocation ?? undefined,
        extraAcknowledgements: extraAcknowledgements ?? undefined,
        telemetry: policies && !Object.values(policies).includes(3) ? policies : undefined,
      }
    })
    await read('autoAdd', 'Auto-add policy', async () => { data.autoAdd = await session.getAutoAdd(key) })
    await read('contacts', 'Contacts', async () => {
      const contacts = await session.exportBackupContacts(key)
      const preferences = new Map(cached?.contactPreferences?.map((entry) => [entry.publicKey, entry.customName]))
      data.contacts = contacts.map((contact) => ({ ...contact, customName: preferences.get(contact.publicKey) }))
    })
    await read('channels', 'Channels', async () => {
      const channels = await session.exportBackupChannels(key, signal)
      const seen = new Set<string>()
      const entries: BackupChannel[] = []
      for (const { index, name, secret } of channels) {
        signal.throwIfAborted()
        if (seen.has(secret)) {
          failures.push({ label: name, status: 'skipped', reason: 'Another exported channel uses the same key.' })
          continue
        }
        seen.add(secret)
        const scope = cached?.channelScopes?.find((entry) => entry.index === index && entry.channelName === name && !entry.paused)?.scope
        const retention = cached?.channelRetention?.find((entry) => entry.index === index && entry.channelName === name && !entry.paused)
        entries.push(await includeScope({ name, secret, scope, retentionSeconds: retention ? retention.days * 86_400 : undefined }))
      }
      data.channels = entries
    })
    await read('regions', 'Default flood region', async () => {
      data.regions = cached?.regionTransportKeys ?? []
      const current = session.getSnapshot()
      if (current.phase === 'ready' && current.device?.publicKey === key) {
        data.defaultRegion = await session.exportBackupDefaultRegion(key)
      }
    })
    await read('identity', 'Private identity key', async () => {
      data.identity = { publicKey: key, privateKey: await session.exportDeviceIdentity(key) }
    })
    signal.throwIfAborted()
    return {
      json: [...sections].some((section) => data[section] !== undefined) ? backupJson(data) : null,
      failures,
    }
  } finally {
    data.identity?.privateKey.fill(0)
  }
}

export async function restoreBackup(session: BackupSession, key: RadioKey, backup: BackupData, sections: ReadonlySet<BackupSection>,
  signal: AbortSignal) {
  const results: BackupResult[] = []
  const savedContacts = new Set<string>()
  let restoredChannels: RestoredChannels | undefined
  let cacheKey: RadioKey | null = key
  let transferredIdentity: string | undefined
  let contactsHandled = false
  const snapshot = session.getSnapshot()
  const device = sections.size === 1 && sections.has('regions') &&
    (snapshot.phase !== 'ready' || snapshot.device?.publicKey !== key) ? null : connectedDevice(session, key)

  async function restore(section: BackupSection, label: string, operation: () => Promise<void>) {
    if (!sections.has(section)) return
    if (signal.aborted) {
      results.push({ label, status: 'skipped', reason: 'Stopped before this section.' })
      return
    }
    try {
      await operation()
    } catch (error) {
      results.push({ label, status: 'failed', reason: message(error) })
    }
  }

  async function setting(label: string, edits: DeviceEdits) {
    if (signal.aborted) {
      results.push({ label, status: 'skipped', reason: 'Stopped before this setting.' })
      return
    }
    try { results.push(...await session.saveDevicePreferences(key, edits)) }
    catch (error) { results.push({ label, status: 'failed', reason: message(error) }) }
  }

  await restore('name', 'Radio name', async () => {
    if (backup.name !== undefined) await setting('Radio name', { name: backup.name })
  })
  await restore('radio', 'Radio settings', async () => {
    const radio = backup.radio
    if (!radio || !device) return
    if (radio.repeat !== undefined && device.capabilities.repeatEnabled === null) {
      results.push({ label: 'Repeat mode', status: 'skipped', reason: 'Unavailable on this firmware.' })
    }
    const repeat = device.capabilities.repeatEnabled === null ? undefined : radio.repeat
    if (radio.settings || repeat !== undefined) await setting('Radio parameters', { radio: radio.settings, repeat })
    if (radio.txPower !== undefined) await setting('Transmit power', { txPower: radio.txPower })
    if (radio.pathWidth !== undefined) await setting('Default path hash width', { pathWidth: radio.pathWidth })
  })
  await restore('position', 'Position', async () => {
    if (backup.position) await setting('Position', { position: backup.position })
  })
  await restore('other', 'Other settings', async () => {
    const other = backup.other
    if (!other || !device) return
    if (other.contactMode !== undefined) await setting('Auto-add contact mode', { contactMode: other.contactMode })
    if (other.advertLocation !== undefined || other.telemetry) {
      await setting('Advert and telemetry policies', { advertLocation: other.advertLocation, telemetry: other.telemetry })
    }
    if (other.extraAcknowledgements !== undefined) {
      await setting('Extra acknowledgements', { extraAcknowledgements: other.extraAcknowledgements })
    }
  })
  await restore('autoAdd', 'Auto-add policy', async () => {
    if (!backup.autoAdd) return
    const current = connectedDevice(session, key)
    await session.setAutoAdd(key, { ...backup.autoAdd, selectedRoles: (current.contactMode & 1) !== 0 })
    results.push({ label: 'Auto-add policy', status: 'saved' })
  })
  await restore('channels', 'Channels', async () => {
    if (!backup.channels?.length) return
    restoredChannels = await session.importBackupChannels(key, backup.channels, signal)
    results.push(...restoredChannels.results.map(({ label, status, reason }) => ({ label, status, reason })))
  })
  function recordContacts(contacts: Awaited<ReturnType<BackupSession['importBackupContacts']>>) {
    for (const { publicKey, label, status, reason } of contacts) {
      if (status === 'saved') savedContacts.add(publicKey)
      results.push({ label, status, reason })
    }
  }
  await restore('regions', 'Default flood region', async () => {
    if (backup.defaultRegion === undefined) return
    if (!device) {
      results.push({ label: 'Default flood region', status: 'skipped', reason: 'Connect the selected radio to apply its default region.' })
      return
    }
    await session.importBackupDefaultRegion(key, backup.defaultRegion)
    results.push({ label: 'Default flood region', status: 'saved' })
  })
  await restore('identity', 'Private identity key', async () => {
    const identity = backup.identity
    if (!identity) return
    if (identity.publicKey === key) {
      results.push({ label: 'Private identity key', status: 'matched' })
      return
    }
    connectedDevice(session, key)
    try {
      const selected = sections.has('contacts') ? backup.contacts ?? [] : []
      const contacts = await session.restoreDeviceIdentity(key, identity.privateKey, identity.publicKey,
        selected.filter((entry) => entry.publicKey !== identity.publicKey), signal)
      cacheKey = radioKeyFromPublicKey(identity.publicKey)
      transferredIdentity = identity.publicKey
      contactsHandled = true
      results.push({ label: 'Private identity key', status: 'saved', reason: 'Reconnect to verify the restored public key.' })
      recordContacts(contacts)
      const self = selected.find((entry) => entry.publicKey === identity.publicKey)
      if (self) results.push({ label: self.name, status: 'skipped', reason: 'This is the restored radio identity.' })
    } catch (error) {
      if (signal.aborted && session.getSnapshot().phase === 'ready') {
        results.push({ label: 'Private identity key', status: 'skipped', reason: 'Stopped before replacing the identity.' })
      } else if (session.getSnapshot().phase !== 'ready') {
        cacheKey = null
        results.push({ label: 'Private identity key', status: 'uncertain', reason: 'Reconnect and check the radio’s public key.' })
      } else {
        results.push({ label: 'Private identity key', status: 'failed', reason: message(error) })
      }
    }
  })
  if (!contactsHandled) await restore('contacts', 'Contacts', async () => {
    if (backup.contacts?.length) recordContacts(await session.importBackupContacts(key, backup.contacts, signal))
  })
  if (cacheKey) {
    try {
      await restoreLocalSettings(cacheKey, backup, restoredChannels, savedContacts, sections.has('regions') && !signal.aborted, results)
    } catch (error) {
      results.push({ label: 'Browser settings', status: 'failed', reason: message(error) })
    }
  } else if (restoredChannels || savedContacts.size || sections.has('regions')) {
    results.push({ label: 'Browser settings', status: 'skipped', reason: 'The destination radio identity could not be verified.' })
  }
  return { results, transferredIdentity }
}

async function restoreLocalSettings(key: RadioKey, backup: BackupData, restored: RestoredChannels | undefined,
  savedContacts: ReadonlySet<string>, regions: boolean, results: BackupResult[]) {
  const storage = await openRadioStorage()
  async function apply(label: string, update: RadioUpdate) {
    try {
      await storage.update(key, update)
      return true
    } catch (error) {
      results.push({ label, status: 'failed', reason: message(error) })
      return false
    }
  }
  try {
    if (restored?.results.some((entry) => entry.channel)) {
      const savedChannels = await apply('Browser channel list', { channels: restored.channels })
      const bySecret = new Map(backup.channels?.map((entry) => [entry.secret, entry]))
      for (const { source, channel } of savedChannels ? restored.results : []) {
        if (!channel) continue
        const settings = bySecret.get(source.secret)
        if (!settings) continue
        const { index, name: channelName } = channel
        const scopeLabel = `${channelName} sending scope`
        if (settings.scope && await apply(scopeLabel, { channelScope: { index, channelName, scope: settings.scope } })) {
          results.push({ label: scopeLabel, status: 'saved' })
        }
        if (settings.retentionSeconds !== undefined) {
          const days = settings.retentionSeconds === null ? null : retentionDays(settings.retentionSeconds)
          if (days === undefined) {
            results.push({ label: `${channelName} retention`, status: 'skipped', reason: 'This duration is unavailable in Packet Pigeon.' })
          } else if (await apply(`${channelName} retention`, { channelRetention: { index, channelName, days } })) {
            results.push({ label: `${channelName} retention`, status: 'saved' })
          }
        }
      }
    }
    for (const { publicKey, name, customName } of backup.contacts ?? []) {
      if (savedContacts.has(publicKey) && customName !== undefined) {
        await apply(`${name} custom name`, { contactPreference: { publicKey, customName } })
      }
    }
    if (regions && backup.regions && await apply('Region transport keys', { regionTransportKeys: backup.regions })) {
      results.push({ label: 'Region transport keys', status: 'saved' })
    }
  } finally {
    storage.close()
  }
}

export async function exportLocalArchive(key: RadioKey) {
  const data: RadioData | null = await readCache(key)
  if (!data) throw new Error('No local archive is available for this radio.')
  return JSON.stringify({
    format: 'packet-pigeon-chat-archive', version: 1, public_key: key,
    messages: data.messages, drafts: data.drafts, read_messages: data.readMessages,
  }, null, 2)
}
