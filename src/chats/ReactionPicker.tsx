import { useEffect, useRef, useState } from 'react'
import { isReactionEmoji } from '../radio/reactions.ts'

const quick = [
  ['👍', 'Thumbs up'], ['❤️', 'Heart'], ['😂', 'Laugh'], ['🎉', 'Celebrate'], ['👏', 'Clap'], ['🔥', 'Fire'],
]

export function ReactionPicker({ onSend, onClose, disabled, error }: {
  onSend: (emoji: string) => Promise<boolean>
  onClose: () => void
  disabled: boolean
  error: string | null
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [emoji, setEmoji] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        const target = previous instanceof HTMLButtonElement && previous.disabled
          ? previous.closest<HTMLElement>('[data-receipt-id]') : previous
        target?.focus({ preventScroll: true })
      }
    }
  }, [])
  async function send(value: string) {
    setSending(true)
    try { if (await onSend(value)) onClose() }
    finally { setSending(false) }
  }
  return <dialog ref={dialog} className="chat-reaction-picker" aria-labelledby="reaction-picker-title"
    onCancel={(event) => { event.preventDefault(); onClose() }}>
    <h2 id="reaction-picker-title">React to message</h2>
    <p>Sends a reaction over the connected radio. Reactions cannot be removed remotely.</p>
    <div className="chat-reaction-quick" role="group" aria-label="Quick reactions">
      {quick.map(([value, name]) => <button key={name} type="button" aria-label={`React with ${name}`}
        disabled={disabled || sending} onClick={() => void send(value)}>{value}</button>)}
    </div>
    <form onSubmit={(event) => { event.preventDefault(); if (isReactionEmoji(emoji)) void send(emoji) }}>
      <label>Other emoji<input value={emoji} onChange={(event) => setEmoji(event.currentTarget.value)}
        aria-describedby="reaction-emoji-help" /></label>
      <p id="reaction-emoji-help">One emoji, including a flag, skin tone or joined family.</p>
      {emoji && !isReactionEmoji(emoji) && <p role="alert">Enter exactly one emoji.</p>}
      {disabled && <p role="status">Connect this radio and finish pending actions before reacting.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="chat-reaction-quick">
        <button type="submit" disabled={disabled || sending || !isReactionEmoji(emoji)}>Send reaction</button>
        <button type="button" onClick={onClose}>Close reaction picker</button>
      </div>
    </form>
  </dialog>
}
