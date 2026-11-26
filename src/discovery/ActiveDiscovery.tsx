import { useEffect, useRef, useState } from 'react'
import { roles } from '../map/nodes.ts'
import type { CompanionSession } from '../radio/index.ts'
import { decodeContactPath } from '../radio/contact-path.ts'
import { nearbyWindowMs } from '../radio/discovery-commands.ts'
import type { NearbyNode, RepeaterDetails } from '../radio/discovery-commands.ts'
import type { StoredContact } from '../storage/index.ts'
import type { DiscoveryEntry } from './model.ts'
import './discovery.css'

type Props = {
  radioKey: string
  active: boolean
  ready: boolean
  usb: boolean
  firmware: number
  session: Pick<CompanionSession, 'discoverNearby' | 'discoverRepeaterDetails'>
  entries: readonly DiscoveryEntry[]
  radioContacts: readonly StoredContact[]
}

type Activity = { kind: 'nearby' | RepeaterDetails['kind']; phase: 'sending' | 'waiting' | 'stopping' }
type Details = { regions?: string[]; owner?: { name: string; owner: string } }

export function ActiveDiscovery({ radioKey, active, ready, usb, firmware, session, entries, radioContacts }: Props) {
  const [activity, setActivity] = useState<Activity | null>(null)
  const [nodes, setNodes] = useState<NearbyNode[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [details, setDetails] = useState<Record<string, Details>>({})
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const supported = active && ready && usb && firmware >= 8
  const selected = nodes.find(({ publicKey }) => publicKey === selectedKey)
  const contact = radioContacts.find(({ publicKey }) => publicKey === selectedKey)
  const path = contact?.details && decodeContactPath(contact.details.pathLength, contact.details.pathHex)
  const canRequestDetails = selected?.type === 2 && contact?.details?.type === 2 && path?.hops.length === 0

  useEffect(() => {
    if (!active || !ready || !usb) {
      pending.current?.abort(new Error('Stopped discovery after leaving the workspace or disconnecting.'))
    }
    return () => pending.current?.abort(new Error('Stopped discovery after leaving the workspace or disconnecting.'))
  }, [active, ready, usb, radioKey])

  function displayName(node: NearbyNode) {
    const saved = radioContacts.find(({ publicKey }) => publicKey === node.publicKey)
    const advert = entries.find(({ publicKey }) => publicKey === node.publicKey)
    return saved?.name || advert?.displayName || `Node ${node.publicKey.slice(0, 8)}`
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
    if (!supported || !selected || !canRequestDetails || pending.current) return
    const key = selected.publicKey
    const controller = new AbortController()
    pending.current = controller
    setActivity({ kind, phase: 'sending' })
    setStatus('')
    setError('')
    try {
      const result = await session.discoverRepeaterDetails(radioKey, key, kind, controller.signal,
        () => setActivity({ kind, phase: 'waiting' }))
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

  const info = selected && details[selected.publicKey]
  return <section className="contact-new" aria-labelledby="nearby-heading">
    <h2 id="nearby-heading">Nearby nodes and regions</h2>
    <p>Send a zero-hop discovery broadcast to nearby nodes. Replies are not signed; names below are
      local contact or advert matches, not verified identities. Nothing is sent until you choose an action.</p>
    {!ready ? <p>Connect a radio and finish syncing to discover nearby nodes.</p>
      : !usb ? <p>Connect over USB for active discovery; Bluetooth framing is not yet supported.</p>
        : firmware < 8 ? <p>Active discovery requires companion protocol v8 or newer.</p> : null}
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
            : 'Waiting for the repeater reply (up to 30 seconds); other radio actions must wait…'
        : status}
    </p>
    {error && <p role="alert">{error}</p>}
    {nodes.length > 0 && <>
      <p className="contact-meta">{nodes.length === 200
        ? 'Showing the first 200 responding nodes.' : `${nodes.length} responding nodes.`}</p>
      <div className="contact-layout">
        <ul className="nearby-list" aria-label="Nearby discovery results">
          {nodes.map((node) => <li key={node.publicKey}>
            <button type="button" aria-pressed={node.publicKey === selectedKey} onClick={() => setSelectedKey(node.publicKey)}>
              <strong>{displayName(node)}</strong>
              <span className="contact-meta">{roles[node.type]} · {node.publicKey.slice(0, 12)}</span>
            </button>
          </li>)}
        </ul>
        {selected ? <section className="contact-details" aria-label="Nearby node details">
          <h3>{displayName(selected)}</h3>
          <dl>
            <dt>Public key</dt><dd><code>{selected.publicKey}</code></dd>
            <dt>Type reported</dt><dd>{roles[selected.type]}</dd>
            <dt>Request SNR at node</dt><dd>{selected.outboundSnrDb} dB</dd>
            <dt>Reply SNR at radio</dt><dd>{selected.inboundSnrDb} dB</dd>
            <dt>Reply RSSI at radio</dt><dd>{selected.rssiDbm} dBm</dd>
          </dl>
          {selected.type === 2 && <>
            <p>Region and owner requests each transmit separately. They require a saved repeater with a zero-hop
              radio path, checked immediately before sending. This tool does not change paths, but firmware may
              re-add a contact removed during the request. Other radio actions, including noise-floor polling,
              are unavailable while waiting. Some firmware may not support these requests.</p>
            {!canRequestDetails && <p>Save this repeater in Contacts and set its radio path to zero hop before requesting details.</p>}
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
        </section> : <p className="contact-note">Select a nearby node to inspect its reply.</p>}
      </div>
    </>}
  </section>
}
