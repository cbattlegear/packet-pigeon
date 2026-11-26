import { useMemo, useState } from 'react'
import { deliveryLabel, latestMessage, searchMessages } from './model.ts'
import type { Conversation } from './model.ts'

export type ChatDestination = { kind: 'message'; id: string } | { kind: 'compose' | 'unread' }

type Props = {
  items: readonly Conversation[]
  unread: ReadonlyMap<string, number>
  selectedId?: string
  showPreviews: boolean
  onOpen: (id: string, destination?: ChatDestination) => void
}

const pageSize = 30

export function ChatNavigation({ items, unread, selectedId, showPreviews, onOpen }: Props) {
  const [mode, setMode] = useState<'list' | 'new' | 'search'>('list')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(pageSize)
  const targets = items.filter(({ recipient, channel }) => recipient || channel)
  const hasRecipient = targets.some(({ id }) => id === recipient)
  const results = useMemo(() => mode === 'search' ? searchMessages(items, query) : [], [items, mode, query])

  return <>
    <div className="chat-navigation-actions" role="group" aria-label="Chat navigation">
      <button type="button" aria-expanded={mode === 'new'} onClick={() => {
        setRecipient('')
        setMode(mode === 'new' ? 'list' : 'new')
      }}>New chat</button>
      <button type="button" aria-expanded={mode === 'search'}
        onClick={() => setMode(mode === 'search' ? 'list' : 'search')}>Search messages</button>
    </div>
    {mode === 'new' && <form className="chat-navigation-panel" onSubmit={(event) => {
      event.preventDefault()
      if (!hasRecipient) return
      onOpen(recipient, { kind: 'compose' })
      setMode('list')
    }}>
      {targets.length > 0 ? <>
        <label>Start a chat with
          <select value={recipient} onChange={(event) => setRecipient(event.currentTarget.value)}>
            <option value="">Select a contact or channel</option>
            {targets.map((item) => <option key={item.id} value={item.id}>
              {item.title} ({item.channel ? `channel ${item.channel.index}` : item.recipient?.slice(0, 12)})
            </option>)}
          </select>
        </label>
        <button type="submit" disabled={!hasRecipient}>Open chat</button>
      </> : <p>Sync contacts or channels to start a chat.</p>}
    </form>}
    {mode === 'search' && <div className="chat-navigation-panel">
      <label>Search cached messages
        <input type="search" value={query} onChange={(event) => {
          setQuery(event.currentTarget.value)
          setLimit(pageSize)
        }} />
      </label>
      {query.trim() && <>
        <p role="status">{results.length ? `${results.length} matching message${results.length === 1 ? '' : 's'}` : 'No matching messages.'}</p>
        {results.length > 0 && <ul className="chat-conversation-list chat-search-results" aria-label="Matching messages">
          {results.slice(0, limit).map(({ conversation, message }) => (
            <li key={message.id}>
              <button type="button" onClick={() => onOpen(conversation.id, { kind: 'message', id: message.id })}>
                <strong>{conversation.title}</strong>
                <span>{message.text}</span>
              </button>
            </li>
          ))}
        </ul>}
        {results.length > limit && <button type="button" onClick={() => setLimit(limit + pageSize)}>Show more matches</button>}
      </>}
    </div>}
    <div className="chat-navigation-actions" role="group" aria-label="Filter conversations">
      <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All chats</button>
      <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread chats</button>
    </div>
    <nav aria-label="Conversations">
      <ConversationList items={unreadOnly ? items.filter(({ id }) => unread.has(id)) : items}
        unread={unread} selectedId={selectedId} showPreviews={showPreviews} onOpen={onOpen} unreadOnly={unreadOnly} />
    </nav>
  </>
}

function ConversationList({ items, unread, selectedId, showPreviews, onOpen, unreadOnly }: Props & { unreadOnly: boolean }) {
  if (!items.length) return <p className="chat-empty-list">{unreadOnly
    ? 'No unread conversations.' : 'Sync contacts or messages to start a conversation.'}</p>

  return <ul className="chat-conversation-list">
    {items.map((item) => {
      const last = showPreviews ? latestMessage(item.messages) : undefined
      return <li key={item.id}>
        <button type="button" aria-current={selectedId === item.id ? 'page' : undefined}
          onClick={() => onOpen(item.id, unreadOnly ? { kind: 'unread' } : undefined)}>
          <strong>{item.title}</strong>
          {unread.has(item.id) && <small>{unread.get(item.id)} unread</small>}
          {showPreviews && <span>{last?.text || (last ? 'Received entry' : 'No messages yet')}</span>}
          {last?.outgoing && <small>{deliveryLabel(last.outgoing)}</small>}
        </button>
      </li>
    })}
  </ul>
}
