import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Coordinates } from '../map/nodes.ts'
import type { StoredChannel, StoredContact } from '../storage/index.ts'
import { directTextBytes, maxDirectTextBytes } from '../radio/direct-message.ts'
import { ShareModal } from './ShareDialogs.tsx'
import { contactShareLink, formatMeshCoreShare } from './meshcoreLinks.ts'

const quickMessagesKey = 'packet-pigeon:quick-messages'
const maxQuickMessages = 12

function readQuickMessages() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(quickMessagesKey) ?? '[]')
    return Array.isArray(saved)
      ? saved.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, maxQuickMessages)
      : []
  } catch {
    return []
  }
}

type Props = {
  ownContact: string | null
  contacts: readonly StoredContact[]
  channels: readonly StoredChannel[]
  readChannelKey?: (channel: StoredChannel) => Promise<string>
  mapPosition?: Coordinates | null
  insert: (text: string) => string | null
}

export function ComposerTools(props: Props) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="chat-compose-tool" type="button" aria-label="Share or use quick message" title="Add to message"
      onClick={() => setOpen(true)}>+</button>
    {open && <ComposerShareDialog {...props} close={() => setOpen(false)} />}
  </>
}

function ComposerShareDialog({ ownContact, contacts, channels, readChannelKey, mapPosition, insert, close }: Props & {
  close: () => void
}) {
  const [contactKey, setContactKey] = useState('')
  const [channelIndex, setChannelIndex] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [quick, setQuick] = useState(readQuickMessages)
  const [editing, setEditing] = useState<number | null>(null)
  const [template, setTemplate] = useState('')
  const [quickError, setQuickError] = useState('')
  const templateId = useId()
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const contactOptions = contacts.flatMap((contact) => {
    const link = contactShareLink(contact.name, contact.publicKey, contact.details?.type)
    return link ? [{ ...contact, link }] : []
  })
  const contact = contactOptions.find(({ publicKey }) => publicKey === contactKey)
  const channel = channels.find(({ index }) => String(index) === channelIndex)

  function add(text: string) {
    if (!mounted.current) return
    const issue = insert(text)
    if (issue) setError(issue)
    else close()
  }

  async function shareChannel() {
    if (!channel || !readChannelKey || busy || !window.confirm(
      `Add an invitation to "${channel.name}"? The link contains the channel key. It may be stored in the draft and in chat history after sending.`,
    )) return
    setBusy(true)
    setError('')
    try {
      const secret = await readChannelKey(channel)
      add(formatMeshCoreShare({ kind: 'channel', name: channel.name, secret }))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not read the channel key.')
    } finally {
      setBusy(false)
    }
  }

  function locate() {
    if (busy || !window.confirm('Look up your current position and add it to the draft?')) return
    if (!navigator.geolocation) {
      setError('Browser location is unavailable.')
      return
    }
    setBusy(true)
    setError('')
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setBusy(false)
      add(locationLink({ lat: coords.latitude, lon: coords.longitude }))
    }, () => {
      setBusy(false)
      setError('The browser could not provide your location. Check location permissions and try again.')
    }, { timeout: 10_000 })
  }

  function saveQuick(next: string[]) {
    setQuick(next)
    setEditing(null)
    setTemplate('')
    setQuickError('')
    try {
      localStorage.setItem(quickMessagesKey, JSON.stringify(next))
    } catch {
      setQuickError('The browser could not save your quick messages.')
    }
  }

  function saveTemplate() {
    const text = template.trim()
    if (!text) return
    try {
      directTextBytes(text)
    } catch {
      setQuickError(`Quick messages must fit in ${maxDirectTextBytes} UTF-8 bytes and contain valid text.`)
      return
    }
    const next = [...quick]
    next[editing ?? next.length] = text
    saveQuick(next)
  }

  return <ShareModal title="Add to message" close={() => { mounted.current = false; close() }}>
    <fieldset disabled={busy}>
      <legend>Share</legend>
      <div className="share-actions">
        <button type="button" disabled={!ownContact} onClick={() => { if (ownContact) add(ownContact) }}>My contact</button>
        <button type="button" onClick={locate}>My current location</button>
        <button type="button" disabled={!mapPosition} onClick={() => {
          if (mapPosition && window.confirm('Add the selected map coordinates to the draft?')) add(locationLink(mapPosition))
        }}>Selected map location</button>
      </div>
      <label>Contact to share
        <select value={contactKey} onChange={(event) => setContactKey(event.currentTarget.value)}>
          <option value="">Select a contact</option>
          {contactOptions.map(({ name, publicKey }) => <option key={publicKey} value={publicKey}>{name}</option>)}
        </select>
      </label>
      <button type="button" disabled={!contact} onClick={() => { if (contact) add(contact.link) }}>Add contact link</button>
      <label>Channel to share
        <select value={channelIndex} disabled={!readChannelKey} onChange={(event) => setChannelIndex(event.currentTarget.value)}>
          <option value="">Select a channel</option>
          {channels.map(({ index, name }) => <option key={index} value={index}>{name}</option>)}
        </select>
      </label>
      <button type="button" disabled={!channel || !readChannelKey} onClick={() => void shareChannel()}>Add channel link</button>
      {!readChannelKey && <p>Connect to the radio to share a channel key.</p>}
    </fieldset>
    <fieldset disabled={busy}>
      <legend>Quick messages</legend>
      {quick.length > 0 && <ul className="quick-messages">{quick.map((text, index) => (
        <li key={index}>
          <button type="button" onClick={() => add(text)}>{text}</button>
          <button type="button" aria-label={`Edit quick message ${index + 1}`} onClick={() => {
            setEditing(index)
            setTemplate(text)
            setQuickError('')
          }}>Edit</button>
          <button type="button" aria-label={`Remove quick message ${index + 1}`}
            onClick={() => saveQuick(quick.filter((_, position) => position !== index))}>Remove</button>
        </li>
      ))}</ul>}
      <label htmlFor={templateId}>{editing === null ? 'New quick message' : 'Edit quick message'}</label>
      <textarea id={templateId} value={template} rows={2} onChange={(event) => setTemplate(event.currentTarget.value)} />
      <div className="share-actions">
        <button type="button" disabled={!template.trim() || (editing === null && quick.length === maxQuickMessages)}
          onClick={saveTemplate}>Save quick message</button>
        {editing !== null && <button type="button" onClick={() => { setEditing(null); setTemplate('') }}>Cancel edit</button>}
      </div>
      {quickError && <p role="alert">{quickError}</p>}
    </fieldset>
    {busy && <p role="status">Waiting for location or channel details…</p>}
    {error && <p role="alert">{error}</p>}
  </ShareModal>
}

function locationLink({ lat, lon }: Coordinates) {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}`
}
