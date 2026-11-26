import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/index.ts'
import type { SessionCache } from '../integration/session-cache.ts'
import { makeChannelSecret, secretHex } from '../radio/channel-commands.ts'
import { openRadioStorage, radioKeyFromPublicKey, validChannelRetentionSettings, validChannelScopeSettings } from '../storage/index.ts'
import type { ChannelScopeSetting, RadioData, RadioKey, StoredChannel } from '../storage/index.ts'
import { validateChannelScope } from '../radio/channel-scope.ts'
import type { ChannelScope } from '../radio/channel-scope.ts'
import { observedChannelSenders } from './senders.ts'
import { ShareCode } from '../sharing/ShareDialogs.tsx'
import { formatMeshCoreShare } from '../sharing/meshcoreLinks.ts'
import './channels.css'

const retentionChoices = [
  { value: 'forever', days: null, label: 'Forever' },
  { value: '1', days: 1, label: '1 day' },
  { value: '7', days: 7, label: '7 days' },
  { value: '30', days: 30, label: '30 days' },
  { value: '90', days: 90, label: '90 days' },
] as const

type Props = {
  snapshot: CompanionSnapshot
  session: Pick<CompanionSession, 'createChannel' | 'changeChannel' | 'readChannelShareKey'>
  cache: Pick<SessionCache, 'renameChannelRetention'>
  cacheSaving: boolean
  messageSyncing: boolean
  onBlockedSendersChanged: (key: RadioKey) => void
  onImport?: () => void
  radioNavigation?: { key: RadioKey; sequence: number } | null
  onRadioNavigationHandled?: () => void
}

