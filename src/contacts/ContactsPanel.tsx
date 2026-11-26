import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { storedContact } from '../integration/contact-record.ts'
import { mapPosition, roles } from '../map/nodes.ts'
import type { Coordinates, NodeRole } from '../map/nodes.ts'
import { distanceBetween } from '../map/terrain.ts'
import type { CompanionSnapshot } from '../radio/index.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { ContactPreferenceEdit, RadioData, RadioKey, StoredContact } from '../storage/index.ts'
import { contactEntries, contactPosition, contactRole, contactRoute, roleLabel, visibleContacts } from './model.ts'
import type { ContactEntry, ContactSort } from './model.ts'
import { contactShareLink } from '../sharing/meshcoreLinks.ts'
import { ContactRadioActions } from './ContactRadioActions.tsx'
import type { ContactRadioSession } from './ContactRadioActions.tsx'
import './contacts.css'

type ContactsProps = {
  snapshot: CompanionSnapshot
  session: ContactRadioSession
  cacheSaving: boolean
  messageSyncing: boolean
  messageSending: boolean
  onMap: (position: Coordinates, terrain: boolean) => void
  onImport?: () => void
  onShare?: (link: string) => void
  radioNavigation?: { key: RadioKey; sequence: number } | null
  onRadioNavigationHandled?: () => void
}

type CacheView = { keys: RadioKey[]; key: RadioKey | null; data: RadioData | null; error: string | null }
const emptyCache: CacheView = { keys: [], key: null, data: null, error: null }
const noContacts: StoredContact[] = []
const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function advertAge(timestamp: number | undefined) {
  if (!timestamp) return 'Never heard'
  const seconds = timestamp - Date.now() / 1_000
  if (Math.abs(seconds) < 60) return relativeTime.format(Math.round(seconds), 'second')
  if (Math.abs(seconds) < 3_600) return relativeTime.format(Math.round(seconds / 60), 'minute')
  if (Math.abs(seconds) < 86_400) return relativeTime.format(Math.round(seconds / 3_600), 'hour')
  return relativeTime.format(Math.round(seconds / 86_400), 'day')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The contact action failed.'
}

