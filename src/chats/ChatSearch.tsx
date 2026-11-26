import { useMemo, useState } from 'react'
import { searchChatHistory } from './model.ts'
import type { Conversation } from './model.ts'

const pageSize = 30

export function ChatSearch({ items, onOpen }: {
  items: readonly Conversation[]
  onOpen: (conversationId: string, messageId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(pageSize)
  const matches = useMemo(() => searchChatHistory(items, query), [items, query])

  return <details className="chat-history-search">
    <summary>Search all chats</summary>
    <label>Cached message text
      <input type="search" value={query} onChange={(event) => {
        setQuery(event.currentTarget.value)
        setLimit(pageSize)
      }} />
    </label>
    {query.trim() && <>
      <p role="status">{matches.length
        ? `${matches.length} matching message${matches.length === 1 ? '' : 's'}` : 'No matching messages.'}</p>
      {matches.length > 0 && <ul className="chat-conversation-list chat-search-results" aria-label="Matching messages">
        {matches.slice(0, limit).map(({ conversation, message }) => (
          <li key={message.id}>
            <button type="button" onClick={() => onOpen(conversation.id, message.id)}>
              <strong>{conversation.title}</strong>
              <span>{message.text}</span>
            </button>
          </li>
        ))}
      </ul>}
      {matches.length > limit && <button type="button" onClick={() => setLimit(limit + pageSize)}>Show more matches</button>}
    </>}
  </details>
}