export function ChannelsPanel({ snapshot, session, cache, cacheSaving, messageSyncing, onBlockedSendersChanged, onImport,
  radioNavigation, onRadioNavigationHandled }: Props) {
  const live = snapshot.phase === 'ready' ? snapshot.device : null
  const liveKey = live ? radioKeyFromPublicKey(live.publicKey) : null
  const [choice, setChoice] = useState('')
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [cached, setCached] = useState<{ key: string; data: RadioData | null } | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [secret, setSecret] = useState('')
  const [share, setShare] = useState<{ key: RadioKey; link: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('slot')
  const [kind, setKind] = useState<'private' | 'join' | 'public' | 'hashtag'>('private')
  const key = liveKey ?? choice
  if (share && share.key !== liveKey) setShare(null)

  useEffect(() => {
    if (!radioNavigation) return
    setChoice(radioNavigation.key)
    onRadioNavigationHandled?.()
  }, [radioNavigation, onRadioNavigationHandled])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const storage = await openRadioStorage()
        try {
          const [all, data] = await Promise.all([storage.listRadioKeys(), key ? storage.read(radioKeyFromPublicKey(key)) : null])
          if (active) {
            setKeys(all)
            setCached(key ? { key, data } : null)
            setError('')
          }
        } finally { storage.close() }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load channels.')
      }
    }
    void load()
    return () => { active = false }
  }, [key, cacheSaving, messageSyncing, snapshot.channels])

  const cacheLoaded = Boolean(key) && cached?.key === key
  const cachedData = cacheLoaded ? cached.data : null
  const channels = live ? snapshot.channels : cachedData?.channels ?? []
  const validRetention = cachedData?.channelRetention === undefined
    || validChannelRetentionSettings(cachedData.channelRetention)
  const retentionSettings = validRetention ? cachedData?.channelRetention ?? [] : []
  const validScopes = cachedData?.channelScopes === undefined || validChannelScopeSettings(cachedData.channelScopes)
  const scopeSettings = validScopes ? cachedData?.channelScopes ?? [] : []
  const blocked = new Set(cachedData?.blockedChannelSenders ?? [])
  const visible = channels.filter((channel) =>
    channel.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .slice().sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) || a.index - b.index : a.index - b.index)

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!liveKey || busy) return
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true); setError(''); setStatus(''); setSecret('')
    try {
      const generated = kind === 'private'
        ? secretHex(await makeChannelSecret('private', '', '')) : ''
      if (generated) setSecret(generated)
      await session.createChannel(liveKey, {
        kind: generated ? 'join' : kind, name: String(data.get('name') ?? ''),
        secret: generated || String(data.get('secret') ?? ''),
      })
      form.reset()
      setStatus('Channel saved to the radio.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the channel.')
    } finally { setBusy(false) }
  }

  async function change(channel: StoredChannel, nextName: string | null) {
    if (!liveKey || busy) return
    if (nextName === null && !window.confirm(`Delete "${channel.name}" from the radio? Existing cached messages are not deleted and may still be associated with this slot.`)) return
    setBusy(true); setError(''); setStatus(''); setSecret('')
    try {
      let retentionError: unknown
      let retentionFailed = false
      const renamed = nextName?.trim()
      const saveRename = renamed && renamed !== channel.name ? async () => {
        try {
          await cache.renameChannelRetention(liveKey, {
            index: channel.index, from: channel.name, to: renamed,
          })
          const storage = await openRadioStorage()
          try {
            const data = await storage.read(liveKey)
            setCached((current) => current?.key === liveKey ? { key: liveKey, data } : current)
          } finally { storage.close() }
        } catch (reason) {
          retentionFailed = true
          retentionError = reason
        }
      } : undefined
      await session.changeChannel(liveKey, channel.index, channel.name, nextName, saveRename)
      if (retentionFailed) {
        setError(`The channel was renamed on the radio, but its local retention setting could not be updated: ${retentionError instanceof Error ? retentionError.message : 'Storage error.'}`)
        return
      }
      setStatus(nextName === null ? 'Channel deleted from the radio.' : 'Channel renamed on the radio.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change the channel.')
    } finally { setBusy(false) }
  }

  async function shareChannel(channel: StoredChannel) {
    if (!liveKey || busy || !window.confirm(`Show a link and QR code for "${channel.name}"? They include the channel key and can be used to join.`)) return
    setBusy(true)
    setError('')
    try {
      const secret = await session.readChannelShareKey(liveKey, channel.index, channel.name)
      setShare({ key: liveKey, link: formatMeshCoreShare({ kind: 'channel', name: channel.name, secret }) })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read the channel key.')
    } finally {
      setBusy(false)
    }
  }

  async function setBlocked(name: string, value: boolean) {
    if (!key || !cacheLoaded || busy) return false
    const radioKey = radioKeyFromPublicKey(key)
    setBusy(true); setError(''); setStatus('')
    try {
      const storage = await openRadioStorage()
      try {
        await storage.update(radioKey, { blockedChannelSender: { name, blocked: value } })
        onBlockedSendersChanged(radioKey)
        const data = await storage.read(radioKey)
        setCached((current) => current?.key === radioKey ? { key: radioKey, data } : current)
      } finally { storage.close() }
      setStatus(value ? 'Sender name blocked on this radio.' : 'Sender name unblocked on this radio.')
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the sender block.')
      return false
    } finally { setBusy(false) }
  }

  async function setRetention(channel: StoredChannel, value: string) {
    if (!key || !cacheLoaded || busy) return
    const option = retentionChoices.find((entry) => entry.value === value)
    if (!option) {
      setError('Choose a valid retention period.')
      return
    }

    if (option.days !== null && !window.confirm(
      `At startup, cached messages in "${channel.name}" older than ${option.label} will be permanently deleted using sender-provided timestamps. Continue?`,
    )) return
    const radioKey = radioKeyFromPublicKey(key)
    setBusy(true); setError(''); setStatus('')
    try {
      const storage = await openRadioStorage()
      try {
        await storage.update(radioKey, { channelRetention: {
          index: channel.index, channelName: channel.name, days: option.days,
        } })
        const data = await storage.read(radioKey)
        setCached((current) => current?.key === radioKey ? { key: radioKey, data } : current)
      } finally { storage.close() }
      setStatus('Retention saved. Cleanup runs when the app starts.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save channel retention.')
    } finally { setBusy(false) }
  }

  async function setNotification(channel: StoredChannel, mode: string) {
    if (!key || !cacheLoaded || busy || (mode !== 'all' && mode !== 'mentions' && mode !== 'muted')) return
    const radioKey = radioKeyFromPublicKey(key)
    setBusy(true); setError(''); setStatus('')
    try {
      const storage = await openRadioStorage()
      try {
        await storage.update(radioKey, { channelNotification: { index: channel.index, channelName: channel.name, mode } })
        const data = await storage.read(radioKey)
        setCached((current) => current?.key === radioKey ? { key: radioKey, data } : current)
      } finally { storage.close() }
      setStatus('Notification mode saved for this browser and radio.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save notification mode.')
    } finally { setBusy(false) }
  }

  async function resetRetention() {
    if (!key || !cacheLoaded || busy || !window.confirm(
      'Reset this radio’s channel retention settings to Forever? No messages will be deleted.',
    )) return
    const radioKey = radioKeyFromPublicKey(key)
    setBusy(true); setError(''); setStatus('')
    try {
      const storage = await openRadioStorage()
      try {
        await storage.update(radioKey, { resetChannelRetention: true })
        const data = await storage.read(radioKey)
        setCached((current) => current?.key === radioKey ? { key: radioKey, data } : current)
      } finally { storage.close() }
      setStatus('Retention settings reset. Reload to retry cleanup.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reset channel retention.')
    } finally { setBusy(false) }
  }

  async function saveScope(channel: StoredChannel | null, scope: ChannelScope) {
    if (!key || !cacheLoaded || busy) return
    const radioKey = radioKeyFromPublicKey(key)
    setBusy(true); setError(''); setStatus('')
    try {
      const storage = await openRadioStorage()
      try {
        await storage.update(radioKey, channel
          ? { channelScope: { index: channel.index, channelName: channel.name, scope: validateChannelScope(scope) } }
          : { resetChannelScopes: true })
        const data = await storage.read(radioKey)
        setCached((current) => current?.key === radioKey ? { key: radioKey, data } : current)
        onBlockedSendersChanged(radioKey)
      } finally { storage.close() }
      setStatus('Sending scope saved for this browser and radio. No radio settings were changed.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the sending scope.')
    } finally { setBusy(false) }
  }

  return <div className="channel-workspace">
    {share && liveKey === share.key && <ShareCode link={share.link} privateChannel close={() => setShare(null)} />}
    {onImport && <div><button type="button" onClick={onImport}>Import link or QR code</button></div>}
    {live ? <p>{live.name || 'Connected radio'} · {channels.length} of {live.capabilities.maxChannels} channel slots used</p>
      : <label>Cached radio <select value={choice} onChange={(event) => {
        setChoice(event.currentTarget.value); setSecret(''); setStatus('')
      }}><option value="">Select a saved radio</option>
        {keys.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
      </select></label>}
    <p>Public and hashtag keys are discoverable and are not private. Private channel access depends on keeping its secret safe.</p>
    {!live && <p>Connect a radio and wait for sync to change channels.</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {secret && <div className="channel-secret">
      <p>Save this private secret securely now, even if the save reports an error: the radio may have accepted it. It is not stored by Packet Pigeon and disappears when dismissed or you leave this page.</p>
      <output aria-label="New private channel secret">{secret}</output>
      <button type="button" onClick={() => setSecret('')}>Dismiss secret</button>
    </div>}
    {key && <>
      <div className="channel-filters">
        <label>Search channels <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></label>
        <label>Sort <select value={sort} onChange={(event) => setSort(event.currentTarget.value)}>
          <option value="slot">Slot</option><option value="name">Name</option>
        </select></label>
      </div>
      <p className="channel-retention-help">Retention is browser-local. At startup, dated cached channel messages older than the selected period are
        permanently deleted using the sender&apos;s clock, which can be wrong or manipulated. Undated and zero-timestamp
        messages are kept. A changed slot name pauses cleanup until you choose a setting. A replacement with the same
        slot and name cannot be distinguished.</p>
      {!validRetention && <div role="alert">
        <p>Saved retention settings for this radio are invalid. Reset them to Forever, then reload to retry cleanup.</p>
        <button type="button" disabled={busy} onClick={() => void resetRetention()}>Reset invalid retention settings</button>
      </div>}
      <p>Sending scopes are browser-local, per channel and radio. Radio default uses the radio&apos;s configured default region.
        Unscoped can travel beyond a region. Public hashtag region names are routing filters, not privacy or delivery guarantees.
        An observed slot-name change pauses its saved scope until you choose again.</p>
      {!validScopes && <div role="alert">
        <p>Saved sending scopes are invalid. Reset them to Radio default before sending.</p>
        <button type="button" disabled={busy} onClick={() => void saveScope(null, { mode: 'default' })}>Reset invalid sending scopes</button>
      </div>}
      <ul className="channel-list">{visible.map((channel) => {
        const senders = observedChannelSenders(cachedData?.messages ?? [], channel.index)
        const retention = retentionSettings.find((entry) => entry.index === channel.index)
        const paused = retention && (retention.paused || retention.channelName !== channel.name)
        const retentionValue = paused ? 'paused' : retention ? String(retention.days) : 'forever'
        const channelCached = cachedData?.channels.some((entry) => entry.index === channel.index && entry.name === channel.name)
        const notification = cachedData?.channelNotifications?.find((entry) => entry.index === channel.index)
        const notificationPaused = notification && (notification.paused || notification.channelName !== channel.name)
        return <li key={channel.index}>
          <div><strong>{channel.name}</strong> <span>Slot {channel.index}</span></div>
          <form onSubmit={(event) => {
            event.preventDefault()
            void change(channel, String(new FormData(event.currentTarget).get('name') ?? ''))
          }}>
            <label>Rename <input name="name" defaultValue={channel.name} key={channel.name} disabled={!live || busy || channel.name.startsWith('#')} /></label>
            <button type="submit" disabled={!live || busy || channel.name.startsWith('#')}>Save name</button>
            <button type="button" disabled={!live || busy} onClick={() => void change(channel, null)}>Delete</button>
            <button type="button" disabled={!live || busy}
              onClick={() => void shareChannel(channel)}>Share link or QR code</button>
          </form>
          <label className="channel-retention">Message retention
            <select aria-label={`Message retention for ${channel.name}`} value={retentionValue}
              disabled={!channelCached || !validRetention || busy} onChange={(event) => void setRetention(channel, event.currentTarget.value)}>
              {paused && <option value="paused" disabled>Paused: slot name changed</option>}
              {retentionChoices.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>Browser alerts
            <select aria-label={`Browser alerts for ${channel.name}`} value={notificationPaused ? 'paused' : notification?.mode ?? 'all'}
              disabled={!channelCached || busy} onChange={(event) => void setNotification(channel, event.currentTarget.value)}>
              {notificationPaused && <option value="paused" disabled>Paused: slot changed</option>}
              <option value="all">All messages</option>
              <option value="mentions">Mentions only</option>
              <option value="muted">Muted</option>
            </select>
          </label>
          {paused && <p>Retention is paused because this slot changed names. Choose a setting for this channel.</p>}
          <ScopeEditor key={`${key}:${channel.name}:${JSON.stringify(scopeSettings.find((entry) => entry.index === channel.index))}`}
            channel={channel} setting={scopeSettings.find((entry) => entry.index === channel.index)}
            disabled={!channelCached || !validScopes || busy}
            version={live?.capabilities.firmwareProtocolVersion}
            save={(scope) => void saveScope(channel, scope)} />
          <details>
            <summary>Observed sender names</summary>
            <p>Names come from recognizable &quot;name: message&quot; text in this slot, not a membership list. They are unverified and can be spoofed.</p>
            {!cacheLoaded ? <p>Loading cached messages…</p> : senders.length
              ? <ul className="channel-senders">{senders.map(({ name, count }) => <li key={name}>
                <span>{name} ({count} receipt{count === 1 ? '' : 's'})</span>
                <button type="button" disabled={busy} onClick={() => void setBlocked(name, !blocked.has(name))}
                  aria-label={`${blocked.has(name) ? 'Unblock' : 'Block'} sender name ${name}`}>
                  {blocked.has(name) ? 'Unblock' : 'Block name'}
                </button>
              </li>)}</ul> : <p>No sender names observed in cached channel text.</p>}
          </details>
        </li>
      })}</ul>
      {!visible.length && <p>No channels match.</p>}
      <section className="channel-blocked" aria-labelledby="blocked-senders-heading">
        <h2 id="blocked-senders-heading">Blocked sender names</h2>
        <p>Blocks apply to all channels on this radio and match recognizable sender names exactly. Names can be impersonated or changed.
          Matching messages are hidden locally, not deleted or prevented from reaching the radio.</p>
        <form onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          void setBlocked(String(new FormData(form).get('sender') ?? ''), true).then((saved) => {
            if (saved) form.reset()
          })
        }}>
          <label>Sender name <input name="sender" required disabled={!cacheLoaded || busy} /></label>
          <button type="submit" disabled={!cacheLoaded || busy}>Block name</button>
        </form>
        {blocked.size > 0 && <ul className="channel-senders">{[...blocked].sort((a, b) => a.localeCompare(b))
          .map((name) => <li key={name}><span>{name}</span>
            <button type="button" disabled={busy} onClick={() => void setBlocked(name, false)}
              aria-label={`Unblock sender name ${name}`}>Unblock</button>
          </li>)}</ul>}
      </section>
    </>}
    <form className="channel-create" onSubmit={(event) => void create(event)}>
      <h2>Add channel</h2>
      <label>Type <select value={kind} onChange={(event) => setKind(event.currentTarget.value as typeof kind)} disabled={!live || busy}>
        <option value="private">Create private</option><option value="join">Join private</option>
        <option value="public">Public</option><option value="hashtag">Hashtag</option>
      </select></label>
      <label>Channel name <input name="name" required disabled={!live || busy} placeholder={kind === 'hashtag' ? '#topic' : undefined} /></label>
      {kind === 'join' && <label>Private secret (32 hexadecimal characters)
        <input name="secret" type="password" autoComplete="off" required disabled={!live || busy} />
      </label>}
      <button type="submit" disabled={!live || busy}>Save channel</button>
    </form>
    <p>Renaming keeps the existing key; hashtag channels cannot be renamed. Reusing a slot can associate its old cached messages with the new channel.</p>
    <p>Browser alert modes apply to manually synced messages while this app is open. Mentions match the radio name without regard to case; names are unverified. A removed slot or changed slot name pauses alerts until a mode is chosen. A replacement with the same name without an observed removal cannot be distinguished.</p>
    <p>Sending scopes do not change the radio&apos;s saved default region.</p>
  </div>
}

