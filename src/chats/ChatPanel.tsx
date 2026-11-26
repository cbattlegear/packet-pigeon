import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { DirectMessages, DirectStatus } from '../integration/direct-messages.ts'
import type { MessageSync } from '../integration/message-sync.ts'
import { ChannelObservations } from '../integration/channel-observations.ts'
import type { CapturedChannelObservation, ChannelObservationSource } from '../integration/channel-observations.ts'
import { clockFormatter } from '../preferences/appPreferences.ts'
import type { AppPreferences } from '../preferences/appPreferences.ts'
import type { CompanionSnapshot } from '../radio/companion-session.ts'
import { directTextBytes, maxDirectTextBytes } from '../radio/direct-message.ts'
import { channelTextBytes, channelTextLimit } from '../radio/channel-message.ts'
import { routeLabel } from '../radio/rx-packet.ts'
import { channelSender } from '../channels/senders.ts'
import { openRadioStorage, radioKeyFromPublicKey, validChannelScopeSettings } from '../storage/index.ts'
import type { DirectSendOptions, RadioData, RadioKey, StoredChannel, StoredContact, StoredMessage, StoredOutgoing } from '../storage/index.ts'
import type { Coordinates } from '../map/nodes.ts'
import { ComposerTools } from '../sharing/ComposerTools.tsx'
import { contactShareLink } from '../sharing/meshcoreLinks.ts'
import { conversations, correlateChannelObservations, matchingChannelReceipts, messageVisibility, oldestUnreadReceipt, receiptPathDescription, unreadReceipts } from './model.ts'
import type { Conversation } from './model.ts'
import { channelMentionNames, channelMessageBody, channelReply, channelTextParts, insertChannelMention, isSelfMention, mentionableName } from './mentions.ts'
import { PathDetails } from '../paths/PathDetails.tsx'
import type { MapPath, PathNode } from '../paths/model.ts'
import { contactPosition } from '../contacts/model.ts'
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
  readChannelKey?: (radioKey: RadioKey, channel: StoredChannel) => Promise<string>
  observationSource?: ChannelObservationSource
  pathNodes?: readonly PathNode[]
  mapPathNodes?: readonly PathNode[]
  onPathMap?: (path: MapPath) => void
  mapPosition?: Coordinates | null
  navigationRequest?: { key: RadioKey; id: string; sequence: number } | null
  onActiveConversation?: (key: RadioKey | null, id: string | null) => void
}

type ChatDisplay = {
  active: boolean
  preferences: AppPreferences
  read: ReadonlySet<string>
  formatTime: (date: Date) => string
  ownContact: string | null
  contacts: readonly StoredContact[]
  channels: readonly StoredChannel[]
  readChannelKey?: (channel: StoredChannel) => Promise<string>
  observationSource?: ChannelObservationSource
  canObserve: boolean
  regionNames: string[] | null
  pathNodes: readonly PathNode[]
  onPathMap?: (path: MapPath) => void
  mapPosition?: Coordinates | null
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The message action failed.'
}

export function ChatPanel({ snapshot, messageSync, messageStatus, direct, status, cacheSaving,
  active, preferences, locale, readChannelKey, observationSource, mapPosition, navigationRequest, onActiveConversation,
  pathNodes, mapPathNodes = [], onPathMap }: Props) {
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
  const regionNames = data?.channelScopes === undefined ? []
    : validChannelScopeSettings(data.channelScopes)
      ? data.channelScopes.flatMap((setting) => !setting.paused && setting.scope.mode === 'region' ? [setting.scope.name] : [])
      : null
  const ownContact = snapshot.device && last === radioKey
    ? contactShareLink(snapshot.device.name, snapshot.device.publicKey, snapshot.device.type) : null

  useEffect(() => {
    if (!navigationRequest) return
    setOfflineChoice(navigationRequest.key)
    setSelection({ key: navigationRequest.key, id: navigationRequest.id })
  }, [navigationRequest])

  useLayoutEffect(() => {
    onActiveConversation?.(active ? radioKey : null, active ? selected?.id ?? null : null)
    return () => onActiveConversation?.(null, null)
  }, [active, radioKey, selected?.id, onActiveConversation])

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
          senderName={snapshot.phase === 'ready' && snapshot.device?.publicKey === radioKey ? snapshot.device.name : null}
          display={{
            active, preferences, read, formatTime, mapPosition, ownContact,
            contacts: data.contacts, channels: live ? snapshot.channels : data.channels,
            readChannelKey: canSync && live && readChannelKey ? (channel) => readChannelKey(live, channel) : undefined,
            observationSource, canObserve: Boolean(live && canSync && snapshot.transport === 'usb'), regionNames,
            pathNodes: live && live === radioKey && pathNodes ? pathNodes : [
              ...data.contacts.map(({ publicKey, name, details }) => ({ publicKey, name, position: contactPosition(details) })),
              ...mapPathNodes,
            ], onPathMap,
          }} />
      )}
    </div>
  )
}

