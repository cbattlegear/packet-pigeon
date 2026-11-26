import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { roles } from '../map/nodes.ts'
import type { CompanionSession } from '../radio/index.ts'
import { advertCachePrefixLength } from '../radio/discovery-commands.ts'
import type { AutoAddPolicy } from '../radio/discovery-commands.ts'
import type { RadioKey, StoredContact } from '../storage/index.ts'
import { discoveryPosition, exportDiscoveries, filterDiscoveries, importDiscoveries } from './model.ts'
import type { DiscoveryEntry } from './model.ts'
import type { useRadioDiscoveries } from './use-radio-discoveries.ts'
import { PathDetails } from '../paths/PathDetails.tsx'
import type { MapPath, PathNode } from '../paths/model.ts'
import { contactPosition } from '../contacts/model.ts'
import '../contacts/contacts.css'

type View = ReturnType<typeof useRadioDiscoveries>
type DiscoveryProps = {
  view: View
  entries: DiscoveryEntry[]
  radioContacts: readonly StoredContact[]
  connected: boolean
  ready: boolean
  usb: boolean
  pending: number
  session: CompanionSession
  openMap: () => void
  onPathMap?: (path: MapPath) => void
  mapPathNodes?: readonly PathNode[]
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Discovery action did not finish.'
}

