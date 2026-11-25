import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { DirectMessages, DirectStatus } from '../integration/direct-messages.ts'
import type { MessageSync } from '../integration/message-sync.ts'
import { clockFormatter } from '../preferences/appPreferences.ts'
import type { AppPreferences } from '../preferences/appPreferences.ts'
import type { CompanionSnapshot } from '../radio/companion-session.ts'
import { directTextBytes, maxDirectTextBytes } from '../radio/direct-message.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { DirectSendOptions, RadioData, RadioKey, StoredMessage, StoredOutgoing } from '../storage/index.ts'
import { conversations, messageVisibility, oldestUnreadReceipt, unreadReceipts } from './model.ts'
import type { Conversation } from './model.ts'
import './chats.css'

const defaultOptions: DirectSendOptions = { directAttempts: 4, floodAttempts: 4 }

type Props = {
  snapshot: CompanionSnapshot
  messageSync: MessageSync
  messageStatus: ReturnType<MessageSync['getSnapshot']>
  direct: DirectMessages
  status: DirectStatus
  cacheSaving: boolean
  active: boolean
  preferences: AppPreferences
  locale: string
}

type ChatDisplay = {
  active: boolean
  preferences: AppPreferences
  read: ReadonlySet<string>
  formatTime: (date: Date) => string
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The message action failed.'
}

export function ChatPanel({ snapshot, messageSync, messageStatus, direct, status, cacheSaving, active, preferences, locale }: Props) {
  const live = (snapshot.phase === 'ready' || snapshot.phase === 'syncing') && snapshot.device
    ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const last = snapshot.device ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const [offlineChoice, setOfflineChoice] = useState<RadioKey | '' | null>(null)
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState<{ key: RadioKey; id: string } | null>(null)
  const radioKey = live ?? (offlineChoice === null ? last : offlineChoice || null)
  const data = status.key === radioKey ? status.data : null
  const canSync = snapshot.phase === 'ready'
  const items = useMemo(() => data ? conversations(data) : [], [data])
  const read = useMemo(() => new Set(data?.readMessages), [data?.readMessages])
  const formatTime = useMemo(() => clockFormatter(locale, preferences.clock).format, [locale, preferences.clock])
  const preferred = selection?.key === radioKey ? selection.id : data?.preferences?.selectedConversationId
  const selected = items.find((item) => item.id === preferred) ?? items[0]

  useEffect(() => {
    let active = true
    async function readKeys() {
      try {
        const storage = await openRadioStorage()
        try {
          const saved = await storage.listRadioKeys()
          if (active) {
            setKeys(saved)
            setLoadError('')
          }
        } finally {
          storage.close()
        }
      } catch (error) {
        if (active) setLoadError(errorText(error))
      }
    }
    void readKeys()
    return () => { active = false }
  }, [live, cacheSaving, messageStatus.syncing])

  useEffect(() => {
    if (radioKey) void direct.load(radioKey)
  }, [radioKey, direct, cacheSaving, messageStatus.syncing])

  return (
    <div className="chats-layout chat-workspace">
      <section className="conversation-list" aria-labelledby="chats-heading">
        <div className="pane-heading">
          <h1 id="chats-heading">Chats</h1>
          <p>Direct messages and received entries</p>
        </div>
        <div className="message-controls">
          {live ? <p>Radio <code>{live.slice(0, 12)}…</code></p> : (
            <label className="chat-radio">Cached radio
              <select value={radioKey ?? ''} onChange={(event) => {
                setOfflineChoice(keys.find((key) => key === event.currentTarget.value) ?? '')
              }}>
                <option value="">Select a saved radio</option>
                {keys.map((key) => <option key={key} value={key}>{key}</option>)}
              </select>
            </label>
          )}
          {loadError && <p role="alert">{loadError}</p>}
          <button type="button" onClick={() => void messageSync.sync()}
            disabled={messageStatus.syncing || (!canSync && !messageStatus.pending)}>
            {messageStatus.syncing ? 'Syncing messages…' : messageStatus.pending
              ? canSync ? 'Retry saving and sync' : 'Retry saving' : 'Sync messages'}
          </button>
          <p>Receipts are saved before requesting the next. Interruptions can still lose a message.</p>
          {snapshot.transport === 'bluetooth' && (
            <p>Bluetooth may truncate or drop messages; incomplete text can look complete. The radio removes each
              message from its queue before replying, so missing content cannot be recovered from the radio. Use USB
              for safer sync.</p>
          )}
        </div>
        {radioKey && data && (
          <ConversationList items={items} selectedId={selected?.id} status={status} read={read}
            showPreviews={preferences.chatPreviews}
            onSelect={(id) => setSelection({ key: radioKey, id })} />
        )}
      </section>
      {!radioKey ? (
        <section className="conversation-pane" aria-label="Conversation">
          <div className="state-message">
            <h2>Select a radio</h2>
            <p>Connect a radio or select a saved radio to browse chats.</p>
          </div>
        </section>
      ) : !data ? (
        <section className="conversation-pane" aria-label="Conversation">
          <div className="state-message" role="status"><h2>Loading cached chats</h2></div>
        </section>
      ) : (
        <ConversationPane radioKey={radioKey} data={data} selected={selected} direct={direct} status={status}
          display={{ active, preferences, read, formatTime }} />
      )}
    </div>
  )
}