function ScopeEditor({ channel, setting, disabled, version, save }: {
  channel: StoredChannel
  setting?: ChannelScopeSetting
  disabled: boolean
  version?: number
  save: (scope: ChannelScope) => void
}) {
  const [mode, setMode] = useState<ChannelScope['mode']>(setting?.scope.mode ?? 'default')
  const [name, setName] = useState(setting?.scope.mode === 'region' ? setting.scope.name : '')
  const paused = setting && (setting.paused || setting.channelName !== channel.name)
  return <form onSubmit={(event) => {
    event.preventDefault()
    save(mode === 'region' ? { mode, name } : { mode })
  }}>
    <label>Sending scope
      <select aria-label={`Sending scope for ${channel.name}`} value={mode} disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.value
          if (value === 'default' || value === 'region' || value === 'unscoped') setMode(value)
        }}>
        <option value="default">Radio default</option>
        <option value="region">Named region (protocol v8+)</option>
        <option value="unscoped">Explicitly unscoped (protocol v12+)</option>
      </select>
    </label>
    {mode === 'region' && <label>Region name
      <input aria-label={`Region name for ${channel.name}`} value={name} required disabled={disabled}
        placeholder="#region" onChange={(event) => setName(event.currentTarget.value)} />
    </label>}
    <button type="submit" disabled={disabled}>Save sending scope</button>
    {paused && <p role="alert">Sending scope is paused because this slot changed names. Save a scope before sending.</p>}
    {version !== undefined && ((mode === 'region' && version < 8) || (mode === 'unscoped' && version < 12)) && (
      <p role="alert">This radio&apos;s firmware cannot send using the selected scope. Choose Radio default or update the firmware.</p>
    )}
  </form>
}