function download(entries: DiscoveryEntry[]) {
  const address = URL.createObjectURL(new Blob([exportDiscoveries(entries)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = address
  link.download = 'packet-pigeon-discovery.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(address), 1_000)
}

function nameForRadio(entry: DiscoveryEntry) {
  const encoder = new TextEncoder()
  let name = ''
  for (const character of entry.displayName.replaceAll('\0', '').trim()) {
    if (encoder.encode(name + character).length > 31) break
    name += character
  }
  return name || `Node ${entry.publicKey.slice(0, 8)}`
}

export function DiscoveryPanel(props: DiscoveryProps) {
  const { view, connected, openMap } = props
  return (
    <div className="contact-workspace">
      <div className="contact-actions">
        <button type="button" onClick={openMap}>Show discovered nodes on map</button>
        {!connected && <label>Cached radio
          <select aria-label="Discovery cache radio" value={view.key ?? ''} onChange={(event) => view.choose(event.currentTarget.value)}>
            <option value="">Select a saved radio</option>
            {view.keys.map((key) => <option key={key} value={key}>{key}</option>)}
          </select>
        </label>}
      </div>
      {view.error && <div className="contact-note" role="alert">
        <p>{view.error}</p><button type="button" onClick={view.refresh}>Retry loading discovery history</button>
      </div>}
      {view.key ? <DiscoveryBrowser key={view.key} {...props} radioKey={view.key} />
        : <p className="contact-note">Connect a radio or choose a saved radio to browse its discovery history.</p>}
    </div>
  )
}

function DiscoveryBrowser({
  radioKey, view, entries, radioContacts, ready, usb, pending, session, onPathMap, mapPathNodes = [],
}: DiscoveryProps & { radioKey: RadioKey }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState(0)
  const [width, setWidth] = useState(0)
  const [sort, setSort] = useState<'recent' | 'hops'>('recent')
  const [includeAdded, setIncludeAdded] = useState(false)
  const [selected, setSelected] = useState(() => new Set<string>())
  const [detailKey, setDetailKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [policy, setPolicy] = useState<AutoAddPolicy | null>(null)
  const matches = filterDiscoveries(entries, { query, role, width, sort, includeAdded })
  const picked = entries.filter((entry) => selected.has(entry.publicKey))
  const detail = entries.find((entry) => entry.publicKey === detailKey)

  async function act(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setStatus('')
    try {
      await action()
    } catch (error) {
      setStatus(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function add(entries: DiscoveryEntry[]) {
    let done = 0
    try {
      for (const entry of entries) {
        if (!entry.role) continue
        const point = discoveryPosition(entry)
        await session.addContact(radioKey, {
          publicKey: entry.publicKey, name: nameForRadio(entry), type: entry.role,
          ...(point ? { position: { latitude: point.lat, longitude: point.lon } } : {}),
        })
        done++
      }
      setSelected(new Set())
      setStatus(`Added ${done} contacts to the radio.`)
    } catch (error) {
      setStatus(`Added ${done} before stopping. ${errorMessage(error)}`)
    }
  }

  async function paths(entries: DiscoveryEntry[]) {
    let loaded = 0
    let skipped = 0
    const keys = new Set([...radioContacts, ...(view.data?.contacts ?? []), ...(view.data?.discoveries ?? [])]
      .map(({ publicKey }) => publicKey))
    for (const record of entries) {
      const prefix = record.publicKey.slice(0, advertCachePrefixLength)
      if ([...keys].some((key) => key !== record.publicKey && key.startsWith(prefix))) {
        skipped++
        continue
      }
      const path = await session.advertPath(radioKey, record.publicKey)
      if (path) {
        await view.update(radioKey, { upsert: [{ publicKey: record.publicKey, heardAt: record.heardAt, path }] })
        loaded++
      }
    }
    setStatus(`Loaded ${loaded} paths from the radio cache.${skipped ? ` Skipped ${skipped} with ambiguous key prefixes.` : ''}`)
  }

  function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    void act(async () => {
      if (file.size > 1_000_000) throw new Error('Choose a discovery file under 1 MB.')
      const entries = importDiscoveries(JSON.parse(await file.text()))
      await view.update(radioKey, { upsert: entries })
      setStatus(`Imported ${entries.length} adverts.`)
    })
  }

  function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!policy || !ready) return
    const data = new FormData(event.currentTarget)
    const overwrite = data.has('overwrite')
    if (overwrite && !(policy.flags & 1)
      && !window.confirm('Allow the radio to replace its oldest non-favorite contact when full?')) return
    const flags = Number(overwrite) | [1, 2, 3, 4].reduce((bits, role) => (
      data.has(`role-${role}`) ? bits | (1 << role) : bits
    ), 0)
    const max = data.get('maxHops')
    void act(async () => {
      const saved = await session.setAutoAdd(radioKey, {
        flags, selectedRoles: data.has('selectedRoles'), ...(max === null ? {} : { maxHops: max === '' ? null : Number(max) }),
      })
      setPolicy(saved)
      setStatus('Radio auto-add policy saved.')
    })
  }

  const addable = picked.filter((entry) => !entry.alreadyAdded && entry.role)
  return (
    <>
      <p>Connect over USB to record live adverts and read paths from the radio. Saved discovery history is available while connected over Bluetooth or disconnected.</p>
      <div className="contact-filters">
        <label>Search discovered nodes
          <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>Role<select aria-label="Discovery role" value={role} onChange={(event) => setRole(Number(event.currentTarget.value))}>
          <option value={0}>All roles</option>
          {Object.entries(roles).map(([number, label]) => <option key={number} value={number}>{label}</option>)}
        </select></label>
        <label>Path hash width
          <select aria-label="Path hash width" value={width} onChange={(event) => setWidth(Number(event.currentTarget.value))}>
            <option value={0}>Any width</option>
            {[1, 2, 3].map((size) => <option key={size} value={size}>{size} bytes</option>)}
          </select>
        </label>
        <label>Sort
          <select aria-label="Sort discovered nodes" value={sort} onChange={(event) => setSort(event.currentTarget.value === 'hops' ? 'hops' : 'recent')}>
            <option value="recent">Most recently heard</option><option value="hops">Fewest hops</option>
          </select>
        </label>
        <label className="contact-checkbox">
          <input type="checkbox" checked={includeAdded} onChange={(event) => setIncludeAdded(event.currentTarget.checked)} />
          Include already-added contacts
        </label>
      </div>
      <div className="contact-actions">
        <button type="button" disabled={!matches.length} onClick={() => setSelected(new Set(matches.map((entry) => entry.publicKey)))}>
          Select filtered
        </button>
        <button type="button" disabled={!picked.length} onClick={() => setSelected(new Set())}>Clear selection</button>
        <button type="button" disabled={!picked.length} onClick={() => download(picked)}>Export selected adverts</button>
        <button type="button" disabled={!ready || busy || !addable.length} onClick={() => void act(() => add(addable))}>Add selected to radio</button>
        <button type="button" disabled={!ready || !usb || busy || !picked.length} onClick={() => void act(() => paths(picked))}>Load selected paths</button>
        <button type="button" disabled={busy || pending > 0 || !picked.length} onClick={() => void act(async () => {
          await view.update(radioKey, { remove: picked.map(({ publicKey }) => publicKey) })
          setSelected(new Set())
          setStatus(`Forgot ${picked.length} local adverts.`)
        })}>Forget selected adverts</button>
        <button type="button" disabled={!ready || busy} onClick={() => void act(async () => {
          await session.refreshContacts(radioKey)
          setStatus('Radio contact list refreshed.')
        })}>Refresh radio contacts</button>
        <p className="contact-meta">{matches.length} matching · {picked.length} selected</p>
      </div>
      <p className="contact-status" role="status">{status}</p>
      <div className="contact-layout">
        <ul className="contact-list" aria-label="Discovered adverts">
          {matches.map((entry) => <li key={entry.publicKey}>
            <input type="checkbox" aria-label={`Select ${entry.displayName} (${entry.publicKey.slice(0, 8)})`}
              checked={selected.has(entry.publicKey)} onChange={(event) => {
                const checked = event.currentTarget.checked
                setSelected((previous) => {
                  const next = new Set(previous)
                  if (checked) next.add(entry.publicKey)
                  else next.delete(entry.publicKey)
                  return next
                })
              }} />
            <button type="button" aria-pressed={entry.publicKey === detailKey} onClick={() => setDetailKey(entry.publicKey)}>
              <strong>{entry.displayName}</strong>
              <span className="contact-meta">{entry.role ? roles[entry.role] : 'Unknown role'} · {new Date(entry.heardAt).toLocaleString()}
                {entry.alreadyAdded ? ' · Already added' : ''}</span>
            </button>
          </li>)}
        </ul>
        {detail ? (
          <section className="contact-details" aria-label="Advert details">
            <h2>{detail.displayName}</h2>
            <dl>
              <dt>Public key</dt><dd><code>{detail.publicKey}</code></dd>
              {!detail.path && <><dt>Radio path</dt><dd>Path unavailable</dd></>}
              {detail.path && <>
                <dt>Path received</dt><dd>{new Date(detail.path.receivedAt).toLocaleString()}</dd>
              </>}
            </dl>
            {detail.path && <PathDetails title="Advert path" width={detail.path.width}
              hashes={detail.path.hex.match(new RegExp(`.{${detail.path.width * 2}}`, 'g')) ?? []}
              nodes={[...entries.map((entry) => ({
                publicKey: entry.publicKey, name: entry.displayName, position: discoveryPosition(entry),
              })), ...(ready ? radioContacts : view.data?.contacts ?? []).map((entry) => ({
                publicKey: entry.publicKey, name: entry.name, position: contactPosition(entry.details),
              })), ...mapPathNodes]} onMap={onPathMap} />}
            <div className="contact-actions">
              <button type="button" disabled={!ready || !usb || busy} onClick={() => void act(() => paths([detail]))}>Load advert path</button>
              <button type="button" disabled={!ready || busy || detail.alreadyAdded || !detail.role}
                onClick={() => void act(() => add([detail]))}>Add discovered node</button>
            </div>
          </section>
        ) : <p className="contact-note">{matches.length ? 'Select an advert to see its path.' : 'No matching adverts.'}</p>}
      </div>
      <div className="contact-actions">
        <label>Import discovery JSON<input type="file" accept=".json,application/json" disabled={busy} onChange={loadFile} /></label>
      </div>
      <details className="contact-new">
        <summary>Radio auto-add policy</summary>
        <button type="button" disabled={!ready || busy} onClick={() => void act(async () => {
          setPolicy(await session.getAutoAdd(radioKey))
          setStatus('Radio auto-add policy loaded.')
        })}>Read auto-add policy</button>
        {policy && (
          <form key={JSON.stringify(policy)} onSubmit={savePolicy}>
            <fieldset disabled={!ready || busy}>
              <legend>Auto-add controls</legend>
              <label className="contact-checkbox">
                <input type="checkbox" name="selectedRoles" defaultChecked={policy.selectedRoles} /> Auto-add selected roles only
              </label>
              {Object.entries(roles).map(([role, label]) => <label key={role} className="contact-checkbox">
                <input type="checkbox" name={`role-${role}`} defaultChecked={Boolean(policy.flags & (1 << Number(role)))} /> {label}
              </label>)}
              <label className="contact-checkbox">
                <input type="checkbox" name="overwrite" defaultChecked={Boolean(policy.flags & 1)} /> Overwrite oldest non-favorite when full
              </label>
              {policy.maxHops !== undefined && <label>Maximum hops (blank means unlimited)
                <input type="number" min={0} max={63} step={1} name="maxHops" defaultValue={policy.maxHops ?? ''} />
              </label>}
              <button type="submit">Save auto-add policy</button>
            </fieldset>
          </form>
        )}
      </details>
    </>
  )
}