function exportContacts(contacts: readonly ContactEntry[]) {
  const nodes = contacts.map((contact) => ({
    publicKey: contact.publicKey, name: contact.displayName,
    role: contactRole(contact.details?.type),
    favorite: contact.favorite,
    position: contactPosition(contact.details),
  }))
  const file = new Blob([JSON.stringify({ nodes }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = 'packet-pigeon-contacts.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function ContactsPanel({ snapshot, session, cacheSaving, messageSyncing, messageSending, onMap, onImport, onShare,
  radioNavigation, onRadioNavigationHandled }: ContactsProps) {
  const live = snapshot.phase === 'ready' || snapshot.phase === 'syncing' ? snapshot.device : null
  const liveKey = live ? radioKeyFromPublicKey(live.publicKey) : null
  const [offlineChoice, setOfflineChoice] = useState<RadioKey | '' | null>(null)
  const [cache, setCache] = useState(emptyCache)
  const [refresh, setRefresh] = useState(0)
  const lastSessionKey = snapshot.device ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const offlineKey = offlineChoice === null ? lastSessionKey : offlineChoice || null
  const radioKey = liveKey ?? offlineKey
  const data = cache.key === radioKey ? cache.data : null
  const syncContacts = liveKey !== null && snapshot.progress?.stage !== 'contacts'
  const liveContacts = useMemo(() => snapshot.contacts.map(storedContact), [snapshot.contacts])
  const contacts = syncContacts ? liveContacts : data?.contacts ?? noContacts
  const entries = useMemo(() => contactEntries(
    contacts, data?.contactPreferences ?? [], data?.messages ?? [],
  ), [contacts, data])

  useEffect(() => {
    if (!radioNavigation) return
    setOfflineChoice(radioNavigation.key)
    onRadioNavigationHandled?.()
  }, [radioNavigation, onRadioNavigationHandled])

  useEffect(() => {
    let active = true
    async function read() {
      try {
        const storage = await openRadioStorage()
        try {
          const [keys, data] = await Promise.all([
            storage.listRadioKeys(), radioKey ? storage.read(radioKey) : null,
          ])
          if (active) setCache({ keys, key: radioKey, data, error: null })
        } finally {
          storage.close()
        }
      } catch (error) {
        if (active) setCache((current) => ({ ...current, error: errorMessage(error) }))
      }
    }
    void read()
    return () => { active = false }
  }, [radioKey, cacheSaving, messageSyncing, messageSending, refresh])

  async function savePreference(key: RadioKey, change: ContactPreferenceEdit) {
    const storage = await openRadioStorage()
    try {
      await storage.update(key, { contactPreference: change })
    } finally {
      storage.close()
    }
    setRefresh((value) => value + 1)
  }

  return (
    <div className="contact-workspace">
      {live ? <p>{live.name || 'Connected radio'} · {live.capabilities.maxContacts
        ? `${contacts.length} of ${live.capabilities.maxContacts} contact slots` : `${contacts.length} contacts`}</p>
        : <label className="contact-radio">Cached radio
          <select value={offlineKey ?? ''} onChange={(event) => {
            const key = cache.keys.find((entry) => entry === event.currentTarget.value)
            setOfflineChoice(key ?? '')
          }}>
            <option value="">Select a saved radio</option>
            {cache.keys.map((key) => <option key={key} value={key}>{key}</option>)}
          </select>
        </label>}
      {cache.error && <div className="contact-note" role="alert">
        <p>{cache.error}</p>
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry loading contacts</button>
      </div>}
      {onImport && <div className="contact-actions"><button type="button" onClick={onImport}>Import link or QR code</button></div>}
      {radioKey ? (
        <ContactBrowser
          key={radioKey}
          radioKey={radioKey}
          entries={entries}
          session={session}
          canWrite={liveKey === radioKey && snapshot.phase === 'ready'}
          firmware={lastSessionKey === radioKey ? snapshot.device?.capabilities.firmwareProtocolVersion ?? 0 : 0}
          usb={snapshot.transport === 'usb'}
          radioBusy={messageSyncing || messageSending}
          savePreference={savePreference}
          onMap={onMap}
          onShare={onShare}
        />
      ) : <p className="contact-note">{cache.keys.length
        ? 'Select a saved radio to browse its contacts.' : 'Connect a radio to sync its contacts.'}</p>}
    </div>
  )
}

type BrowserProps = {
  radioKey: RadioKey
  entries: ContactEntry[]
  session: ContactsProps['session']
  canWrite: boolean
  firmware: number
  usb: boolean
  radioBusy: boolean
  savePreference: (radioKey: RadioKey, change: ContactPreferenceEdit) => Promise<void>
  onMap: ContactsProps['onMap']
  onShare?: ContactsProps['onShare']
}

function ContactBrowser({ radioKey, entries, session, canWrite, firmware, usb, radioBusy, savePreference, onMap, onShare }: BrowserProps) {
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<NodeRole | 'all'>('all')
  const [sort, setSort] = useState<ContactSort>('name')
  const [favorites, setFavorites] = useState(false)
  const [selected, setSelected] = useState(() => new Set<string>())
  const [detailKey, setDetailKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [location, setLocation] = useState<Coordinates | null>(null)
  const visited = visibleContacts(entries, { search, role, sort, favorites })
  const picked = entries.filter((contact) => selected.has(contact.publicKey))
  const detail = entries.find((contact) => contact.publicKey === detailKey)

  function toggle(key: string) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !canWrite) return
    const form = event.currentTarget
    const values = new FormData(form)
    const type = contactRole(Number(values.get('role')))
    if (!type) return
    setBusy(true)
    setStatus('')
    try {
      await session.addContact(radioKey, {
        publicKey: String(values.get('publicKey')), name: String(values.get('name')), type,
      })
      form.reset()
      setStatus('Contact added to the radio.')
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(contacts: readonly ContactEntry[]) {
    if (busy || !canWrite || contacts.length === 0) return
    const label = contacts.length === 1 ? contactLabel(contacts[0]) : `${contacts.length} contacts`
    if (!window.confirm(`Remove ${label} from the connected radio?`)) return
    setBusy(true)
    setStatus('')
    let confirmed = 0
    try {
      for (const { publicKey } of contacts) {
        await session.removeContact(radioKey, publicKey)
        confirmed++
        setSelected((previous) => new Set([...previous].filter((key) => key !== publicKey)))
      }
      setStatus(`${confirmed} ${confirmed === 1 ? 'contact' : 'contacts'} removed.`)
    } catch (error) {
      setStatus(`Removed ${confirmed} of ${contacts.length}. ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function edit(change: ContactPreferenceEdit, success: string) {
    if (busy) return
    setBusy(true)
    setStatus('')
    try {
      await savePreference(radioKey, change)
      setStatus(success)
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  function locate() {
    if (!navigator.geolocation) {
      setStatus('Browser location is unavailable.')
      return
    }
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setLocation({ lat: coords.latitude, lon: coords.longitude })
      setStatus('')
    }, () => setStatus('Your browser could not share your location.'), { timeout: 10_000 })
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key)
      setStatus('Public key copied.')
    } catch {
      setStatus('Clipboard access failed. Select and copy the public key from the details.')
    }
  }

  return (
    <>
      <div className="contact-filters">
        <label>Search contacts
          <input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        </label>
        <label>Role
          <select aria-label="Contact role" value={role} onChange={(event) => {
            const value = event.currentTarget.value
            setRole(contactRole(Number(value)) ?? 'all')
          }}>
            <option value="all">All roles</option>
            {Object.entries(roles).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </label>
        <label>Sort by
          <select aria-label="Sort contacts" value={sort}
            onChange={(event) => setSort(event.currentTarget.value as ContactSort)}>
            <option value="name">Name</option>
            <option value="heard">Last heard</option>
            <option value="message">Latest message</option>
          </select>
        </label>
        <label className="contact-checkbox"><input type="checkbox" checked={favorites}
          onChange={(event) => setFavorites(event.currentTarget.checked)} /> Favorites only</label>
      </div>
      <div className="contact-actions">
        <button type="button" disabled={!visited.length} onClick={() => setSelected((previous) => (
          new Set([...previous, ...visited.map((contact) => contact.publicKey)])
        ))}>Select filtered</button>
        <button type="button" disabled={!picked.length} onClick={() => setSelected(new Set())}>Clear selection</button>
        <button type="button" disabled={!picked.length} onClick={() => exportContacts(picked)}>Export selected</button>
        <button type="button" disabled={!picked.length || busy || !canWrite}
          onClick={() => void remove(picked)}>Remove selected</button>
        <p className="contact-meta">{visited.length} matching · {picked.length} selected</p>
      </div>
      <p className="contact-status" role="status">{status}</p>
      <div className="contact-layout">
        <ul className="contact-list" aria-label="Matching contacts">
          {visited.map((contact) => (
            <li key={contact.publicKey}>
              <input type="checkbox" aria-label={`Select ${contactLabel(contact)}`}
                checked={selected.has(contact.publicKey)} onChange={() => toggle(contact.publicKey)} />
              <button type="button" aria-pressed={detailKey === contact.publicKey}
                onClick={() => setDetailKey(contact.publicKey)}>
                <strong>{contact.displayName}</strong>
                <span className="contact-meta">{roleLabel(contact.details?.type)} · {advertAge(contact.details?.lastAdvertisedAt)}
                  {contact.favorite ? ' · Favorite' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
        {detail ? (
          <ContactDetails contact={detail} busy={busy} canWrite={canWrite} location={location} locate={locate}
            onMap={onMap} onShare={onShare} copyKey={copyKey} edit={edit} remove={() => void remove([detail])}
            radioControls={detail.details && <ContactRadioActions key={detail.publicKey} session={session}
              contact={detail} contacts={entries} radioKey={radioKey} ready={canWrite} usb={usb}
              firmware={firmware} busy={busy || radioBusy} />} />
        ) : <p className="contact-note">{visited.length ? 'Select a contact to see details.' : 'No contacts match.'}</p>}
      </div>
      {canWrite ? (
        <details className="contact-new">
          <summary>Add a contact</summary>
          <form className="contact-actions" onSubmit={(event) => void add(event)}>
            <label>Public key<input name="publicKey" required autoComplete="off" /></label>
            <label>Radio contact name<input name="name" required /></label>
            <label>Node role
              <select name="role" defaultValue="1">
                {Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy}>Add to radio</button>
          </form>
        </details>
      ) : <p className="contact-meta">Connect to the selected radio to add or remove radio contacts.</p>}
    </>
  )
}

function contactLabel(contact: ContactEntry) {
  return `${contact.displayName} (${contact.publicKey.slice(0, 8)})`
}

function ContactDetails({
  contact, busy, canWrite, location, locate, onMap, onShare, copyKey, edit, remove, radioControls,
}: {
  contact: ContactEntry; busy: boolean; canWrite: boolean; location: Coordinates | null
  locate: () => void; onMap: ContactsProps['onMap']; copyKey: (key: string) => Promise<void>
  onShare?: ContactsProps['onShare']
  edit: (change: ContactPreferenceEdit, success: string) => Promise<void>; remove: () => void
  radioControls: ReactNode
}) {
  const position = contactPosition(contact.details)
  const shareLink = contactShareLink(contact.name, contact.publicKey, contact.details?.type)
  const lastHeard = contact.details?.lastAdvertisedAt
  return (
    <section className="contact-details" aria-labelledby="contact-detail-heading">
      <h2 id="contact-detail-heading">{contact.displayName}</h2>
      <dl>
        <dt>Role</dt><dd>{roleLabel(contact.details?.type)}</dd>
        <dt>Public key</dt><dd><code>{contact.publicKey}</code></dd>
        <dt>Route</dt><dd>{contactRoute(contact.details)}</dd>
        <dt>Last advert</dt><dd>{lastHeard ? `${dates.format(lastHeard * 1_000)} · ${advertAge(lastHeard)}` : 'Never heard'}</dd>
        <dt>Latest message</dt><dd>{contact.latestMessage === null ? 'No saved message' : dates.format(contact.latestMessage)}</dd>
        <dt>Position</dt><dd>{position ? `${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}` : 'Unavailable'}</dd>
        {position && location && <>
          <dt>Distance</dt><dd>{(distanceBetween(location, position) / 1_000).toFixed(1)} km from my location</dd>
        </>}
      </dl>
      <form key={`${contact.publicKey}:${contact.customName}`} className="contact-actions"
        onSubmit={(event) => {
          event.preventDefault()
          const customName = String(new FormData(event.currentTarget).get('customName')).trim()
          void edit({ publicKey: contact.publicKey, customName: customName || null }, 'Local name saved.')
        }}>
        <label>Local name<input name="customName" defaultValue={contact.customName ?? ''} maxLength={120} /></label>
        <button type="submit" disabled={busy}>Save name</button>
      </form>
      <div className="contact-actions">
        <button type="button" disabled={busy} onClick={() => void edit({
          publicKey: contact.publicKey, favorite: !contact.favorite,
        }, 'Favorite updated.')}>{contact.favorite ? 'Remove favorite' : 'Add favorite'}</button>
        <button type="button" onClick={() => void copyKey(contact.publicKey)}>Copy public key</button>
        <button type="button" onClick={() => exportContacts([contact])}>Export contact</button>
        {shareLink && onShare && <button type="button" onClick={() => onShare(shareLink)}>Share contact link or QR code</button>}
        {position && <button type="button" onClick={locate}>Show distance</button>}
        {mapPosition(position) && <>
          <button type="button" onClick={() => onMap(position, false)}>Show on map</button>
          {contact.details?.type === 2 && <button type="button" onClick={() => onMap(position, true)}>Use in terrain tools</button>}
        </>}
        <button type="button" disabled={busy || !canWrite} onClick={remove}>Remove contact</button>
      </div>
      {radioControls}
    </section>
  )
}
