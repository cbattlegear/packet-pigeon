import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { MessageSync } from '../integration/message-sync.ts'
import type { CompanionSession } from '../radio/companion-session.ts'
import { repeaterCliCommand, repeaterCliCommands, repeaterOwnerInfoCommand, repeaterPositionCommand, UncertainRepeaterCliError } from '../radio/repeater-cli.ts'
import type { RepeaterCliReceipt } from '../radio/repeater-cli.ts'

export type RepeaterMessageSync = Pick<MessageSync, 'subscribe' | 'getSnapshot' | 'subscribeToSavedReceipts' | 'sync'>

type Props = {
  session: Pick<CompanionSession, 'sendRepeaterCommand'>
  messageSync: RepeaterMessageSync
  radioKey: string
  contactKey: string
  name: string
  route: { pathLength: number; pathHex: string }
  ready: boolean
  busy: boolean
  onPending: (pending: boolean) => void
}

type HistoryEntry = {
  command: string
  description: string
  tag: string
  route: RepeaterCliReceipt['route'] | null
  deadline: number
  reply: string | null
  unconfirmed: boolean
}

export function RepeaterCli({ session, messageSync, radioKey, contactKey, name, route, ready, busy, onPending }: Props) {
  const ownerInfoId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [intervalKind, setIntervalKind] = useState<'advert.interval' | 'flood.advert.interval'>('advert.interval')
  const [interval, setInterval] = useState('')
  const [ownerInfo, setOwnerInfo] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState(false)
  const [syncRequested, setSyncRequested] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const syncStatus = useSyncExternalStore(messageSync.subscribe, messageSync.getSnapshot)
  const term = query.trim().toLowerCase()
  const choices = repeaterCliCommands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(term))
  const matchingHistory = history.filter((item) =>
    `${item.command} ${item.description} ${item.reply ?? ''}`.toLowerCase().includes(term))
  const action = repeaterCliCommands.find((item) => item.command === selected)

  useEffect(() => messageSync.subscribeToSavedReceipts((key, message) => {
    const receipt = message.receipt
    if (key !== radioKey || receipt?.kind !== 'direct-text' || receipt.textType !== 1 ||
      receipt.senderKeyPrefix !== contactKey.slice(0, 12) || receipt.text[2] !== '|') return
    const tag = receipt.text.slice(0, 2)
    setHistory((current) => current.map((item) => item.tag === tag && item.reply === null
      ? { ...item, reply: receipt.text.slice(3).trimStart() } : item))
  }), [messageSync, radioKey, contactKey])

  useEffect(() => {
    const next = history.reduce((earliest, item) =>
      item.reply === null && item.deadline > now ? Math.min(earliest, item.deadline) : earliest, Infinity)
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now()))
    return () => clearTimeout(timer)
  }, [history, now])

  useEffect(() => () => request.current?.abort(new Error('Stopped waiting for the radio.')), [])

  async function send(command: string, description: string, confirmed: boolean, warning = '') {
    if (!ready || busy || pending || syncStatus.syncing) return
    if (confirmed && !window.confirm(`${description} on ${name}? This will transmit over the mesh.${warning ? ` ${warning}` : ''}`)) return
    if (term && !`${command} ${description}`.toLowerCase().includes(term)) setQuery('')
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    onPending(true)
    setError('')
    try {
      const result = await session.sendRepeaterCommand(radioKey, contactKey, route, command, confirmed, controller.signal)
      const sentAt = Date.now()
      setNow(sentAt)
      setHistory((current) => [...current.slice(-99), {
        command, description, tag: result.tag, route: result.route, deadline: sentAt + result.timeoutMs,
        reply: null, unconfirmed: false,
      }])
    } catch (reason) {
      if (reason instanceof UncertainRepeaterCliError) {
        const sentAt = Date.now()
        setNow(sentAt)
        setHistory((current) => [...current.slice(-99), {
          command, description, tag: reason.tag, route: null, deadline: sentAt + 120_000,
          reply: null, unconfirmed: true,
        }])
      }
      setError(reason instanceof Error ? reason.message : 'The repeater command failed.')
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
      onPending(false)
    }
  }

  function submitInterval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set ${intervalKind} ${interval}`)
      const unit = intervalKind === 'advert.interval' ? 'minutes' : 'hours'
      const description = interval === '0' ? `Disable ${intervalKind === 'advert.interval' ? 'local' : 'flood'} advertisements`
        : `${command.description} to ${interval} ${unit}`
      void send(command.command, description, true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid advertisement interval.')
    }
  }

  function submitOwnerInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterOwnerInfoCommand(ownerInfo)
      const description = ownerInfo ? 'Replace owner information' : 'Clear owner information'
      const preview = ownerInfo ? `\n\n${ownerInfo}` : ''
      void send(command.command, description, true,
        `This information can be requested over the mesh. Do not include passwords or private data.${preview}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid owner information.')
    }
  }

  function submitPosition(event: FormEvent<HTMLFormElement>, axis: 'lat' | 'lon', value: string) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterPositionCommand(axis, value)
      const coordinate = axis === 'lat' ? 'latitude' : 'longitude'
      void send(command.command, `Set stored ${coordinate} to ${value}`,
        true, 'Advertisements use stored coordinates only when the GPS advert policy is prefs.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid advertised position.')
    }
  }

  return <details>
    <summary>Administrator CLI</summary>
    <p>Choose a supported query or confirmed management action. Commands are never retried automatically.
      Replies are saved with other messages when you sync; history here lasts while this repeater stays selected.</p>
    <p>Companion firmware v1.11 and earlier may cause CLI commands to be ignored. Upgrade the companion firmware if commands do not receive replies.</p>
    <p>Reply tags help match responses, but a delayed reply from an earlier browser session can still be mistaken for a new one.</p>
    <label>Search CLI commands and history
      <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
    </label>
    <ul className="repeater-cli-choices" aria-label="Available CLI commands">
      {choices.map((item) => <li key={item.command}>
        <button type="button" aria-pressed={selected === item.command} disabled={!ready || busy || pending}
          onClick={() => setSelected(item.command)}><code>{item.command}</code> — {item.description}</button>
      </li>)}
    </ul>
    {!choices.length && <p>No commands match.</p>}
    {selected === 'neighbors' && <p>Each reply line is a four-byte key prefix, seconds since heard, and SNR multiplied by 4, separated by colons.
      The list is limited by the repeater; prefixes may not uniquely identify a node. This does not show a map.</p>}
    <div className="contact-actions">
      <button type="button" disabled={!action || !ready || busy || pending || syncStatus.syncing} onClick={() => {
        if (action) void send(action.command, action.description, 'confirm' in action && action.confirm,
          'warning' in action ? action.warning : '')
      }}>
        {action ? `Send ${action.command}` : 'Select a command'}
      </button>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing} onClick={() => {
        setSyncRequested(true)
        void messageSync.sync()
      }}>Sync messages for replies</button>
      <button type="button" disabled={!history.length || pending} onClick={() => setHistory([])}>Clear CLI history</button>
    </div>
    <details>
      <summary>Change advertisement interval</summary>
      <p>Changing an interval affects future transmissions. Use 0 to disable. Local intervals are even minutes
        from 60 to 240; flood intervals are hours from 3 to 168.</p>
      <form className="contact-actions" onSubmit={submitInterval}>
        <label>Advertisement interval type
          <select value={intervalKind} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'advert.interval' || value === 'flood.advert.interval') setIntervalKind(value)
            }}>
            <option value="advert.interval">Local (minutes)</option>
            <option value="flood.advert.interval">Flood (hours)</option>
          </select>
        </label>
        <label>Interval value
          <input type="number" min="0" step="1" required value={interval}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setInterval(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set interval</button>
      </form>
    </details>
    <details>
      <summary>Change owner information</summary>
      <p>Replaces the current owner information. It can be requested over the mesh; do not include passwords or private data.
        Repeater firmware v1.12 or later is required. The field starts empty; use get owner.info to read the current value.
        Use line breaks instead of |, and leave blank to clear.</p>
      <form className="repeater-owner-form" onSubmit={submitOwnerInfo}>
        <label htmlFor={ownerInfoId}>Owner information</label>
        <textarea id={ownerInfoId} rows={4} value={ownerInfo} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setOwnerInfo(event.currentTarget.value)} />
        <p>Maximum 119 UTF-8 bytes, including line breaks.</p>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set owner information</button>
      </form>
    </details>
    <details>
      <summary>Change stored position</summary>
      <p>Advertisements use these stored coordinates only when the GPS advert policy is <code>prefs</code>.
        Policy <code>none</code> omits location; <code>share</code> uses sensor coordinates.
        Read the current values with <code>get lat</code> and <code>get lon</code>. Changing one coordinate does not change the other.</p>
      <p>Check the policy explicitly below. Some firmware builds do not support this query; an unsupported reply does not establish the policy.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('gps advert', 'Read GPS advert policy', false)}>Read GPS advert policy</button>
      <form className="repeater-position-form" onSubmit={(event) => submitPosition(event, 'lat', latitude)}>
        <label htmlFor={`${ownerInfoId}-latitude`}>Latitude (-90 to 90)</label>
        <input id={`${ownerInfoId}-latitude`} type="text" inputMode="decimal" required
          value={latitude} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setLatitude(event.currentTarget.value)} />
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set latitude</button>
      </form>
      <form className="repeater-position-form" onSubmit={(event) => submitPosition(event, 'lon', longitude)}>
        <label htmlFor={`${ownerInfoId}-longitude`}>Longitude (-180 to 180)</label>
        <input id={`${ownerInfoId}-longitude`} type="text" inputMode="decimal" required
          value={longitude} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setLongitude(event.currentTarget.value)} />
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set longitude</button>
      </form>
    </details>
    {pending && <p role="status">Sending to the radio…</p>}
    {syncRequested && syncStatus.error && <p role="alert">{syncStatus.error}</p>}
    {error && <p role="alert">{error}</p>}
    <h4>CLI history</h4>
    {!history.length ? <p>No commands sent in this view.</p> : !matchingHistory.length ? <p>No history matches.</p> :
      <ol className="repeater-cli-history">
        {[...matchingHistory].reverse().map((item) => <li key={item.tag}>
          <strong><code>{item.command}</code></strong>
          <span> · {item.unconfirmed ? 'Send unconfirmed' : `Accepted by radio (${item.route})`}</span>
          {item.reply !== null ? <pre>{item.reply || '(empty reply)'}</pre> :
            <p>{now >= item.deadline ? 'No reply synced before the deadline. It may still arrive.' :
              'Waiting for a reply. Sync messages to check.'}</p>}
        </li>)}
      </ol>}
  </details>
}
