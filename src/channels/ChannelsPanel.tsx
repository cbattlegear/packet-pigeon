import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/index.ts'
import type { SessionCache } from '../integration/session-cache.ts'
import { makeChannelSecret, secretHex } from '../radio/channel-commands.ts'
import { openRadioStorage, radioKeyFromPublicKey, validChannelRetentionSettings, validChannelScopeSettings } from '../storage/index.ts'
import type { ChannelScopeSetting, RadioData, RadioKey, StoredChannel, StoredRegionKey } from '../storage/index.ts'
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
  const [menu, setMenu] = useState<number | null>(null)
  const [editor, setEditor] = useState<{
    key: string; channel?: StoredChannel; mode: 'settings' | 'rename' | 'senders' | 'blocked' | 'create'
    returnFocus: HTMLElement | null
  } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const actionTrigger = useRef<HTMLButtonElement | null>(null)
  const key = liveKey ?? choice
  const [previousKey, setPreviousKey] = useState(key)
  if (share && share.key !== liveKey) setShare(null)
  if (previousKey !== key) {
    setPreviousKey(key)
    setMenu(null)
    setEditor(null)
    setSecret('')
    setStatus('')
  }

  function closeMenu(restore = true) {
    setMenu(null)
    if (restore) actionTrigger.current?.focus()
  }

  function openEditor(mode: NonNullable<typeof editor>['mode'], channel?: StoredChannel) {
    setMenu(null)
    setError(''); setStatus('')
    setEditor({ key, channel, mode,
      returnFocus: channel ? actionTrigger.current : document.activeElement as HTMLElement | null })
  }

  useEffect(() => {
    if (menu === null) return
    const element = menuRef.current
    const positionMenu = () => {
      const anchor = actionTrigger.current?.getBoundingClientRect()
      if (!element || !anchor) return
      const bounds = element.getBoundingClientRect()
      element.style.position = 'fixed'
      element.style.right = 'auto'
      element.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`
      element.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`
    }
    positionMenu()
    element?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const dismissOnMove = () => setMenu(null)
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', dismissOnMove)
    document.addEventListener('scroll', positionMenu, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', dismissOnMove)
      document.removeEventListener('scroll', positionMenu, true)
    }
  }, [menu])

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
  const currentEditor = editor?.key === key && (!editor.channel || channels.some((channel) =>
    channel.index === editor.channel?.index && channel.name === editor.channel.name)) ? editor : null
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
    if (nextName === null && !window.confirm(`Delete "${channel.name}" from the radio? Cached messages remain in this slot.`)) return
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
      setEditor(null)
      setStatus(nextName === null ? 'Channel deleted.' : 'Channel renamed.')
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
      setStatus('Alerts saved.')
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
      setStatus('Sending scope saved locally.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the sending scope.')
    } finally { setBusy(false) }
  }

  return <div className="channel-workspace">
    {share && liveKey === share.key && <ShareCode link={share.link} privateChannel close={() => setShare(null)} />}
    <div className="channel-toolbar">
    {live ? <p className="channel-meta">{live.name || 'Connected radio'} · {channels.length}/{live.capabilities.maxChannels} slots</p>
      : <label>Cached radio <select value={choice} onChange={(event) => {
        setChoice(event.currentTarget.value); setSecret(''); setStatus('')
      }}><option value="">Select a saved radio</option>
        {keys.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
      </select></label>}
    <div className="channel-toolbar-actions">
      {key && <button type="button" onClick={() => openEditor('blocked')}>Blocked names{blocked.size ? ` (${blocked.size})` : ''}</button>}
      {onImport && <button type="button" onClick={onImport}>Import link or QR code</button>}
      <button className="channel-primary" type="button" disabled={!live || busy} onClick={() => openEditor('create')}>Add channel</button>
    </div>
    </div>
    {!live && key && <p className="channel-meta">Offline · Radio actions unavailable</p>}
    {!currentEditor && error && <p role="alert">{error}</p>}
    {!currentEditor && status && <p role="status">{status}</p>}
    {secret && currentEditor?.mode !== 'create' && <div className="channel-secret">
      <p>Save this secret securely, even if saving failed. It disappears when dismissed or you leave.</p>
      <output aria-label="New private channel secret">{secret}</output>
      <button type="button" onClick={() => setSecret('')}>Dismiss secret</button>
    </div>}
    {key && <>
      <div className="channel-filters">
        <label className="channel-search">Search channels <input type="search" placeholder="Find a channel" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></label>
        <label>Sort <select value={sort} onChange={(event) => setSort(event.currentTarget.value)}>
          <option value="slot">Slot</option><option value="name">Name</option>
        </select></label>
      </div>
      {!validRetention && <div role="alert">
        <p>Invalid retention settings. Reset, then reload.</p>
        <button type="button" disabled={busy} onClick={() => void resetRetention()}>Reset invalid retention settings</button>
      </div>}
      {!validScopes && <div role="alert">
        <p>Invalid sending scopes. Reset before sending.</p>
        <button type="button" disabled={busy} onClick={() => void saveScope(null, { mode: 'default' })}>Reset invalid sending scopes</button>
      </div>}
      <ul className="channel-list">{visible.map((channel) => {
        const senders = observedChannelSenders(cachedData?.messages ?? [], channel.index)
        const retention = retentionSettings.find((entry) => entry.index === channel.index)
        const scope = scopeSettings.find((entry) => entry.index === channel.index)
        const paused = retention && (retention.paused || retention.channelName !== channel.name)
        const retentionValue = paused ? 'paused' : retention?.days != null ? String(retention.days) : 'forever'
        const channelCached = cachedData?.channels.some((entry) => entry.index === channel.index && entry.name === channel.name)
        const notification = cachedData?.channelNotifications?.find((entry) => entry.index === channel.index)
        const notificationPaused = notification && (notification.paused || notification.channelName !== channel.name)
        const editing = currentEditor?.channel?.index === channel.index
        const openMenu = () => {
          actionTrigger.current = document.getElementById(`channel-actions-${channel.index}`) as HTMLButtonElement
          setMenu(channel.index)
        }
        const scopePaused = scope && (scope.paused || scope.channelName !== channel.name)
        return <li className="channel-row" key={channel.index} onContextMenu={(event) => {
          if (currentEditor) return
          event.preventDefault(); openMenu()
        }}>
          <span className="channel-slot" aria-label={`Slot ${channel.index}`}>{channel.index}</span>
          <div className="channel-identity"><strong>{channel.name}</strong>
            <span className="channel-meta">{!cacheLoaded ? 'Loading settings…'
              : paused || scopePaused || notificationPaused ? 'Settings paused'
              : `${notification?.mode === 'muted' ? 'Muted' : notification?.mode === 'mentions' ? 'Mentions only' : 'All alerts'} · ${!validScopes ? 'Scope unavailable' : scope?.scope.mode === 'region' ? scope.scope.name : scope?.scope.mode === 'unscoped' ? 'Unscoped' : 'Radio default'}`}
            </span>
          </div>
          <span className="channel-row-retention channel-meta">{!cacheLoaded ? 'Loading settings…' : !validRetention ? 'Retention unavailable'
            : paused ? 'Retention paused' : `${retentionChoices.find((option) => option.value === retentionValue)?.label ?? 'Forever'} retention`}</span>
          <button id={`channel-actions-${channel.index}`} className="channel-actions-button" type="button"
            aria-label={`Actions for ${channel.name}`} aria-haspopup="menu" aria-expanded={menu === channel.index}
            onClick={() => menu === channel.index ? closeMenu() : openMenu()}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || event.key === 'ArrowDown') {
                event.preventDefault(); openMenu()
              }
            }}>...</button>
          {menu === channel.index && <div className="channel-menu" role="menu" aria-label={`Actions for ${channel.name}`} ref={menuRef}
            onKeyDown={(event) => {
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
                buttons[next]?.focus()
              } else if (event.key === 'Escape') { event.preventDefault(); closeMenu() }
              else if (event.key === 'Tab') closeMenu(false)
            }}>
            <button type="button" role="menuitem" onClick={() => openEditor('settings', channel)}>Settings</button>
            <button type="button" role="menuitem" disabled={!live || busy || channel.name.startsWith('#')}
              onClick={() => openEditor('rename', channel)}>Rename</button>
            <button type="button" role="menuitem" disabled={!live || busy} onClick={() => {
              closeMenu(); void shareChannel(channel)
            }}>Share link or QR code</button>
            <button type="button" role="menuitem" onClick={() => openEditor('senders', channel)}>Sender names</button>
            <button className="channel-danger" type="button" role="menuitem" disabled={!live || busy}
              onClick={() => { closeMenu(); void change(channel, null) }}>Delete channel</button>
          </div>}
          {editing && <ChannelDialog title={`${channel.name} · ${currentEditor.mode === 'rename' ? 'Rename' : currentEditor.mode === 'senders' ? 'Sender names' : 'Settings'}`}
            returnFocus={currentEditor.returnFocus} close={() => setEditor(null)}>
          {error && <p role="alert">{error}</p>}
          {status && <p role="status">{status}</p>}
          {currentEditor.mode === 'rename' && <form onSubmit={(event) => {
            event.preventDefault()
            void change(channel, String(new FormData(event.currentTarget).get('name') ?? ''))
          }}>
            <label>Rename <input name="name" defaultValue={channel.name} key={channel.name} disabled={!live || busy || channel.name.startsWith('#')} /></label>
            <button type="submit" disabled={!live || busy || channel.name.startsWith('#')}>Save name</button>
          </form>}
          {currentEditor.mode === 'settings' && <>
          <span className="channel-meta">Saved in this browser</span>
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
          {paused && <p role="alert">Slot changed. Choose retention again.</p>}
          <ScopeEditor key={`${key}:${channel.name}:${scope?.scope.mode}:${scope?.scope.mode === 'region' ? scope.scope.name : ''}:${scope?.paused}`}
            channel={channel} setting={scope} regions={cachedData?.regionTransportKeys ?? []}
            disabled={!channelCached || !validScopes || busy}
            version={live?.capabilities.firmwareProtocolVersion}
            save={(scope) => void saveScope(channel, scope)} />
          </>}
          {currentEditor.mode === 'senders' && <>
            <p className="channel-meta">Unverified names · Not channel members</p>
            {!cacheLoaded ? <p>Loading cached messages…</p> : senders.length
              ? <ul className="channel-senders">{senders.map(({ name, count }) => <li key={name}>
                <span>{name} ({count} receipt{count === 1 ? '' : 's'})</span>
                <button type="button" disabled={busy} onClick={() => void setBlocked(name, !blocked.has(name))}
                  aria-label={`${blocked.has(name) ? 'Unblock' : 'Block'} sender name ${name}`}>
                  {blocked.has(name) ? 'Unblock' : 'Block name'}
                </button>
              </li>)}</ul> : <p>No sender names yet.</p>}
          </>}
          </ChannelDialog>}
        </li>
      })}</ul>
      {!visible.length && <div className="channel-empty">{search ? <>
        <p>No matching channels.</p><button type="button" onClick={() => setSearch('')}>Clear search</button>
      </> : <p>{live ? 'No channels. Add one to get started.' : cacheLoaded ? 'No cached channels.' : 'Loading channels…'}</p>}</div>}
      {currentEditor?.mode === 'blocked' && <ChannelDialog title="Blocked sender names" close={() => setEditor(null)}>
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        <p className="channel-meta">Exact names · Hidden locally across this radio&apos;s channels</p>
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
        {!blocked.size && <p>No blocked names.</p>}
      </ChannelDialog>}
    </>}
    {!key && <div className="channel-empty">Select a saved radio or connect one.</div>}
    {currentEditor?.mode === 'create' && <ChannelDialog title="Add channel" close={() => setEditor(null)}>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {secret && <div className="channel-secret">
      <p>Save this secret securely, even if saving failed.</p>
      <output aria-label="New private channel secret">{secret}</output>
      <button type="button" onClick={() => setSecret('')}>Dismiss secret</button>
    </div>}
    <form className="channel-create" onSubmit={(event) => void create(event)}>
      <label>Type <select value={kind} onChange={(event) => setKind(event.currentTarget.value as typeof kind)} disabled={!live || busy}>
        <option value="private">Create private</option><option value="join">Join private</option>
        <option value="public">Public</option><option value="hashtag">Hashtag</option>
      </select></label>
      {(kind === 'public' || kind === 'hashtag') && <p className="channel-meta">Discoverable key · Not private</p>}
      <label>Channel name <input name="name" required disabled={!live || busy} placeholder={kind === 'hashtag' ? '#topic' : undefined} /></label>
      {kind === 'join' && <label>Private secret (32 hexadecimal characters)
        <input name="secret" type="password" autoComplete="off" required disabled={!live || busy} />
      </label>}
      <button type="submit" disabled={!live || busy}>Save channel</button>
    </form>
    </ChannelDialog>}
  </div>
}