type WorkspaceProps = {
  radioKey: RadioKey
  data: RadioData
  direct: DirectMessages
  status: DirectStatus
  senderName: string | null
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
      {status.activeId && <p className="chat-active" role="status">A message is in progress.</p>}
    </nav>
  )
}

function ConversationPane({ radioKey, data, selected, direct, status, senderName, display }: WorkspaceProps & { selected?: Conversation }) {
  if (!selected) {
    return (
      <section className="conversation-pane" aria-label="Conversation">
        <div className="state-message"><h2>No conversations</h2><p>Sync contacts or channels to start a conversation.</p></div>
      </section>
    )
  }
  return <ConversationView key={`${radioKey}:${selected.id}`} conversation={selected}
    radioKey={radioKey} options={data.directSendOptions ?? defaultOptions} direct={direct} status={status}
    senderName={senderName} display={display} muted={data.mutedDirectConversations?.includes(selected.id.slice(0, 19)) ?? false} />
}

type ConversationProps = {
  conversation: Conversation
  radioKey: RadioKey
  muted: boolean
  options: DirectSendOptions
  direct: DirectMessages
  status: DirectStatus
  senderName: string | null
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

const idleObservation = { phase: 'idle' as const, error: null, dropped: 0, evicted: 0, entries: [] }
const noSubscription = () => () => {}
const noObservation = () => idleObservation

function ConversationView({ conversation, radioKey, options, direct, status, senderName, display, muted }: ConversationProps) {
  const { active, preferences, read, formatTime, ownContact, contacts, channels, readChannelKey, mapPosition,
    observationSource, canObserve, regionNames, pathNodes, onPathMap } = display
  const [draft, setDraft] = useState(() => direct.draft(radioKey, conversation.id))
  const [actionError, setActionError] = useState('')
  const [savingNotification, setSavingNotification] = useState(false)
  const [readError, setReadError] = useState('')
  const [hideRepeats, setHideRepeats] = useState(false)
  const [mentionName, setMentionName] = useState('')
  const composer = useRef<HTMLTextAreaElement>(null)
  const mentionPicker = useRef<HTMLDetailsElement>(null)
  const messageList = useRef<HTMLOListElement>(null)
  const positioned = useRef(false)
  const following = useRef(true)
  const { repeats, visible } = useMemo(
    () => messageVisibility(conversation.messages, hideRepeats), [conversation.messages, hideRepeats],
  )
  const channelMatches = useMemo(() => matchingChannelReceipts(conversation.messages), [conversation.messages])
  const channelIndex = conversation.channel?.index
  const observer = useMemo(() => observationSource && channelIndex !== undefined
    ? new ChannelObservations(observationSource) : null, [observationSource, channelIndex])
  const observed = useSyncExternalStore(observer?.subscribe ?? noSubscription, observer?.getSnapshot ?? noObservation,
    observer?.getSnapshot ?? noObservation)
  useEffect(() => () => observer?.stop(), [observer])
  const correlations = useMemo(() => correlateChannelObservations(
    conversation.channel?.index ?? -1, conversation.messages, observed.entries,
  ), [conversation.channel, conversation.messages, observed.entries])
  const unread = useMemo(() => unreadReceipts(visible, read), [visible, read])
  const bytes = new TextEncoder().encode(draft).length
  const isChannel = conversation.id.startsWith('channel:')
  const mentionNames = useMemo(() => conversation.channel
    ? channelMentionNames(contacts, conversation.messages, conversation.channel.index) : [],
  [contacts, conversation.channel, conversation.messages])
  const selectedMention = mentionNames.includes(mentionName) ? mentionName : ''
  let limit: number | null = isChannel ? null : maxDirectTextBytes
  let invalid = ''
  try {
    if (isChannel && senderName !== null) {
      limit = channelTextLimit(senderName)
      if (draft) channelTextBytes(draft, senderName)
    } else if (!isChannel && draft) directTextBytes(draft)
  } catch (error) {
    invalid = errorText(error)
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
    const text = draft
    setActionError('')
    try {
      const sent = conversation.channel
        ? await direct.sendChannel(radioKey, conversation.channel.index, conversation.channel.name, text, preferences.saveDrafts)
        : conversation.recipient
          ? await direct.send(radioKey, conversation.recipient, text, options, preferences.saveDrafts) : false
      if (sent) {
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

  async function copy(message: StoredMessage) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.')
      await navigator.clipboard.writeText(message.text)
      setActionError('')
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  async function remove(message: StoredMessage) {
    if (!window.confirm('Delete this message from this browser? It cannot be removed from the radio or other devices.')) return
    try {
      await direct.deleteChannelMessage(radioKey, message.id)
      setActionError('')
    } catch (error) { setActionError(errorText(error)) }
  }

  async function block(name: string) {
    if (!window.confirm(`Hide messages from the name "${name}" on this radio? Names are not verified and can be impersonated.`)) return
    try {
      await direct.blockChannelSender(radioKey, name)
      setActionError('')
    } catch (error) { setActionError(errorText(error)) }
  }

  function reply(name: string, body: string) {
    updateDraft(channelReply(name, body, draft))
    setActionError('')
    composer.current?.focus()
  }

  function insertMention() {
    if (!selectedMention) return
    const selectionStart = composer.current?.selectionStart ?? draft.length
    const selectionEnd = composer.current?.selectionEnd ?? selectionStart
    const result = insertChannelMention(draft, selectedMention, selectionStart, selectionEnd)
    updateDraft(result.text)
    setActionError('')
    if (mentionPicker.current) mentionPicker.current.open = false
    requestAnimationFrame(() => {
      composer.current?.focus()
      composer.current?.setSelectionRange(result.cursor, result.cursor)
    })
  }

  async function resend(message: StoredMessage) {
    if (!conversation.channel || !message.channelOutgoing
      || !window.confirm('Resend this message? The original may already have reached others. Live observations, when enabled, are best effort and do not confirm delivery.')) return
    await direct.sendChannel(radioKey, conversation.channel.index, conversation.channel.name, message.text, preferences.saveDrafts, true)
  }

  function updateDraft(text: string) {
    setDraft(text)
    void direct.saveDraft(radioKey, conversation.id, text, preferences.saveDrafts).catch(() => {})
  }

  function insertInDraft(text: string) {
    const next = draft ? `${draft}\n${text}` : text
    try {
      if (isChannel) channelTextBytes(next, senderName ?? '')
      else directTextBytes(next)
    } catch {
      return `The shared item and your draft must fit in ${limit ?? channelTextLimit('')} UTF-8 bytes${isChannel && senderName === null ? ' (connect to check the radio name)' : ''}. Shorten the draft or share the link separately.`
    }
    updateDraft(next)
    return null
  }

  return (
    <section className="conversation-pane" aria-label={`Conversation with ${conversation.title}`}>
      <div className="conversation-heading">
        <p>{conversation.title}</p>
        <span>{conversation.description}</span>
        {preferences.pathMetadata && conversation.messages.some(({ receipt }) => receipt &&
          receipt.pathLength !== 0xff && (receipt.pathLength & 63) > 0) &&
          <span>Saved receipts report hop count and hash width. For full paths, review live channel observations or packets captured in <a href="#diagnostics">Diagnostics</a>.</span>}
        {isChannel && <span>Radio acceptance does not confirm delivery. Live packet matches are best effort.</span>}
        {conversation.id.startsWith('direct:') && <label>Browser alerts
          <select aria-label={`Browser alerts for ${conversation.title}`} value={muted ? 'muted' : 'all'}
            disabled={savingNotification} onChange={(event) => {
              const muted = event.currentTarget.value === 'muted'
              setSavingNotification(true)
              void (async () => {
                try {
                  const storage = await openRadioStorage()
                  try { await storage.update(radioKey, { directNotification: { conversationId: conversation.id, muted } }) }
                  finally { storage.close() }
                  await direct.load(radioKey)
                  setActionError('')
                } catch (error) {
                  setActionError(errorText(error))
                } finally { setSavingNotification(false) }
              })()
            }}>
            <option value="all">All messages</option><option value="muted">Muted</option>
          </select>
        </label>}
        {conversation.id.startsWith('direct:') && <span>Mute applies to senders sharing this 12-character key prefix.</span>}
      </div>
      {isChannel && observer && <div className="chat-observation">
        <div className="chat-observation-actions">
          {observed.phase === 'active' || observed.phase === 'starting'
            ? <button type="button" onClick={() => observer.stop()}>Stop channel observation</button>
            : <button type="button" disabled={!canObserve || !conversation.channel || regionNames === null}
              onClick={() => {
                if (conversation.channel && regionNames) void observer.start(radioKey, conversation.channel, regionNames)
              }}>Observe channel packets</button>}
          <details><summary>About observation</summary>
            <p>USB only. Reads this channel key temporarily and captures up to 500 packets in this tab until stopped,
              disconnected or the conversation changes. Captures can miss packets; matches and region names are best effort.
              Region candidates use named sending scopes saved when observation starts. Restart after changing scopes;
              16-bit codes can collide and unknown regions cannot be identified.</p>
          </details>
        </div>
        {regionNames === null && <p role="alert">Saved channel scopes are invalid; reset them in Channels before observing.</p>}
        {observed.error && <p role="alert">{observed.error}</p>}
        {observed.phase === 'starting' && <p role="status">Starting channel observation…</p>}
        {observed.phase === 'active' && <p role="status">Observing channel packets.
          {observed.dropped > 0 && ` ${observed.dropped} packets were skipped while processing.`}
          {observed.evicted > 0 && ` ${observed.evicted} older channel observations were discarded.`}</p>}
      </div>}
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
          {visible.map((message) => {
            const sender = channelSender(message)
            const body = channelMessageBody(message)
            const matches = channelMatches.get(message.id)
            const correlation = correlations.get(message.id)
            return (
            <li key={message.id} data-receipt-id={message.id}
              className={message.outgoing || message.channelOutgoing ? 'chat-message--outgoing' : undefined}>
              <div className="chat-message-header">
                <strong>{message.outgoing || message.channelOutgoing ? 'You' : isChannel ? sender ?? 'Unknown sender' : conversation.title}</strong>
                {timestamp(message.timestamp, formatTime)}
              </div>
              {message.text && <p>{isChannel ? <ChannelMessageText text={body} ownName={senderName} /> : body}</p>}
              {message.receipt?.kind === 'channel-data' && <p>Channel data (type {message.receipt.dataType}): {message.receipt.dataHex}</p>}
              {message.conversationId === 'unsupported' && <p>Unrecognized response or device error; raw bytes are preserved below.</p>}
              {!message.text && !message.receipt && !message.rawHex && <p>Empty message</p>}
              {repeats.has(message.id) && <p className="chat-meta">Possible repeat; both receipts are kept.</p>}
              {matches && <details className="chat-meta">
                <summary>{matches.length} matching queued receipts (possible repeats)</summary>
                <p>Matching text and timestamps can belong to separate messages. The radio may not queue every heard copy;
                  this is not a delivery or complete repeat count.</p>
                {preferences.pathMetadata && <ul>{matches.map((match) => <li key={match.id}>
                  {match.receipt && <ReceiptPath receipt={match.receipt} />}
                </li>)}</ul>}
              </details>}
              {correlation && <RxObservationDetails correlation={correlation} outgoing={Boolean(message.channelOutgoing)}
                preferences={preferences} formatTime={formatTime} pathNodes={pathNodes} onPathMap={onPathMap} />}
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
              {message.channelOutgoing && (
                <div className="chat-delivery">
                  <strong className={message.channelOutgoing.status === 'uncertain' ? 'chat-failed' : undefined}>
                    {message.channelOutgoing.status === 'sending' ? 'Sending' : message.channelOutgoing.status === 'accepted'
                      ? 'Accepted by radio' : 'Send status uncertain'}
                  </strong>
                  {message.channelOutgoing.error && <p>{message.channelOutgoing.error}</p>}
                  {preferences.regionMetadata && message.channelOutgoing.scope && <p>
                    Requested sending scope: {message.channelOutgoing.scope.mode === 'region'
                      ? message.channelOutgoing.scope.name : message.channelOutgoing.scope.mode === 'unscoped'
                        ? 'Explicitly unscoped' : 'Radio default'}
                  </p>}
                  {message.channelOutgoing.status !== 'sending'
                    && conversation.channel?.name === message.channelOutgoing.channelName && (
                    <button type="button" disabled={status.activeId !== null || status.pending > 0}
                      aria-label={`Resend channel message: ${message.text.slice(0, 40)}`}
                      onClick={() => void resend(message)}>Resend</button>
                  )}
                </div>
              )}
              {isChannel && (
                <div className="chat-message-actions" role="group" aria-label="Channel message actions">
                  {message.text && <button type="button" onClick={() => void copy(message)}
                    aria-label={`Copy message: ${message.text.slice(0, 40)}`}>Copy</button>}
                  {conversation.channel && sender && (mentionableName(sender)
                    ? <button type="button" onClick={() => reply(sender, body)} aria-label={`Reply to ${sender}`}>Reply</button>
                    : <span className="chat-meta">Reply unavailable: the sender name contains a closing bracket (]).</span>)}
                  {sender && <button type="button" onClick={() => void block(sender)} aria-label={`Block sender name ${sender}`}>Block</button>}
                  <button type="button" disabled={message.channelOutgoing?.status === 'sending'}
                    aria-label={`Delete channel message: ${message.text.slice(0, 40)}`} onClick={() => void remove(message)}>Delete</button>
                </div>
              )}
              {message.rawHex && <details><summary>Raw receipt</summary><code>{message.rawHex}</code></details>}
            </li>
          )})}
        </ol>
      ) : <div className="state-message"><h2>No messages yet</h2><p>Messages in this conversation will appear here.</p></div>}
      {readError && <p className="chat-action-error" role="alert">{readError}</p>}
      {actionError && <p className="chat-action-error" role="alert">{actionError}</p>}
      {(conversation.recipient || conversation.channel) && (
        <form className="chat-composer" onSubmit={(event) => void send(event)}>
          <label htmlFor="chat-draft">Message</label>
          <textarea id="chat-draft" ref={composer} rows={3} value={draft} aria-describedby="chat-byte-count chat-draft-error"
            onChange={(event) => updateDraft(event.currentTarget.value)} />
          {isChannel && <details className="chat-mention-picker" ref={mentionPicker}>
            <summary>Mention a name</summary>
            <p>Mentions are plain text. Names are unverified and can be impersonated. Browser alerts depend on your notification settings.</p>
            {mentionNames.length ? <div className="chat-mention-choice">
              <label>Name to mention
                <select value={selectedMention} onChange={(event) => setMentionName(event.currentTarget.value)}>
                  <option value="">Select a name</option>
                  {mentionNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <button type="button" disabled={!selectedMention} onClick={insertMention}>Insert mention</button>
            </div> : <p>No mentionable chat contacts or observed senders are available. You can type <code>@[name]</code> directly.</p>}
          </details>}
          <div className="chat-compose-actions">
            <span id="chat-byte-count">{limit === null ? `${bytes} UTF-8 bytes; connect to check the limit` : `${bytes}/${limit} UTF-8 bytes`}</span>
            {active && <ComposerTools ownContact={ownContact} contacts={contacts} channels={channels}
              readChannelKey={readChannelKey} mapPosition={mapPosition} insert={insertInDraft} />}
            <button type="submit" disabled={!draft || Boolean(invalid) || status.activeId !== null}>Send message</button>
          </div>
          <p id="chat-draft-error" className="chat-action-error">{invalid}</p>
          <p>{isChannel
            ? 'The radio adds its sender name. Sending scope is configured in Channels. A channel message is a broadcast and cannot be recalled.'
            : 'Flood fallback clears this contact’s saved radio route. Sent packets cannot be recalled.'}</p>
        </form>
      )}
      {conversation.recipient && <RetrySettings key={radioKey} radioKey={radioKey} current={options} direct={direct} />}
    </section>
  )
}

function ChannelMessageText({ text, ownName }: { text: string; ownName: string | null }) {
  return channelTextParts(text).map((part, index) => {
    if (part.kind === 'text') return part.text
    const self = isSelfMention(part.name, ownName)
    return <span key={index} className={self ? 'chat-mention chat-mention--self' : 'chat-mention'}
      title={self ? 'Matches this radio name; names are not verified.' : 'Mention uses an unverified name.'}>
      @[{part.name}]
    </span>
  })
}

function RxObservationDetails({ correlation, outgoing, preferences, formatTime, pathNodes, onPathMap }: {
  correlation: { entries: CapturedChannelObservation[]; matchingMessages: number }
  outgoing: boolean; preferences: AppPreferences; formatTime: ChatDisplay['formatTime']
  pathNodes: readonly PathNode[]; onPathMap?: (path: MapPath) => void
}) {
  const [open, setOpen] = useState(false)
  return <details className="chat-meta" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{correlation.entries.length} matching RX observation{correlation.entries.length === 1 ? '' : 's'} (possible repeats)</summary>
    {open && <>
      <p>Matched by channel key, timestamp, type and exact text. Packets may be missed or distinct messages
        may match; short hashes and authentication codes can collide. This does not confirm delivery.</p>
      {correlation.matchingMessages > 1 && <p>These observations match {correlation.matchingMessages} saved
        messages and cannot be assigned uniquely.</p>}
      {correlation.matchingMessages === 1 && <p>{outgoing
        ? `${correlation.entries.length} possible echo${correlation.entries.length === 1 ? '' : 'es'}.`
        : `${correlation.entries.length - 1} additional match${correlation.entries.length === 2 ? '' : 'es'} beyond the first; the original may not have been captured.`}</p>}
      <ul className="chat-observed-paths">{correlation.entries.map((entry) => <li key={entry.id}>
        <time dateTime={new Date(entry.receivedAt).toISOString()}>{formatTime(new Date(entry.receivedAt))}</time>
        {preferences.pathMetadata && <> · {routeLabel({ routeCode: entry.routeCode, typeCode: 5, version: 1 })}
          {' · '}{entry.pathHashes.length} {entry.routeCode >= 2 ? 'remaining' : 'traversed'} hop{entry.pathHashes.length === 1 ? '' : 's'}
          {entry.pathHashes.length > 0 && <> · {entry.hashWidth}-byte hashes</>}
          {entry.snrDb !== null && <> · SNR {entry.snrDb} dB</>}
          {entry.rssiDbm !== null && <> · RSSI {entry.rssiDbm} dBm</>}
        </>}
        {preferences.regionMetadata && <> · {entry.region.kind === 'candidates'
          ? `Possible regions: ${entry.region.names.join(', ')}`
          : entry.region.kind === 'unscoped' ? 'Unscoped transport code' : 'Region unknown'}</>}
        {preferences.pathMetadata && entry.pathHashes.length > 0 && entry.hashWidth !== null &&
          <PathDetails title="Observed channel path" width={entry.hashWidth} hashes={entry.pathHashes} nodes={pathNodes} onMap={onPathMap} />}
      </li>)}</ul>
    </>}
  </details>
}

function ReceiptPath({ receipt }: { receipt: NonNullable<StoredMessage['receipt']> }) {
  return <p className="chat-meta">
    {receiptPathDescription(receipt.pathLength)}
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
