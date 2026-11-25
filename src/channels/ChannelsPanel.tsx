import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/index.ts'
import { makeChannelSecret, secretHex } from '../radio/channel-commands.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioKey, StoredChannel } from '../storage/index.ts'
import './channels.css'

type Props = {
  snapshot: CompanionSnapshot
  session: Pick<CompanionSession, 'createChannel' | 'changeChannel'>
  cacheSaving: boolean
}

export function ChannelsPanel({ snapshot, session, cacheSaving }: Props) {
  const live = snapshot.phase === 'ready' ? snapshot.device : null
  const liveKey = live ? radioKeyFromPublicKey(live.publicKey) : null
  const [choice, setChoice] = useState('')
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [cached, setCached] = useState<{ key: string; channels: StoredChannel[] } | null>(null)
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
            setCached(key ? { key, channels: data?.channels ?? [] } : null)
            setError('')
          }
        } finally { storage.close() }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load channels.')
      }
    }
    void load()
    return () => { active = false }
  }, [key, cacheSaving])

  const channels = live ? snapshot.channels : cached?.key === key ? cached.channels : []
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
      setStatus(nextName === null ? 'Channel deleted from the radio.' : 'Channel renamed on the radio.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change the channel.')
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
      <ul className="channel-list">{visible.map((channel) => <li key={channel.index}>
        <div><strong>{channel.name}</strong> <span>Slot {channel.index}</span></div>
        <form onSubmit={(event) => {
          event.preventDefault()
          void change(channel, String(new FormData(event.currentTarget).get('name') ?? ''))
        }}>
          <label>Rename <input name="name" defaultValue={channel.name} key={channel.name} disabled={!live || busy || channel.name.startsWith('#')} /></label>
          <button type="submit" disabled={!live || busy || channel.name.startsWith('#')}>Save name</button>
          <button type="button" disabled={!live || busy} onClick={() => void change(channel, null)}>Delete</button>
        </form>
      </li>)}</ul>
      {!visible.length && <p>No channels match.</p>}
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
    <p>Notification mode, retention, participants, blocked senders, and per-channel region scope are not available yet. No region scope is changed here.</p>
  </div>
}
