import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MessageSync } from '../integration/message-sync.ts'
import type { CompanionSession } from '../radio/companion-session.ts'
import { repeaterCliCommands, UncertainRepeaterCliError } from '../radio/repeater-cli.ts'
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
  tag: string
  route: RepeaterCliReceipt['route'] | null
  deadline: number
  reply: string | null
  unconfirmed: boolean
}

export function RepeaterCli({ session, messageSync, radioKey, contactKey, name, route, ready, busy, onPending }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState(false)
  const [syncRequested, setSyncRequested] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const syncStatus = useSyncExternalStore(messageSync.subscribe, messageSync.getSnapshot)
  const term = query.trim().toLowerCase()
  const choices = repeaterCliCommands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(term))
  const matchingHistory = history.filter((item) => {
    const description = repeaterCliCommands.find((choice) => choice.command === item.command)?.description ?? ''
    return `${item.command} ${description} ${item.reply ?? ''}`.toLowerCase().includes(term)
  })
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

  async function send() {
    if (!action || !ready || busy || pending || syncStatus.syncing) return
    const confirmed = 'confirm' in action && action.confirm
    if (confirmed && !window.confirm(`${action.description} from ${name}? This will transmit over the mesh.`)) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    onPending(true)
    setError('')
    try {
      const result = await session.sendRepeaterCommand(radioKey, contactKey, route, action.command, confirmed, controller.signal)
      const sentAt = Date.now()
      setNow(sentAt)
      setHistory((current) => [...current.slice(-99), {
        command: action.command, tag: result.tag, route: result.route, deadline: sentAt + result.timeoutMs,
        reply: null, unconfirmed: false,
      }])
    } catch (reason) {
      if (reason instanceof UncertainRepeaterCliError) {
        const sentAt = Date.now()
        setNow(sentAt)
        setHistory((current) => [...current.slice(-99), {
          command: action.command, tag: reason.tag, route: null, deadline: sentAt + 120_000,
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

  return <details>
    <summary>Administrator CLI</summary>
    <p>Choose a supported query or advertisement. Commands are never retried automatically.
      Replies are saved with other messages when you sync; history here lasts while this repeater stays selected.</p>
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
    <div className="contact-actions">
      <button type="button" disabled={!action || !ready || busy || pending || syncStatus.syncing} onClick={() => void send()}>
        {action ? `Send ${action.command}` : 'Select a command'}
      </button>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing} onClick={() => {
        setSyncRequested(true)
        void messageSync.sync()
      }}>Sync messages for replies</button>
      <button type="button" disabled={!history.length || pending} onClick={() => setHistory([])}>Clear CLI history</button>
    </div>
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
