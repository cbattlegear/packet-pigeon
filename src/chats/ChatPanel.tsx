import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
import { ShareModal } from '../sharing/ShareDialogs.tsx'
import { contactShareLink } from '../sharing/meshcoreLinks.ts'
import { conversations, correlateChannelObservations, matchingChannelReceipts, messageDay, messageVisibility, nodeMessageSender, oldestUnreadReceipt, receiptHopCount, receiptPathDescription, searchMessages, unreadReceipts } from './model.ts'
import type { Conversation } from './model.ts'
import { ChatSearch } from './ChatSearch.tsx'
import type { NamedRegion } from '../radio/channel-scope.ts'
import { framedTransport } from '../radio/transport.ts'
import { channelMentionNames, channelMessageBody, channelReply, channelTextParts, insertChannelMention, isSelfMention, mentionableName } from './mentions.ts'
import type { ChannelTextPart } from './mentions.ts'
import { PathDetails } from '../paths/PathDetails.tsx'
import type { MapPath, PathNode } from '../paths/model.ts'
import { contactPosition } from '../contacts/model.ts'
import type { RemoteNodeLoginSession } from '../contacts/RemoteNodePanel.tsx'
import { canPostToRoom, maxRoomTextBytes } from '../radio/node-access.ts'
import { imageLinkParts } from './image-links.ts'
import type { ImageLinkPart } from './image-links.ts'
import { canReactTo } from './reactions.ts'
import { reactionEmojiSupport } from '../radio/reactions.ts'
import { ReactionPicker } from './ReactionPicker.tsx'
import './chats.css'

const defaultOptions: DirectSendOptions = { directAttempts: 4, floodAttempts: 4 }
const RemoteNodeLogin = lazy(async () => ({ default: (await import('../contacts/RemoteNodePanel.tsx')).RemoteNodeLogin }))

type SearchTarget = { id: string }

type MessageContext = { id: string; trigger: HTMLElement; point?: { x: number; y: number }; channel: boolean }

type Props = {
  snapshot: CompanionSnapshot
  messageSync: MessageSync
  messageStatus: ReturnType<MessageSync['getSnapshot']>
  direct: DirectMessages
  status: DirectStatus
  cacheSaving: boolean
  nodeSession: RemoteNodeLoginSession
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
  formatClock: (date: Date) => string
  formatDate: (date: Date) => string
  ownContact: string | null
  contacts: readonly StoredContact[]
  channels: readonly StoredChannel[]
  readChannelKey?: (channel: StoredChannel) => Promise<string>
  observationSource?: ChannelObservationSource
  canObserve: boolean
  nodeSession: RemoteNodeLoginSession
  nodeReady: boolean
  nodeBusy: boolean
  regionNames: NamedRegion[] | null
  pathNodes: readonly PathNode[]
  onPathMap?: (path: MapPath) => void
  mapPosition?: Coordinates | null
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The message action failed.'
}

