import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/index.ts'
import { makeChannelSecret, secretHex } from '../radio/channel-commands.ts'
import { openRadioStorage, radioKeyFromPublicKey, validChannelRetentionSettings } from '../storage/index.ts'
import type { RadioData, RadioKey, StoredChannel } from '../storage/index.ts'
import { observedChannelSenders } from './senders.ts'
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
  session: Pick<CompanionSession, 'createChannel' | 'changeChannel'>
  cacheSaving: boolean
  messageSyncing: boolean
  onBlockedSendersChanged: (key: RadioKey) => void
}

export function ChannelsPanel({ snapshot, session, cacheSaving, messageSyncing, onBlockedSendersChanged }: Props) {
  const live = snapshot.phase === 'ready' ? snapshot.device : null
  const liveKey = live ? radioKeyFromPublicKey(live.publicKey) : null
  const [choice, setChoice] = useState('')
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [cached, setCached] = useState<{ key: string; data: RadioData | null } | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('slot')
  const [kind, setKind] = useState<'private' | 'join' | 'public' | 'hashtag'>('private')
  const key = liveKey ?? choice

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
  }, [key, cacheSaving, messageSyncing])

  const cacheLoaded = Boolean(key) && cached?.key === key
  const cachedData = cacheLoaded ? cached.data : null
  const channels = live ? snapshot.channels : cachedData?.channels ?? []
  const validRetention = cachedData?.channelRetention === undefined
    || validChannelRetentionSettings(cachedData.channelRetention)
  const retentionSettings = validRetention ? cachedData?.channelRetention ?? [] : []
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
      await session.changeChannel(liveKey, channel.index, channel.name, nextName)
      if (nextName !== null && nextName.trim() !== channel.name) {
        try {
          const storage = await openRadioStorage()
          try {
            await storage.update(liveKey, { channelRetentionRename: {
              index: channel.index, from: channel.name, to: nextName.trim(),
            } })
            const data = await storage.read(liveKey)
            setCached((current) => current?.key === liveKey ? { key: liveKey, data } : current)
          } finally { storage.close() }
        } catch (reason) {
          setError(`The channel was renamed on the radio, but its local retention setting could not be updated: ${reason instanceof Error ? reason.message : 'Storage error.'}`)
          return
        }
      }
      setStatus(nextName === null ? 'Channel deleted from the radio.' : 'Channel renamed on the radio.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change the channel.')
    } finally { setBusy(false) }
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

  return <div className="channel-workspace">
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
      <ul className="channel-list">{visible.map((channel) => {
        const senders = observedChannelSenders(cachedData?.messages ?? [], channel.index)
        const retention = retentionSettings.find((entry) => entry.index === channel.index)
        const paused = retention && retention.channelName !== channel.name
        const retentionValue = paused ? 'paused' : retention ? String(retention.days) : 'forever'
        const channelCached = cachedData?.channels.some((entry) => entry.index === channel.index && entry.name === channel.name)
        return <li key={channel.index}>
          <div><strong>{channel.name}</strong> <span>Slot {channel.index}</span></div>
          <form onSubmit={(event) => {
            event.preventDefault()
            void change(channel, String(new FormData(event.currentTarget).get('name') ?? ''))
          }}>
            <label>Rename <input name="name" defaultValue={channel.name} key={channel.name} disabled={!live || busy || channel.name.startsWith('#')} /></label>
            <button type="submit" disabled={!live || busy || channel.name.startsWith('#')}>Save name</button>
            <button type="button" disabled={!live || busy} onClick={() => void change(channel, null)}>Delete</button>
          </form>
          <label className="channel-retention">Message retention
            <select aria-label={`Message retention for ${channel.name}`} value={retentionValue}
              disabled={!channelCached || !validRetention || busy} onChange={(event) => void setRetention(channel, event.currentTarget.value)}>
              {paused && <option value="paused" disabled>Paused: slot name changed</option>}
              {retentionChoices.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>
          {paused && <p>Retention is paused because this slot changed names. Choose a setting for this channel.</p>}
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
    <p>Notification mode and per-channel region scope are not available yet. No region scope is changed here.</p>
  </div>
}
