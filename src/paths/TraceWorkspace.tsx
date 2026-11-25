import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { MapNode, NodeRole } from '../map/nodes.ts'
import type { CompanionSession, CompanionSnapshot } from '../radio/companion-session.ts'
import { contactPingWidth, parseTracePath } from '../radio/contact-ping.ts'
import type { PathTraceResult, TraceHashWidth } from '../radio/contact-ping.ts'
import { PathDetails } from './PathDetails.tsx'
import { resolvePath } from './model.ts'
import type { MapPath, PathNode } from './model.ts'

type Props = {
  active: boolean
  snapshot: CompanionSnapshot
  session: Pick<CompanionSession, 'tracePath'>
  nodes: readonly (PathNode & { role: NodeRole | null })[]
  mapSelection: readonly MapNode[]
  mapRequest: number
  onMap: (path: MapPath) => void
}

export function TraceWorkspace({ active, snapshot, session, nodes, mapSelection, mapRequest, onMap }: Props) {
  const firmware = snapshot.device?.capabilities.firmwareProtocolVersion ?? 0
  const [width, setWidth] = useState<TraceHashWidth>(2)
  const [text, setText] = useState('')
  const [selectedRepeater, setSelectedRepeater] = useState('')
  const [source, setSource] = useState<'manual' | 'map'>(mapRequest ? 'map' : 'manual')
  const [knownMapRequest, setKnownMapRequest] = useState(mapRequest)
  const [audibleFor, setAudibleFor] = useState<{ radioKey: string; route: string; width: TraceHashWidth } | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ trace: PathTraceResult; width: number } | null>(null)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const selectedWidth = contactPingWidth(firmware, width) || !snapshot.device ? width : 1
  const route = source === 'map' ? mapSelection.map(({ publicKey }) => publicKey.slice(0, selectedWidth * 2)).join(',') : text
  const candidates = [...nodes, ...mapSelection]
  const repeaters = [...new Map(candidates.filter(({ role }) => role === 2).map((node) => [node.publicKey, node])).values()]
  const ready = snapshot.phase === 'ready' && snapshot.transport === 'usb' && snapshot.device
  const audible = Boolean(ready && audibleFor?.radioKey === ready.publicKey &&
    audibleFor.route === route && audibleFor.width === selectedWidth)
  const resolved = route.trim() ? resolvePath(readValidHashes(route, selectedWidth), candidates) : []
  const collisions = resolved.filter(({ matches, hash }) => matches.length > 1 || snapshot.device?.publicKey.startsWith(hash))

  if (mapRequest !== knownMapRequest) {
    setKnownMapRequest(mapRequest)
    setSource('map')
    setAudibleFor(null)
  }

  useEffect(() => {
    if (!active) pending.current?.abort(new Error('Stopped waiting for the trace when leaving Diagnostics.'))
    return () => pending.current?.abort(new Error('Stopped waiting for the trace.'))
  }, [active])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || !audible || running || collisions.length) return
    setError('')
    setResult(null)
    setAudibleFor(null)
    const controller = new AbortController()
    try {
      parseTracePath(route, selectedWidth)
      pending.current = controller
      setRunning(true)
      setResult({ trace: await session.tracePath(ready.publicKey, route, selectedWidth, controller.signal), width: selectedWidth })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The trace failed.')
    } finally {
      if (pending.current === controller) pending.current = null
      setRunning(false)
    }
  }

  return <section className="trace-workspace" aria-labelledby="trace-heading">
    <h2 id="trace-heading">Path tracing</h2>
    <p>Send a trace through the repeaters in order. The final repeater must be directly audible so it can return the result.</p>
    {!ready && <p>Connect a companion over USB and finish syncing to send a trace.</p>}
    <form onSubmit={(event) => void start(event)}>
      <fieldset disabled={running}>
        <legend>Trace route</legend>
        <label>Route source
          <select value={source} onChange={(event) => {
            setSource(event.currentTarget.value === 'map' ? 'map' : 'manual')
            setAudibleFor(null)
          }}>
            <option value="manual">Manual entry</option>
            <option value="map" disabled={!mapSelection.length}>Repeaters selected on map</option>
          </select>
        </label>
        <label>Trace hash width
          <select value={selectedWidth} onChange={(event) => {
            const value = Number(event.currentTarget.value)
            if (value === 1 || value === 2 || value === 4) setWidth(value)
          }}>
            <option value="1">1 byte</option>
            {(!snapshot.device || firmware >= 10) && <><option value="2">2 bytes</option><option value="4">4 bytes</option></>}
          </select>
        </label>
        {source === 'map' ? <ol aria-label="Map repeaters to trace">
          {mapSelection.map((node, index) => <li key={index}>{node.name} · <code>{node.publicKey.slice(0, selectedWidth * 2)}</code></li>)}
        </ol> : <>
          <label>Repeater hashes in order
            <textarea rows={2} value={text} onChange={(event) => setText(event.currentTarget.value)} />
          </label>
          <div className="path-actions">
            <label>Repeater to append to trace
              <select value={selectedRepeater} onChange={(event) => setSelectedRepeater(event.currentTarget.value)}>
                <option value="">Select a repeater</option>
                {repeaters.map(({ publicKey, name }) => <option key={publicKey} value={publicKey}>
                  {name} ({publicKey.slice(0, selectedWidth * 2)})
                </option>)}
              </select>
            </label>
            <button type="button" disabled={!selectedRepeater} onClick={() => {
              setText((current) => [current.trim(), selectedRepeater.slice(0, selectedWidth * 2)].filter(Boolean).join(','))
              setSelectedRepeater('')
            }}>Append to trace</button>
          </div>
        </>}
        {collisions.length > 0 && <p role="alert">These hashes match multiple known nodes or the connected radio:
          {' '}{collisions.map(({ hash }) => hash).join(', ')}. Choose wider hashes or a different route.</p>}
        <label className="trace-audible">
          <input type="checkbox" checked={audible} disabled={!ready}
            onChange={(event) => setAudibleFor(event.currentTarget.checked && ready
              ? { radioKey: ready.publicKey, route, width: selectedWidth } : null)} />
          I can hear the final repeater directly
        </label>
        <div className="path-actions">
          <button type="submit" disabled={!ready || !route.trim() || !audible || collisions.length > 0}>Send trace</button>
          <button type="button" onClick={() => {
            setSource('manual')
            setText('')
            setAudibleFor(null)
            setResult(null)
            setError('')
            setSelectedRepeater('')
          }}>Reset trace</button>
        </div>
      </fieldset>
    </form>
    {running && <div className="path-actions">
      <p role="status">Waiting for a trace reply…</p>
      <button type="button" onClick={() => pending.current?.abort(new Error('Stopped waiting. A sent trace cannot be recalled.'))}>
        Stop waiting
      </button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {result && <section aria-label="Trace result">
      <h3>Trace result</h3>
      <p>Reply in {result.trace.elapsedMs} ms · Return SNR {result.trace.returnSnrDb} dB</p>
      <PathDetails title="Trace" width={result.width} hashes={result.trace.hops.map(({ hash }) => hash)}
        snr={result.trace.hops.map(({ snrDb }) => snrDb)} nodes={candidates} onMap={onMap} />
    </section>}
  </section>
}

function readValidHashes(text: string, width: TraceHashWidth) {
  try { return parseTracePath(text, width) } catch { return [] }
}