function MessageContextActions({ context, onClose, children }: {
  context: MessageContext
  onClose: () => void
  children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const place = () => {
      const bounds = element.getBoundingClientRect()
      const anchor = context.trigger.getBoundingClientRect()
      const x = context.point?.x ?? anchor.right - bounds.width
      let y = context.point?.y ?? anchor.bottom + 4
      if (!context.point && y + bounds.height > window.innerHeight) y = anchor.top - bounds.height - 4
      element.style.left = `${Math.max(0, Math.min(x, window.innerWidth - bounds.width))}px`
      element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - bounds.height))}px`
    }
    place()
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    if (context.point) return
    window.addEventListener('scroll', place, true)
    return () => window.removeEventListener('scroll', place, true)
  }, [context])
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (!context.point && context.trigger.contains(event.target as Node)) return
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        context.trigger.focus({ preventScroll: true })
        onClose()
      }
    }
    function scroll(event: Event) {
      if (context.point && !menu.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', keydown)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [context, onClose])
  return createPortal(<div ref={menu} className="chat-context-actions" role="group"
    aria-label={context.channel ? 'Channel message context actions' : 'Message actions'}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget) && (context.point || event.relatedTarget !== context.trigger)) onClose()
    }}>
    {children}
  </div>, document.body)
}

export function ChatPanel({ snapshot, messageSync, messageStatus, direct, status, cacheSaving, nodeSession,
  active, preferences, locale, readChannelKey, observationSource, mapPosition, navigationRequest, onActiveConversation,
  pathNodes, mapPathNodes = [], onPathMap }: Props) {
  const live = (snapshot.phase === 'ready' || snapshot.phase === 'syncing') && snapshot.device
    ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const last = snapshot.device ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const [offlineChoice, setOfflineChoice] = useState<RadioKey | '' | null>(null)
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState<{ key: RadioKey; id: string; searchTarget?: SearchTarget } | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const radioKey = live ?? (offlineChoice === null ? last : offlineChoice || null)
  const data = status.key === radioKey ? status.data : null
  const cacheLoad = status.key === radioKey ? status.cacheLoad : null
  const canSync = snapshot.phase === 'ready'
  const items = useMemo(() => data && status.key ? conversations(data, direct.inMemoryDraftIds(status.key)) : [],
    [data, direct, status])
  const read = useMemo(() => new Set(data?.readMessages), [data?.readMessages])
  const formatTime = useMemo(() => clockFormatter(locale, preferences.clock).format, [locale, preferences.clock])
  const formatClock = useMemo(() => clockFormatter(locale, preferences.clock, false).format, [locale, preferences.clock])
  const formatDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format, [locale])
  const radioSelection = selection?.key === radioKey ? selection : null
  const preferred = radioSelection?.id ?? data?.preferences?.selectedConversationId
  const selected = items.find((item) => item.id === preferred) ?? items[0]
  const searchTarget = radioSelection?.id === selected?.id ? radioSelection?.searchTarget : undefined
  const regionNames: NamedRegion[] | null = data?.channelScopes !== undefined && !validChannelScopeSettings(data.channelScopes)
    ? null : [
      ...(data?.channelScopes ?? []).flatMap((setting) => !setting.paused && setting.scope.mode === 'region' ? [setting.scope] : []),
      ...(data?.regionTransportKeys ?? []).map(({ name, key }) => ({ mode: 'region' as const, name, key })),
    ]
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
  }, [active, live, cacheSaving, messageStatus.syncing])

  useEffect(() => {
    if (radioKey) void direct.load(radioKey)
  }, [radioKey, direct, cacheSaving, messageStatus.syncing])

  return (
    <div className="chats-layout chat-workspace">
      <section className="conversation-list" aria-labelledby="chats-heading">
        <div className="pane-heading">
          <h1 id="chats-heading">Chats</h1>
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
          {snapshot.transport === 'bluetooth' && (
            <details className="chat-sync-limits"><summary>Bluetooth sync limits</summary>
              <p>Bluetooth may truncate or drop messages. The radio removes each message from its queue before replying, so
                missing content cannot be recovered from the radio. Use USB or the local network for safer sync.</p>
            </details>
          )}
        </div>
        {radioKey && data && <>
          <ChatSearch key={radioKey} items={items} onOpen={(id, messageId) => {
            setSelection({ key: radioKey, id, searchTarget: { id: messageId } })
          }} />
          <ConversationList items={items} selectedId={selected?.id} status={status} read={read} unreadOnly={unreadOnly}
            showPreviews={preferences.chatPreviews}
            onUnreadOnlyChange={setUnreadOnly}
            onSelect={(id) => setSelection({ key: radioKey, id })}
            onNewChat={(id) => { setUnreadOnly(false); setSelection({ key: radioKey, id }) }} />
        </>}
      </section>
      {!radioKey ? (
        <section className="conversation-pane" aria-label="Conversation">
          <div className="state-message">
            <h2>Select a radio</h2>
            <p>Connect a radio or select a saved radio to browse chats.</p>
          </div>
        </section>
      ) : cacheLoad?.state === 'error' && !data ? (
        <section className="conversation-pane" aria-label="Conversation">
          <div className="state-message" role="alert">
            <h2>Could not load cached chats</h2>
            <p>{cacheLoad.message}</p>
            <button type="button" onClick={() => void direct.load(radioKey)}>Retry loading chats</button>
          </div>
        </section>
      ) : !data && cacheLoad?.state === 'ready' ? (
        <section className="conversation-pane" aria-label="Conversation">
          <div className="state-message"><h2>No cached chats</h2><p>No cache is available for this radio.</p></div>
        </section>
      ) : !data ? (
        <section className="conversation-pane" aria-label="Conversation">
          <div className="state-message" role="status"><h2>Loading cached chats</h2></div>
        </section>
      ) : (
        <div className="chat-pane-container">
          {cacheLoad?.state === 'error' && <div className="chat-cache-error" role="alert">
            <p>Could not refresh cached chats: {cacheLoad.message} Showing previously loaded data.</p>
            <button type="button" onClick={() => void direct.load(radioKey)}>Retry loading chats</button>
          </div>}
          {data.reactionError && <p className="chat-cache-error" role="alert">{data.reactionError}</p>}
          {!reactionEmojiSupport && <p className="chat-cache-error" role="alert">
            This browser cannot segment emoji. Native and channel reaction recognition and sending are unavailable; wire text is preserved.
          </p>}
          <ConversationPane radioKey={radioKey} data={data} selected={selected} direct={direct} status={status} searchTarget={searchTarget}
            senderName={snapshot.phase === 'ready' && snapshot.device?.publicKey === radioKey ? snapshot.device.name : null}
            display={{
              active, preferences, read, formatTime, formatClock, formatDate, mapPosition, ownContact,
              nodeSession, nodeReady: Boolean(live && live === radioKey && canSync),
              nodeBusy: cacheSaving || messageStatus.syncing || messageStatus.pending || status.activeId !== null,
              contacts: data.contacts, channels: live ? snapshot.channels : data.channels,
              readChannelKey: canSync && live && readChannelKey ? (channel) => readChannelKey(live, channel) : undefined,
              observationSource, canObserve: Boolean(live && canSync && framedTransport(snapshot.transport)), regionNames,
              pathNodes: live && live === radioKey && pathNodes ? pathNodes : [
                ...data.contacts.map(({ publicKey, name, details }) => ({ publicKey, name, position: contactPosition(details) })),
                ...mapPathNodes,
              ], onPathMap,
            }} />
        </div>
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
  searchTarget?: SearchTarget
}

function ConversationList({ items, selectedId, status, read, showPreviews, unreadOnly, onUnreadOnlyChange, onSelect, onNewChat }: {
  items: Conversation[]
  selectedId?: string
  status: DirectStatus
  read: ReadonlySet<string>
  showPreviews: boolean
  unreadOnly: boolean
  onUnreadOnlyChange: (value: boolean) => void
  onSelect: (id: string) => void
  onNewChat: (id: string) => void
}) {
  const filtered = unreadOnly ? items.filter((item) => unreadReceipts(item.messages, read).length > 0) : items
  const destinations = items.filter((item) => item.recipient || item.channel)
  return (
    <nav aria-label="Conversations">
      <div className="chat-list-controls">
        <label><input type="checkbox" checked={unreadOnly}
          onChange={(event) => onUnreadOnlyChange(event.currentTarget.checked)} /> Unread only</label>
        <label>New chat
          <select value="" disabled={!destinations.length} onChange={(event) => {
            if (event.currentTarget.value) onNewChat(event.currentTarget.value)
          }}>
            <option value="">Choose a contact or channel</option>
            {destinations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
      </div>
      {filtered.length ? (
        <ul className="chat-conversation-list">
          {filtered.map((item) => {
            const last = item.messages.findLast((message) => message.timestamp !== null && Number.isFinite(message.timestamp))
              ?? item.messages.at(-1)
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
      ) : <p className="chat-empty-list">{unreadOnly ? 'No unread conversations.' : 'Sync contacts or messages to start a conversation.'}</p>}
      {status.activeId && <p className="chat-active" role="status">A message is in progress.</p>}
    </nav>
  )
}

function ConversationPane({ radioKey, data, selected, direct, status, senderName, display, searchTarget }: WorkspaceProps & { selected?: Conversation }) {
  if (!selected) {
    return (
      <section className="conversation-pane" aria-label="Conversation">
        <div className="state-message"><h2>No conversations</h2><p>Sync contacts or channels to start a conversation.</p></div>
      </section>
    )
  }
  return <ConversationView key={`${radioKey}:${selected.id}`} conversation={selected}
    radioKey={radioKey} options={data.directSendOptions ?? defaultOptions} direct={direct} status={status}
    senderName={senderName} display={display} searchTarget={searchTarget}
    muted={data.mutedDirectConversations?.includes(selected.id.slice(0, 19)) ?? false} />
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
  searchTarget?: SearchTarget
}

function deliveryLabel(outgoing: StoredOutgoing) {
  const total = outgoing.options.directAttempts + outgoing.options.floodAttempts
  const progress = outgoing.attempt ? ` ${outgoing.attempt}/${total}` : ''
  if (outgoing.status === 'delivered') return 'Delivered'
  if (outgoing.status === 'failed') return `Failed${progress}`
  if (outgoing.status === 'sent') return `Sent${progress}`
  return `Sending${progress}`
}

function timestamp(value: number | null, format: ChatDisplay['formatTime'], full: ChatDisplay['formatTime']) {
  if (value === null || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return null
  const date = new Date(value)
  return <time dateTime={date.toISOString()} title={full(date)}>{format(date)}</time>
}

const idleObservation = { phase: 'idle' as const, error: null, dropped: 0, evicted: 0, entries: [] }
const noSubscription = () => () => {}
const noObservation = () => idleObservation

function ConversationView({ conversation, radioKey, options, direct, status, senderName, display, muted, searchTarget }: ConversationProps) {
  const { active, preferences, read, formatTime, formatClock, formatDate, ownContact, contacts, channels, readChannelKey, mapPosition,
    observationSource, canObserve, regionNames, onPathMap, nodeSession, nodeReady, nodeBusy } = display
  const room = conversation.node?.type === 'room' ? conversation.node : undefined
  const roomCanPost = !room || canPostToRoom(nodeSession.getRemoteNodeAccess(radioKey, room.publicKey))
  const [draft, setDraft] = useState(() => direct.draft(radioKey, conversation.id))
  const [actionError, setActionError] = useState('')
  const [savingNotification, setSavingNotification] = useState(false)
  const [readError, setReadError] = useState('')
  const [hideRepeats, setHideRepeats] = useState(false)
  const [mentionName, setMentionName] = useState('')
  const [search, setSearch] = useState('')
  const [previousSearchTarget, setPreviousSearchTarget] = useState(searchTarget)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [messageContext, setMessageContext] = useState<MessageContext | null>(null)
  const [reactionMessage, setReactionMessage] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const mentionPicker = useRef<HTMLDetailsElement>(null)
  const messageList = useRef<HTMLOListElement>(null)
  const positioned = useRef(false)
  const following = useRef(true)
  const jumpedTo = useRef<SearchTarget>(undefined)
  const unreadBoundary = useRef<string | null>(null)
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
  if (searchTarget !== previousSearchTarget) {
    setPreviousSearchTarget(searchTarget)
    if (searchTarget) {
      setSearch('')
      if (repeats.has(searchTarget.id)) setHideRepeats(false)
    }
  }
  const shown = useMemo(() => searchMessages(visible, search), [visible, search])
  const contextMessage = messageContext && shown.find((message) => message.id === messageContext.id)
  const detailMessage = detailId && conversation.messages.find((message) => message.id === detailId)
  const bytes = new TextEncoder().encode(draft).length
  const isChannel = conversation.id.startsWith('channel:')
  const mentionNames = useMemo(() => conversation.channel
    ? channelMentionNames(contacts, conversation.messages, conversation.channel.index) : [],
  [contacts, conversation.channel, conversation.messages])
  const selectedMention = mentionNames.includes(mentionName) ? mentionName : ''
  let limit: number | null = isChannel ? null : room ? maxRoomTextBytes : maxDirectTextBytes
  let invalid = ''
  try {
    if (isChannel && senderName !== null) {
      limit = channelTextLimit(senderName)
      if (draft) channelTextBytes(draft, senderName)
    } else if (!isChannel && draft) {
      if (room && bytes > maxRoomTextBytes) throw new Error(`Keep room posts within ${maxRoomTextBytes} UTF-8 bytes.`)
      directTextBytes(draft)
    }
  } catch (error) {
    invalid = errorText(error)
  }

  useLayoutEffect(() => {
    if (active && preferences.composerAutofocus && !searchTarget) composer.current?.focus({ preventScroll: true })
  }, [active, preferences.composerAutofocus, searchTarget])

  useLayoutEffect(() => {
    if (!active) {
      positioned.current = false
      unreadBoundary.current = null
      return
    }
    const list = messageList.current
    if (!list) return
    const findRow = (id: string) => Array.from(list.children).find(
      (element): element is HTMLLIElement => (element as HTMLElement).dataset.receiptId === id,
    )
    if (searchTarget && searchTarget !== jumpedTo.current) {
      jumpedTo.current = searchTarget
      const row = findRow(searchTarget.id)
      if (row) {
        positioned.current = true
        const scrolls = list.scrollHeight > list.clientHeight
        if (scrolls) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top
        const bounds = row.getBoundingClientRect()
        if (bounds.top < 0 || bounds.bottom > window.innerHeight) row.scrollIntoView({ block: 'start' })
        row.focus({ preventScroll: true })
        const away = scrolls ? list.scrollHeight - list.scrollTop - list.clientHeight >= 60 : row !== list.lastElementChild
        following.current = !away
        setAwayFromBottom(away)
        return
      }
    }
    if (!positioned.current) {
      positioned.current = true
      const oldest = preferences.oldestUnread ? oldestUnreadReceipt(unread) : undefined
      const row = oldest && findRow(oldest.id)
      if (row) {
        if (list.scrollHeight > list.clientHeight) {
          list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top
        } else if (row.getBoundingClientRect().bottom > window.innerHeight) {
          row.scrollIntoView({ block: 'start' })
        }
        following.current = false
        setAwayFromBottom(true)
      }
    }
    if (following.current) list.scrollTop = list.scrollHeight
  }, [active, shown, unread, preferences.oldestUnread, searchTarget])

  if (active && unreadBoundary.current === null && unread.length) {
    unreadBoundary.current = oldestUnreadReceipt(unread)?.id ?? null
  }

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
  }, [active, direct, radioKey, unread, shown])

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!roomCanPost) return
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
    if (!roomCanPost) return
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

  function messageActions(message: StoredMessage) {
    const sender = isChannel ? channelSender(message) : null
    const body = channelMessageBody(message)
    const run = (action: () => void) => {
      messageContext?.trigger.focus({ preventScroll: true })
      setMessageContext(null)
      action()
    }
    return <>
      {!conversation.node && canReactTo(message) && <button type="button"
        disabled={!reactionEmojiSupport || senderName === null || nodeBusy || status.pending > 0}
        title={senderName === null ? 'Connect this radio to react' : undefined}
        aria-label={`React to message: ${body.slice(0, 40)}`}
        onClick={() => run(() => setReactionMessage(message.id))}>React</button>}
      {message.text && <button type="button" onClick={() => run(() => void copy(message))}
        aria-label={`Copy message: ${message.text.slice(0, 40)}`}>Copy</button>}
      {conversation.channel && sender && mentionableName(sender)
        && <button type="button" onClick={() => run(() => reply(sender, body))} aria-label={`Reply to ${sender}`}>Reply</button>}
      {sender && <button type="button" onClick={() => run(() => void block(sender))} aria-label={`Block sender name ${sender}`}>Block</button>}
      {message.channelOutgoing && message.channelOutgoing.status !== 'sending'
        && conversation.channel?.name === message.channelOutgoing.channelName && (
          <button type="button" disabled={status.activeId !== null || status.pending > 0}
            aria-label={`Resend channel message: ${message.text.slice(0, 40)}`}
            onClick={() => run(() => void resend(message))}>Resend</button>
      )}
      <button type="button" onClick={() => run(() => setDetailId(message.id))}>Message details</button>
      {isChannel && <button type="button" disabled={message.channelOutgoing?.status === 'sending'}
        aria-label={`Delete channel message: ${message.text.slice(0, 40)}`} onClick={() => run(() => void remove(message))}>Delete</button>}
    </>
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
      <header className="conversation-heading">
        <h2>{conversation.title}</h2>
        <input type="search" className="chat-search" aria-label="Search messages" placeholder="Search messages"
          value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        {isChannel && observer && (observed.phase === 'active' || observed.phase === 'starting'
          ? <button type="button" aria-label="Stop channel observation" onClick={() => observer.stop()}>Stop observing</button>
          : <button type="button" aria-label="Observe channel packets" disabled={!canObserve || !conversation.channel || regionNames === null}
            onClick={() => {
              if (conversation.channel && regionNames) void observer.start(radioKey, conversation.channel, regionNames)
            }}>Observe</button>)}
        {conversation.id.startsWith('direct:') && <label className="chat-alert-select">Alerts
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
        {conversation.recipient && <RetrySettings key={radioKey} radioKey={radioKey} current={options} direct={direct} />}
      </header>
      {room && <Suspense fallback={null}>
        <RemoteNodeLogin session={nodeSession} radioKey={radioKey} nodeKey={room.publicKey} type={3}
          active={active} ready={nodeReady} busy={nodeBusy} />
      </Suspense>}
      {isChannel && observer && (regionNames === null || observed.error || observed.phase === 'starting'
        || observed.dropped > 0 || observed.evicted > 0) && <div className="chat-observation">
        {regionNames === null && <p role="alert">Saved channel scopes are invalid; reset them in Channels before observing.</p>}
        {observed.error && <p role="alert">{observed.error}</p>}
        {observed.phase === 'starting' && <p role="status">Starting channel observation…</p>}
        {observed.phase === 'active' && (observed.dropped > 0 || observed.evicted > 0) && <p role="status">
          {observed.dropped > 0 && `${observed.dropped} packets skipped. `}
          {observed.evicted > 0 && `${observed.evicted} older observations discarded.`}</p>}
      </div>}
      {repeats.size > 0 && (
        <label className="chat-repeat-filter">
          <input type="checkbox" checked={hideRepeats} onChange={(event) => setHideRepeats(event.currentTarget.checked)} />
          <span>Hide {repeats.size} possible repeat{repeats.size === 1 ? '' : 's'}</span>
        </label>
      )}
      {conversation.messages.length ? (
        <ol className="chat-message-list" ref={messageList} onScroll={(event) => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
          setAwayFromBottom(!following.current)
        }}>
          {shown.map((message, index) => {
            const outgoing = message.outgoing || message.channelOutgoing
            const channelSend = message.channelOutgoing
            const time = timestamp(message.timestamp, formatClock, formatTime)
            const hops = preferences.pathMetadata && message.receipt ? receiptHopCount(message.receipt.pathLength) : null
            const day = messageDay(message.timestamp)
            const previousDay = index ? messageDay(shown[index - 1].timestamp) : undefined
            return (
              <Fragment key={message.id}>
                {day !== previousDay && <li className="chat-divider">{day === null ? 'Unknown date' : formatDate(new Date(message.timestamp!))}</li>}
                {message.id === unreadBoundary.current && <li className="chat-divider chat-divider--unread">New messages</li>}
                <li data-receipt-id={message.id} tabIndex={-1}
                  onContextMenu={(event) => {
                    if ((event.target as Element).closest('button, a, input, select, textarea, summary')
                      || window.getSelection()?.isCollapsed === false) return
                    event.preventDefault()
                    setMessageContext({ id: message.id, point: { x: event.clientX, y: event.clientY },
                      trigger: event.currentTarget, channel: isChannel })
                  }}
                  className={outgoing ? 'chat-message chat-message--outgoing' : 'chat-message'}>
                  <div className="chat-bubble">
                    {!outgoing && <strong className="chat-sender">{isChannel ? channelSender(message) ?? 'Unknown sender'
                      : nodeMessageSender(conversation, message, contacts)}</strong>}
                    {message.reaction ? <>
                      <p>Reaction {message.reaction.parsed.emoji}</p>
                      {message.reaction.state !== 'matched' && <p className="chat-reaction-state">
                        {message.reaction.state === 'ambiguous' ? 'Ambiguous reaction; not counted.'
                          : message.reaction.state === 'unavailable' ? 'Reaction matching unavailable.'
                            : 'Unmatched reaction; retained for later matching.'}
                      </p>}
                    </> : message.text && <MessageText text={channelMessageBody(message)} channel={isChannel} ownName={senderName} />}
                    {message.reactions?.length ? <div className="chat-reaction-summary" role="group" aria-label="Message reactions">
                      {message.reactions.map(({ emoji, count, senders }) => <details key={emoji}>
                        <summary aria-label={`${emoji}: ${count} reaction${count === 1 ? '' : 's'}`}>{emoji} {count}</summary>
                        <p>{senders.join(', ')}</p>
                      </details>)}
                    </div> : null}
                    {message.receipt?.kind === 'channel-data' && <p>Channel data</p>}
                    {message.conversationId === 'unsupported' && <p>Unrecognized response</p>}
                    {!message.text && !message.receipt && !message.rawHex && <p>Empty message</p>}
                    {(time || outgoing || hops !== null) && <div className="chat-message-footer">
                      {time}
                      {hops !== null && <span>{hops} {hops === 1 ? 'hop' : 'hops'}</span>}
                      {message.outgoing && <span className={message.outgoing.status === 'failed' ? 'chat-failed' : undefined}>
                        {deliveryLabel(message.outgoing)}
                      </span>}
                      {channelSend && <span className={channelSend.status === 'uncertain' ? 'chat-failed' : undefined}
                        title={channelSend.status === 'accepted' ? 'Delivery is unconfirmed.' : undefined}>
                        {channelSend.status === 'sending' ? 'Sending' : channelSend.status === 'accepted'
                          ? 'Accepted by radio' : 'Send status uncertain'}
                      </span>}
                    </div>}
                    {message.outgoing && (message.outgoing.status === 'failed' || status.activeId === message.id) && (
                      <div className="chat-delivery">
                        {message.outgoing.status === 'failed' && (
                          <button type="button" disabled={!roomCanPost || status.activeId !== null || status.pending > 0}
                            aria-label={`Retry message: ${message.text.slice(0, 40)}`} onClick={() => void retry(message)}>Retry</button>
                        )}
                        {status.activeId === message.id && (
                          <button type="button" disabled={status.cancelling} onClick={direct.cancel}>
                            {status.cancelling ? 'Cancelling…' : 'Cancel sending'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <button className="chat-message-menu" type="button" aria-label="Message actions"
                    aria-expanded={messageContext?.id === message.id} onClick={(event) => {
                      const trigger = event.currentTarget
                      if (messageContext?.trigger === trigger) setMessageContext(null)
                      else setMessageContext({ id: message.id, trigger, channel: isChannel })
                    }}>⋯</button>
                </li>
              </Fragment>
            )
          })}
          {!shown.length && <li className="chat-divider">No matching messages.</li>}
        </ol>
      ) : <div className="state-message"><h2>No messages yet</h2></div>}
      {messageContext && contextMessage && <MessageContextActions context={messageContext} onClose={() => setMessageContext(null)}>
        {messageActions(contextMessage)}
      </MessageContextActions>}
      {reactionMessage && <ReactionPicker disabled={senderName === null || nodeBusy || status.pending > 0} error={status.error}
        onClose={() => setReactionMessage(null)}
        onSend={(emoji) => direct.react(radioKey, reactionMessage, emoji, options)} />}
      {active && detailMessage && <ShareModal title="Message details" close={() => setDetailId(null)}>
        <MessageDetails message={detailMessage} matches={channelMatches.get(detailMessage.id)}
          correlation={correlations.get(detailMessage.id)} display={display}
          onPathMap={onPathMap && ((path) => { setDetailId(null); onPathMap(path) })} />
      </ShareModal>}
      {conversation.messages.length > 0 && awayFromBottom && <button className="chat-jump" type="button" onClick={() => {
        const list = messageList.current
        if (!list) return
        following.current = true
        list.scrollTop = list.scrollHeight
        if (list.getBoundingClientRect().bottom > window.innerHeight) list.lastElementChild?.scrollIntoView({ block: 'end' })
        setAwayFromBottom(false)
      }}>Jump to bottom</button>}
      {readError && <p className="chat-action-error" role="alert">{readError}</p>}
      {actionError && <p className="chat-action-error" role="alert">{actionError}</p>}
      {(isChannel || conversation.id.startsWith('direct:')) && (conversation.node?.type !== 'sensor' || draft !== '') && (
        <form className="chat-composer" onSubmit={(event) => void send(event)}>
          <div className="chat-compose-field">
            {active && <ComposerTools ownContact={ownContact} contacts={contacts} channels={channels}
              readChannelKey={readChannelKey} mapPosition={mapPosition} insert={insertInDraft} />}
            {isChannel && <details className="chat-mention-picker" ref={mentionPicker}>
              <summary aria-label="Mention a name" title="Mention a name">@</summary>
              <div className="chat-tool-panel">
                {mentionNames.length ? <div className="chat-mention-choice">
                  <label>Name to mention
                    <select value={selectedMention} onChange={(event) => setMentionName(event.currentTarget.value)}>
                      <option value="">Select a name</option>
                      {mentionNames.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </label>
                  <button type="button" disabled={!selectedMention} onClick={insertMention}>Insert mention</button>
                </div> : <p>No names available. Type <code>@[name]</code> to mention someone.</p>}
              </div>
            </details>}
            <textarea id="chat-draft" ref={composer} rows={1} value={draft} aria-label="Message" placeholder="Message"
              aria-describedby={draft ? 'chat-byte-count chat-draft-error' : 'chat-draft-error'}
              onChange={(event) => updateDraft(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !event.repeat) {
                  event.preventDefault()
                  if (roomCanPost && draft && !invalid && status.activeId === null && (conversation.recipient || conversation.channel)) {
                    event.currentTarget.form?.requestSubmit()
                  }
                }
              }} />
            {draft && <span className="chat-byte-count" id="chat-byte-count"
              title={limit === null ? 'Connect to check the message limit' : 'UTF-8 bytes'}>
              {limit === null ? bytes : `${bytes}/${limit}`}<span className="chat-sr-only"> UTF-8 bytes</span>
            </span>}
            <button className="chat-send" type="submit" aria-label={room ? 'Post message' : 'Send message'}
              disabled={!roomCanPost || !draft || Boolean(invalid) || status.activeId !== null
                || !(conversation.recipient || conversation.channel)}>{room ? 'Post' : 'Send'}</button>
          </div>
          <p id="chat-draft-error" className="chat-action-error">{invalid || (room && !roomCanPost ? 'Posting access required.'
            : !conversation.recipient && !conversation.channel ? 'Sending unavailable.' : '')}</p>
        </form>
      )}
    </section>
  )
}

function MessageDetails({ message, matches, correlation, display, onPathMap }: {
  message: StoredMessage
  matches?: StoredMessage[]
  correlation?: { entries: CapturedChannelObservation[]; matchingMessages: number }
  display: ChatDisplay
  onPathMap?: ChatDisplay['onPathMap']
}) {
  const { formatTime, preferences, pathNodes } = display
  const { receipt, rawHex, outgoing, channelOutgoing } = message
  const time = timestamp(message.timestamp, formatTime, formatTime)
  const scope = channelOutgoing?.scope
  return <div className="chat-message-details">
    {time}
    {message.reaction && <>
      <p>{message.reaction.state === 'matched' ? 'Matched to a message in this conversation.'
        : message.reaction.state === 'ambiguous' ? 'Ambiguous reaction: multiple target messages match. Not counted.'
          : message.reaction.state === 'unavailable' ? 'Reaction matching unavailable. Wire receipt retained.'
            : 'Unmatched reaction: target not yet available. Retained for later matching.'}</p>
      <details><summary>Wire reaction text</summary><pre>{channelMessageBody(message)}</pre></details>
    </>}
    {receipt?.kind === 'channel-data' && <p>Channel data (type {receipt.dataType}): <code>{receipt.dataHex}</code></p>}
    {preferences.pathMetadata && receipt && <ReceiptPath receipt={receipt} />}
    {preferences.regionMetadata && message.region && <p>Region {message.region}</p>}
    {outgoing && <p>{deliveryLabel(outgoing)}
      {preferences.pathMetadata && outgoing.route && ` · ${outgoing.route === 'direct' ? 'Direct' : 'Flood'}`}</p>}
    {channelOutgoing?.status === 'accepted' && <p>Accepted by radio. Delivery is unconfirmed.</p>}
    {preferences.regionMetadata && scope && <p>Scope: {scope.mode === 'region' ? scope.name
      : scope.mode === 'unscoped' ? 'Explicitly unscoped' : 'Radio default'}</p>}
    {(outgoing?.error || channelOutgoing?.error) && <p className="chat-failed">{outgoing?.error || channelOutgoing?.error}</p>}
    {matches && <details>
      <summary>{matches.length} matching queued receipts (possible repeats)</summary>
      <p>Matching receipts can belong to separate messages. The radio may not queue every heard copy.</p>
      {preferences.pathMetadata && <ul>{matches.map((match) => <li key={match.id}>
        {match.receipt && <ReceiptPath receipt={match.receipt} />}
      </li>)}</ul>}
    </details>}
    {correlation && <RxObservationDetails correlation={correlation} outgoing={Boolean(channelOutgoing)}
      preferences={preferences} formatTime={formatTime} pathNodes={pathNodes} onPathMap={onPathMap} />}
    {rawHex && <details><summary>Raw receipt</summary><code>{rawHex}</code></details>}
    {!time && !receipt && !rawHex && !outgoing && !channelOutgoing && !message.region && <p>No details available.</p>}
  </div>
}

function MessageText({ text, channel, ownName }: { text: string; channel: boolean; ownName: string | null }) {
  const source: ChannelTextPart[] = channel ? channelTextParts(text) : [{ kind: 'text', text }]
  const parts = source.flatMap<ImageLinkPart | ChannelTextPart>((part) =>
    part.kind === 'text' ? imageLinkParts(part.text) : [part])
  const links = [...new Map(parts.flatMap((part) => part.kind === 'image' || part.kind === 'link'
    ? [[part.url, part.kind] as const] : [])).entries()]
  return <>
    <p>{parts.map((part, index) => part.kind === 'image' || part.kind === 'link'
      ? <a key={index} href={part.url} target="_blank" rel="noopener noreferrer">{part.url}</a>
      : part.kind === 'mention' ? <ChannelMessageText key={index} text={`@[${part.name}]`} ownName={ownName} /> : part.text)}</p>
    {links.map(([url, kind]) => <MessageImage key={url} url={url} automatic={kind === 'image'} />)}
  </>
}

function MessageImage({ url, automatic }: { url: string; automatic: boolean }) {
  const [requested, setRequested] = useState(automatic)
  const [failed, setFailed] = useState(false)
  return <div className="chat-image">
    {!requested ? <button type="button" aria-label={`Load image from ${url}`}
      onClick={() => setRequested(true)}>Load image: {url}</button>
      : failed ? <p className="chat-failed" role="status">Image could not be loaded: {url}. Use the message link to open it.</p>
      : <img src={url} alt={`Image from ${new URL(url).hostname}`} loading="lazy" referrerPolicy="no-referrer"
        onError={() => setFailed(true)} />}
  </div>
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
      <div className="chat-tool-panel">
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
        <p>1–8 attempts total. Flood fallback clears the saved route.</p>
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  )
}