type WorkspaceProps = {
  radioKey: RadioKey
  data: RadioData
  direct: DirectMessages
  status: DirectStatus
  display: ChatDisplay
}

function ConversationList({ items, selectedId, status, read, showPreviews, onSelect }: {
  items: Conversation[]
  selectedId?: string
  status: DirectStatus
  read: ReadonlySet<string>
  showPreviews: boolean
  onSelect: (id: string) => void
}) {
  return (
    <nav aria-label="Conversations">
      {items.length ? (
        <ul className="chat-conversation-list">
          {items.map((item) => {
            const last = item.messages.at(-1)
            const unread = unreadReceipts(item.messages, read).length
            return (
              <li key={item.id}>
                <button type="button" aria-current={selectedId === item.id ? 'page' : undefined}
                  onClick={() => onSelect(item.id)}>
                  <strong>{item.title}</strong>
                  {unread > 0 && <small>{unread} unread</small>}
                  {showPreviews && <span>{last?.text || (last ? 'Received entry' : 'No messages yet')}</span>}
                  {showPreviews && last?.outgoing && <small>{deliveryLabel(last.outgoing)}</small>}
                </button>
              </li>
            )
          })}
        </ul>
      ) : <p className="chat-empty-list">Sync contacts or messages to start a conversation.</p>}
      {status.activeId && <p className="chat-active" role="status">A direct message is in progress.</p>}
    </nav>
  )
}

function ConversationPane({ radioKey, data, selected, direct, status, display }: WorkspaceProps & { selected?: Conversation }) {
  if (!selected) {
    return (
      <section className="conversation-pane" aria-label="Conversation">
        <div className="state-message"><h2>No conversations</h2><p>Sync contacts to send a direct message.</p></div>
      </section>
    )
  }
  return <ConversationView key={`${radioKey}:${selected.id}`} conversation={selected}
    radioKey={radioKey} options={data.directSendOptions ?? defaultOptions} direct={direct} status={status} display={display} />
}

type ConversationProps = {
  conversation: Conversation
  radioKey: RadioKey
  options: DirectSendOptions
  direct: DirectMessages
  status: DirectStatus
  display: ChatDisplay
}

function deliveryLabel(outgoing: StoredOutgoing) {
  const total = outgoing.options.directAttempts + outgoing.options.floodAttempts
  const progress = outgoing.attempt ? ` ${outgoing.attempt}/${total}` : ''
  if (outgoing.status === 'delivered') return 'Delivered'
  if (outgoing.status === 'failed') return `Failed${progress}`
  if (outgoing.status === 'sent') return `Sent${progress}`
  return `Sending${progress}`
}

