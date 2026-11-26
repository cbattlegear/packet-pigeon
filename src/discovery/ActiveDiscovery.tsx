import { useEffect, useRef, useState } from 'react'
import { roles } from '../map/nodes.ts'
import type { CompanionSession } from '../radio/index.ts'
import { decodeContactPath } from '../radio/contact-path.ts'
import type { ContactPathWidth } from '../radio/contact-path.ts'
import { nearbyWindowMs } from '../radio/discovery-commands.ts'
import type { NearbyNode, RepeaterDetails, RepeaterRequestOptions } from '../radio/discovery-commands.ts'
import type { StoredContact } from '../storage/index.ts'
import type { DiscoveryEntry } from './model.ts'
import './discovery.css'

type Props = {
  radioKey: string
  active: boolean
  ready: boolean
  framed: boolean
  firmware: number
  session: Pick<CompanionSession, 'discoverNearby' | 'discoverRepeaterDetails'>
  entries: readonly DiscoveryEntry[]
  radioContacts: readonly StoredContact[]
}

type Activity = { kind: 'nearby' | RepeaterDetails['kind']; phase: 'sending' | 'waiting' | 'stopping' }
type Details = { regions?: string[]; owner?: { name: string; owner: string } }

export function ActiveDiscovery({ radioKey, active, ready, framed, firmware, session, entries, radioContacts }: Props) {
  const [activity, setActivity] = useState<Activity | null>(null)
  const [nodes, setNodes] = useState<NearbyNode[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [expectedRoute, setExpectedRoute] = useState<RepeaterRequestOptions['expectedRoute']>(null)
  const [replyPath, setReplyPath] = useState('')
  const [replyWidth, setReplyWidth] = useState<ContactPathWidth>(1)
  const [details, setDetails] = useState<Record<string, Details>>({})
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const supported = active && ready && firmware >= 8
  const selected = nodes.find(({ publicKey }) => publicKey === selectedKey)
  const contact = radioContacts.find(({ publicKey }) => publicKey === selectedKey)
  const path = contact?.details && decodeContactPath(contact.details.pathLength, contact.details.pathHex)
  const savedRepeater = contact?.details?.type === 2
  const selectedPath = expectedRoute && decodeContactPath(expectedRoute.pathLength, expectedRoute.pathHex)
  const routeChanged = Boolean(savedRepeater && path && (!selectedPath || selectedPath.width !== path.width
    || selectedPath.hops.join('') !== path.hops.join('')))
  const target = selected ?? (savedRepeater && contact ? { publicKey: contact.publicKey, type: 2 as const } : undefined)
  const unsavedRepeater = target?.type === 2 && !savedRepeater && (!contact || contact.details?.type === 0)
  const canRequestDetails = Boolean((savedRepeater && path && !routeChanged && (path.width === 1 || firmware >= 10))
    || (unsavedRepeater && firmware >= 13 && (!contact || path?.hops.length === 0)))
  const savedRepeaters = radioContacts.filter(({ publicKey, details }) => details?.type === 2 && publicKey !== radioKey)

  useEffect(() => {
    if (!active || !ready) {
      pending.current?.abort(new Error('Stopped discovery after leaving the workspace or disconnecting.'))
    }
    return () => pending.current?.abort(new Error('Stopped discovery after leaving the workspace or disconnecting.'))
  }, [active, ready, framed, radioKey])

  function displayName(node: Pick<NearbyNode, 'publicKey'>) {
    const saved = radioContacts.find(({ publicKey }) => publicKey === node.publicKey)
    const advert = entries.find(({ publicKey }) => publicKey === node.publicKey)
    return saved?.name || advert?.displayName || `Node ${node.publicKey.slice(0, 8)}`
  }

  function selectTarget(key: string) {
    const saved = radioContacts.find(({ publicKey }) => publicKey === key)?.details
    const route = saved && decodeContactPath(saved.pathLength, saved.pathHex)
    setSelectedKey(key)
    setExpectedRoute(saved?.type === 2 ? { pathLength: saved.pathLength, pathHex: saved.pathHex } : null)
    setReplyWidth(route?.width ?? 1)
    setReplyPath(route?.hops.slice().reverse().join(' ') ?? '')
  }

  function stop() {
    if (!pending.current) return
    setActivity((current) => current && { ...current, phase: 'stopping' })
    pending.current.abort(new Error('Stopped waiting. A transmitted request cannot be recalled.'))
  }

  async function startScan() {
    if (!supported || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setActivity({ kind: 'nearby', phase: 'sending' })
    setNodes([])
    setSelectedKey('')
    setExpectedRoute(null)
    setDetails({})
    setStatus('')
    setError('')
    try {
      await session.discoverNearby(radioKey, controller.signal, (node) => {
        setNodes((current) => {
          const index = current.findIndex(({ publicKey }) => publicKey === node.publicKey)
          if (index >= 0) return current.map((item, position) => position === index ? node : item)
          return current.length < 200 ? [...current, node] : current
        })
      }, () => setActivity({ kind: 'nearby', phase: 'waiting' }))
      setStatus('The listening window ended. Nodes that did not respond are not shown.')
    } catch (reason) {
      if (controller.signal.aborted) setStatus('Stopped waiting. A transmitted request cannot be recalled.')
      else setError(reason instanceof Error ? reason.message : 'Nearby discovery failed.')
    } finally {
      if (pending.current === controller) pending.current = null
      setActivity(null)
    }
  }

  async function requestDetails(kind: RepeaterDetails['kind']) {
    if (!supported || !target || !canRequestDetails || pending.current) return
    if (unsavedRepeater && !window.confirm(
      'This request will transmit and may create or replace a temporary contact on the radio. Some firmware shows that contact in the normal list. Continue?',
    )) return
    const key = target.publicKey
    const controller = new AbortController()
    pending.current = controller
    setActivity({ kind, phase: 'sending' })
    setStatus('')
    setError('')
    try {
      const result = await session.discoverRepeaterDetails(radioKey, key, kind, controller.signal,
        () => setActivity({ kind, phase: 'waiting' }), {
          expectedRoute: unsavedRepeater ? null : expectedRoute,
          replyPath: unsavedRepeater ? { width: 1, text: '' } : { width: replyWidth, text: replyPath },
        })
      setDetails((current) => ({
        ...current,
        [key]: {
          ...current[key],
          ...(result.kind === 'regions'
            ? { regions: result.regions }
            : { owner: { name: result.name, owner: result.owner } }),
        },
      }))
      setStatus(kind === 'regions' ? 'Region reply received.' : 'Owner information received.')
    } catch (reason) {
      if (controller.signal.aborted) setStatus('Stopped waiting. A transmitted request cannot be recalled.')
      else setError(reason instanceof Error ? reason.message : 'The repeater request failed.')
    } finally {
      if (pending.current === controller) pending.current = null
      setActivity(null)
    }
  }

  const info = target && details[target.publicKey]
  return <section className="contact-new" aria-labelledby="nearby-heading">
    <h2 id="nearby-heading">Nearby nodes and regions</h2>
    <p>Send a zero-hop discovery broadcast to nearby nodes. The companion cannot broadcast a multi-hop scan.
      Replies are not signed; names below are local contact or advert matches, not verified identities.
      Nothing is sent until you choose an action.</p>
    {!ready ? <p>Connect a radio and finish syncing to discover nearby nodes.</p>
      : firmware < 8 ? <p>Active discovery requires companion protocol v8 or newer.</p> : null}
    {ready && !framed && <p>Bluetooth may split or drop replies or reject longer writes.
      Results may be missing or appear complete when truncated.</p>}
    <div className="contact-actions">
      <button type="button" disabled={!supported || Boolean(activity)} onClick={() => void startScan()}>
        Send nearby discovery
      </button>
      <button type="button" disabled={!activity || activity.phase === 'stopping'} onClick={stop}>Stop waiting</button>
    </div>
    {activity && <progress aria-label="Discovery in progress" />}
    <p role="status" className="contact-status">
      {activity ? activity.phase === 'stopping' ? 'Stopping; an in-flight radio command must finish or time out.'
        : activity.phase === 'sending' ? 'Sending the requested radio command…'
          : activity.kind === 'nearby'
            ? `Listening for up to ${nearbyWindowMs / 1000} seconds · ${nodes.length} nodes found.`
            : 'Waiting for the repeater reply (up to two minutes); other radio actions must wait…'
        : status}
    </p>
    {error && <p role="alert">{error}</p>}
    <label className="discovery-field">Saved repeater
      <select value={savedRepeater ? selectedKey : ''} onChange={(event) => selectTarget(event.target.value)}>
        <option value="">Choose a saved repeater</option>
        {savedRepeaters.map((item) => <option key={item.publicKey} value={item.publicKey}>
          {item.name || item.publicKey.slice(0, 12)}
        </option>)}
      </select>
    </label>
    {nodes.length > 0 && <p className="contact-meta">{nodes.length === 200
      ? 'Showing the first 200 responding nodes.' : `${nodes.length} responding nodes.`}</p>}
    <div className={`contact-layout${nodes.length ? '' : ' discovery-details-only'}`}>
      {nodes.length > 0 && <ul className="nearby-list" aria-label="Nearby discovery results">
        {nodes.map((node) => <li key={node.publicKey}>
          <button type="button" aria-pressed={node.publicKey === selectedKey} onClick={() => selectTarget(node.publicKey)}>
            <strong>{displayName(node)}</strong>
            <span className="contact-meta">{roles[node.type]} · {node.publicKey.slice(0, 12)}</span>
          </button>
        </li>)}
      </ul>}
      {target ? <section className="contact-details" aria-label="Discovery target details">
        <h3>{displayName(target)}</h3>
        <dl>
          <dt>Public key</dt><dd><code>{target.publicKey}</code></dd>
          {selected && <>
            <dt>Type reported</dt><dd>{roles[selected.type]}</dd>
            <dt>Request SNR at node</dt><dd>{selected.outboundSnrDb} dB</dd>
            <dt>Reply SNR at radio</dt><dd>{selected.inboundSnrDb} dB</dd>
            <dt>Reply RSSI at radio</dt><dd>{selected.rssiDbm} dBm</dd>
          </>}
        </dl>
        {(savedRepeater || target.type === 2) && <>
          <p>Region and owner requests each transmit separately. Other radio actions, including noise-floor
            polling, are unavailable while waiting. Some firmware may not support these requests.</p>
          {savedRepeater && !path && <p>The saved route is unknown or invalid. Set a direct route in Contacts
            before requesting details; flood routes are not sent here.</p>}
          {routeChanged && <p>The saved route changed after selection. Use the updated route to review its reply path.
            {' '}<button type="button" onClick={() => selectTarget(selectedKey)}>Use updated route</button></p>}
          {savedRepeater && path && path.width > 1 && firmware < 10
            && <p>This firmware does not support the saved route's hash width.</p>}
          {unsavedRepeater && firmware < 13 && <p>Unsaved repeater requests require companion protocol v13
            or newer. Save it with a direct route first.</p>}
          {unsavedRepeater && firmware >= 13 && <p>The radio may create or replace a temporary contact for
            this zero-hop request. Some firmware exposes it in Contacts. Confirm before each transmission.</p>}
          {unsavedRepeater && contact && path?.hops.length !== 0 && <p>The radio's temporary contact has an
            unknown or non-zero route. Refresh Contacts before requesting details.</p>}
          {!savedRepeater && !unsavedRepeater && <p>The saved contact is not a repeater. Check Contacts
            before requesting details.</p>}
          {savedRepeater && path && path.hops.length > 0 && <>
            <p>The saved direct route sends this request through {path.hops.length} hop{path.hops.length === 1 ? '' : 's'}.
              The reply path starts as the reversed route, but routes may be asymmetric. Check it before sending.</p>
            <label className="discovery-field">Reply path hash width
              <select value={replyWidth} onChange={(event) => setReplyWidth(
                event.target.value === '2' ? 2 : event.target.value === '3' ? 3 : 1,
              )}>
                <option value={1}>1 byte</option>
                {firmware >= 10 && <><option value={2}>2 bytes</option><option value={3}>3 bytes</option></>}
              </select>
            </label>
            <label className="discovery-field">Reply path
              <input value={replyPath} onChange={(event) => setReplyPath(event.target.value)}
                spellCheck={false} aria-describedby="discovery-reply-help" />
            </label>
            <p id="discovery-reply-help" className="contact-meta">Enter hexadecimal hop hashes separated by spaces,
              or leave empty for zero-hop. Routed replies can take up to two minutes.</p>
          </>}
          <div className="contact-actions">
            <button type="button" disabled={!supported || !canRequestDetails || Boolean(activity)}
              onClick={() => void requestDetails('regions')}>Request regions</button>
            <button type="button" disabled={!supported || !canRequestDetails || Boolean(activity)}
              onClick={() => void requestDetails('owner')}>Request owner info</button>
          </div>
          {info?.regions && <div>
            <h4>Reported regions</h4>
            {info.regions.length ? <ul>{info.regions.map((region) => <li key={region}>{region === '*' ? '* (unscoped)' : region}</li>)}</ul>
              : <p>The repeater reported no regions.</p>}
            <p className="contact-meta">A reply may omit regions that did not fit in the radio packet.</p>
          </div>}
          {info?.owner && <div>
            <h4>Reported owner information</h4>
            <p>Node name: {info.owner.name || '(not supplied)'}</p>
            <p className="nearby-owner">{info.owner.owner || '(not supplied)'}</p>
          </div>}
        </>}
      </section> : <p className="contact-note">{nodes.length
        ? 'Select a nearby node or saved repeater to inspect it.'
        : 'Select a saved repeater, or send a nearby discovery broadcast to see responding nodes.'}</p>}
    </div>
  </section>
}