function ChannelDialog({ title, close, children, returnFocus }: {
  title: string; close: () => void; children: ReactNode; returnFocus?: HTMLElement | null
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { dialog?.close(); previous?.focus() }
  }, [returnFocus])
  return <dialog ref={ref} className="channel-dialog" aria-label={title} onCancel={close}>
    <div className="channel-dialog-heading"><h2>{title}</h2><button type="button" aria-label="Close" onClick={close}>Close</button></div>
    {children}
  </dialog>
}

function ScopeEditor({ channel, setting, regions, disabled, version, save }: {
  channel: StoredChannel
  setting?: ChannelScopeSetting
  regions: readonly StoredRegionKey[]
  disabled: boolean
  version?: number
  save: (scope: ChannelScope) => void
}) {
  const [mode, setMode] = useState<ChannelScope['mode']>(setting?.scope.mode ?? 'default')
  const [name, setName] = useState(setting?.scope.mode === 'region' ? setting.scope.name : '')
  const paused = setting && (setting.paused || setting.channelName !== channel.name)
  const regionList = `channel-regions-${channel.index}`
  return <form onSubmit={(event) => {
    event.preventDefault()
    if (mode === 'region') {
      const raw = name.trim()
      const canonical = raw.startsWith('#') ? raw : `#${raw}`
      const savedKey = setting?.scope.mode === 'region' && setting.scope.name === canonical ? setting.scope.key : undefined
      const key = savedKey ?? regions.find((entry) => entry.name === canonical)?.key
      save({ mode, name, ...(key ? { key } : {}) })
    } else save({ mode })
  }}>
    <label>Sending scope
      <select aria-label={`Sending scope for ${channel.name}`} value={mode} disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.value
          if (value === 'default' || value === 'region' || value === 'unscoped') setMode(value)
        }}>
        <option value="default">Radio default</option>
        <option value="region">Named region</option>
        <option value="unscoped">Unscoped</option>
      </select>
    </label>
    {mode === 'region' && <label>Region name
      <input aria-label={`Region name for ${channel.name}`} value={name} required disabled={disabled}
        list={regions.length ? regionList : undefined} placeholder="#region" onChange={(event) => setName(event.currentTarget.value)} />
      {regions.length > 0 && <datalist id={regionList}>{regions.map(({ name }) => <option key={name} value={name} />)}</datalist>}
    </label>}
    <button type="submit" disabled={disabled}>Save sending scope</button>
    {mode !== 'default' && <p className="channel-meta">{mode === 'unscoped' ? 'Can travel beyond a region.' : 'Routing filter, not a privacy boundary.'}</p>}
    {paused && <p role="alert">Slot changed. Save a scope before sending.</p>}
    {version !== undefined && ((mode === 'region' && version < 8) || (mode === 'unscoped' && version < 12)) && (
      <p role="alert">Unsupported scope. Choose Radio default or update firmware.</p>
    )}
  </form>
}