function timestamp(value: number | null, format: ChatDisplay['formatTime']) {
  if (value === null || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return null
  const date = new Date(value)
  return <time dateTime={date.toISOString()}>{format(date)}</time>
}

function ConversationView({ conversation, radioKey, options, direct, status, display }: ConversationProps) {
  const { active, preferences, read, formatTime } = display
  const [draft, setDraft] = useState(() => direct.draft(radioKey, conversation.id))
  const [actionError, setActionError] = useState('')
  const [readError, setReadError] = useState('')
  const [hideRepeats, setHideRepeats] = useState(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const messageList = useRef<HTMLOListElement>(null)
  const positioned = useRef(false)
  const following = useRef(true)
  const { repeats, visible } = useMemo(
    () => messageVisibility(conversation.messages, hideRepeats), [conversation.messages, hideRepeats],
  )
  const unread = useMemo(() => unreadReceipts(visible, read), [visible, read])
  const bytes = new TextEncoder().encode(draft).length
  let invalid = ''
  if (draft) {
    try { directTextBytes(draft) } catch (error) { invalid = errorText(error) }
  }

  useLayoutEffect(() => {
    if (!active) {
      positioned.current = false
      return
    }
    const list = messageList.current
    if (!list) return
    if (!positioned.current) {
      positioned.current = true
      const oldest = preferences.oldestUnread ? oldestUnreadReceipt(unread) : undefined
      const row = oldest && Array.from(list.children).find(
        (element) => (element as HTMLElement).dataset.receiptId === oldest.id,
      )
      if (row) {
        if (list.scrollHeight > list.clientHeight) {
          list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top
        } else if (row.getBoundingClientRect().bottom > window.innerHeight) {
          row.scrollIntoView({ block: 'start' })
        }
        following.current = false
      }
    }
    if (following.current) list.scrollTop = list.scrollHeight
  }, [active, visible, unread, preferences.oldestUnread])

  useLayoutEffect(() => {
    if (active && preferences.composerAutofocus) composer.current?.focus({ preventScroll: true })
  }, [active, preferences.composerAutofocus])

  useEffect(() => {
    const list = messageList.current
    if (!active || !unread.length || !list) return
    const ids = new Set(unread.map((message) => message.id))
    const observer = new IntersectionObserver((entries) => {
      if (document.hidden) return
      const seen: string[] = []
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.receiptId
        if (entry.intersectionRatio >= 0.01 && id && ids.delete(id)) {
          observer.unobserve(entry.target)
          seen.push(id)
        }
      }
      if (seen.length) void direct.markRead(radioKey, seen).then(() => setReadError(''), () => {
        setReadError('Could not save the read status.')
      })
    }, { threshold: 0.01 })
    function observeVisibleTab() {
      observer.disconnect()
      if (document.hidden || !list) return
      for (const row of list.children) {
        const id = (row as HTMLElement).dataset.receiptId
        if (id && ids.has(id)) observer.observe(row)
      }
    }
    observeVisibleTab()
    document.addEventListener('visibilitychange', observeVisibleTab)
    return () => {
      document.removeEventListener('visibilitychange', observeVisibleTab)
      observer.disconnect()
    }
  }, [active, direct, radioKey, unread])

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!conversation.recipient) return
    const text = draft
    setActionError('')
    try {
      if (await direct.send(radioKey, conversation.recipient, text, options, preferences.saveDrafts)) {
        setDraft((current) => current === text ? '' : current)
      }
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  async function retry(message: StoredMessage) {
    setActionError('')
    try {
      await direct.retry(radioKey, message.id, options)
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  return (
    <section className="conversation-pane" aria-label={`Conversation with ${conversation.title}`}>
      <div className="conversation-heading">
        <p>{conversation.title}</p>
        <span>{conversation.description}</span>
      </div>
      {repeats.size > 0 && (
        <label className="chat-repeat-filter">
          <input type="checkbox" checked={hideRepeats} onChange={(event) => setHideRepeats(event.currentTarget.checked)} />
          <span>Hide {repeats.size} possible repeat{repeats.size === 1 ? '' : 's'}.
            These may be distinct messages; all receipts are kept.</span>
        </label>
      )}
      {conversation.messages.length ? (
        <ol className="received-messages chat-message-list" ref={messageList} onScroll={(event) => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}>
          {visible.map((message) => (
            <li key={message.id} data-receipt-id={message.id}
              className={message.outgoing ? 'chat-message--outgoing' : undefined}>
              <div className="chat-message-header">
                <strong>{message.outgoing ? 'You' : conversation.title}</strong>
                {timestamp(message.timestamp, formatTime)}
              </div>
              {message.text && <p>{message.text}</p>}
              {message.receipt?.kind === 'channel-data' && <p>Channel data (type {message.receipt.dataType}): {message.receipt.dataHex}</p>}
              {message.conversationId === 'unsupported' && <p>Unrecognized response or device error; raw bytes are preserved below.</p>}
              {!message.text && !message.receipt && !message.rawHex && <p>Empty message</p>}
              {repeats.has(message.id) && <p className="chat-meta">Possible repeat; both receipts are kept.</p>}
              {preferences.pathMetadata && message.receipt && <ReceiptPath receipt={message.receipt} />}
              {preferences.regionMetadata && message.region && <p className="chat-meta">Region {message.region}</p>}
              {message.outgoing && (
                <div className="chat-delivery">
                  <strong className={message.outgoing.status === 'failed' ? 'chat-failed' : undefined}>
                    {deliveryLabel(message.outgoing)}
                  </strong>
                  {preferences.pathMetadata && message.outgoing.attempt > 0 && message.outgoing.status !== 'delivered' && (
                    <span>{message.outgoing.route
                      ? message.outgoing.route === 'direct' ? 'Direct' : 'Flood'
                      : message.outgoing.attempt <= message.outgoing.options.directAttempts ? 'Direct phase' : 'Flood phase'}</span>
                  )}
                  {message.outgoing.error && <p>{message.outgoing.error}</p>}
                  {message.outgoing.status === 'failed' && (
                    <button type="button" disabled={status.activeId !== null || status.pending > 0}
                      aria-label={`Retry message: ${message.text.slice(0, 40)}`} onClick={() => void retry(message)}>Retry</button>
                  )}
                  {status.activeId === message.id && (
                    <button type="button" disabled={status.cancelling} onClick={direct.cancel}>
                      {status.cancelling ? 'Cancelling…' : 'Cancel sending'}
                    </button>
                  )}
                </div>
              )}
              {message.rawHex && <details><summary>Raw receipt</summary><code>{message.rawHex}</code></details>}
            </li>
          ))}
        </ol>
      ) : <div className="state-message"><h2>No messages yet</h2><p>Messages in this conversation will appear here.</p></div>}
      {readError && <p className="chat-action-error" role="alert">{readError}</p>}
      {actionError && <p className="chat-action-error" role="alert">{actionError}</p>}
      {conversation.recipient && (
        <form className="chat-composer" onSubmit={(event) => void send(event)}>
          <label htmlFor="chat-draft">Message</label>
          <textarea id="chat-draft" ref={composer} rows={3} value={draft} aria-describedby="chat-byte-count chat-draft-error"
            onChange={(event) => {
              const text = event.currentTarget.value
              setDraft(text)
              void direct.saveDraft(radioKey, conversation.id, text, preferences.saveDrafts).catch(() => {})
            }} />
          <div className="chat-compose-actions">
            <span id="chat-byte-count">{bytes}/{maxDirectTextBytes} UTF-8 bytes</span>
            <button type="submit" disabled={!draft || Boolean(invalid) || status.activeId !== null}>Send message</button>
          </div>
          <p id="chat-draft-error" className="chat-action-error">{invalid}</p>
          <p>Flood fallback clears this contact’s saved radio route. Sent packets cannot be recalled.</p>
        </form>
      )}
      {conversation.recipient && <RetrySettings key={radioKey} radioKey={radioKey} current={options} direct={direct} />}
    </section>
  )
}

function ReceiptPath({ receipt }: { receipt: NonNullable<StoredMessage['receipt']> }) {
  const hops = receipt.pathLength & 63
  return <p className="chat-meta">
    {receipt.pathLength === 0xff ? 'Direct receipt' : `${hops} path hop${hops === 1 ? '' : 's'}`}
    {receipt.snrDb !== null && ` · SNR ${receipt.snrDb} dB`}
  </p>
}

function RetrySettings({ radioKey, current, direct }: { radioKey: RadioKey; current: DirectSendOptions; direct: DirectMessages }) {
  const [directAttempts, setDirectAttempts] = useState(String(current.directAttempts))
  const [floodAttempts, setFloodAttempts] = useState(String(current.floodAttempts))
  const [message, setMessage] = useState('')
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await direct.saveOptions(radioKey, {
        directAttempts: Number(directAttempts), floodAttempts: Number(floodAttempts),
      })
      setMessage('Retry settings saved.')
    } catch (error) {
      setMessage(errorText(error))
    }
  }
  return (
    <details className="chat-retry-settings">
      <summary>Retry settings</summary>
      <form onSubmit={(event) => void save(event)}>
        <label>Direct attempts
          <input type="number" min="0" max="8" required value={directAttempts}
            onChange={(event) => setDirectAttempts(event.currentTarget.value)} />
        </label>
        <label>Flood attempts
          <input type="number" min="0" max="8" required value={floodAttempts}
            onChange={(event) => setFloodAttempts(event.currentTarget.value)} />
        </label>
        <button type="submit">Save settings</button>
      </form>
      <p>Choose 1–8 attempts in total. The radio may flood earlier if no route is saved.</p>
      {message && <p role="status">{message}</p>}
    </details>
  )
}
