import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AppPreferences } from '../preferences/appPreferences.ts'
import { clockFormatter } from '../preferences/appPreferences.ts'
import type { CompanionSession, CompanionSnapshot } from '../radio/companion-session.ts'
import { decodeRxPacket, packetHex, payloadFields, routeLabel, rxPacketHash, rxPacketPush, typeLabel } from '../radio/rx-packet.ts'
import type { CapturedPacket } from './rx-log.ts'
import { matchingChannelObservations, maxRxPackets, redactedDiagnostics } from './rx-log.ts'
import './diagnostics.css'

type Props = {
  snapshot: CompanionSnapshot
  session: Pick<CompanionSession, 'getSnapshot' | 'subscribeToPushes'>
  prefs: AppPreferences
  locale: string
}

const emptyPackets: readonly CapturedPacket[] = []

function connectedRadio(snapshot: CompanionSnapshot) {
  return snapshot.phase === 'ready' || snapshot.phase === 'syncing' ? snapshot.device?.publicKey ?? null : null
}

export function RxInspector({ snapshot, session, prefs, locale }: Props) {
  const currentKey = connectedRadio(snapshot)
  const [captureKey, setCaptureKey] = useState<string | null>(null)
  const [buffer, setBuffer] = useState<{ key: string; entries: CapturedPacket[] } | null>(null)
  const [route, setRoute] = useState('all')
  const [type, setType] = useState('all')
  const [validity, setValidity] = useState('all')
  const [selected, setSelected] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [clipboardError, setClipboardError] = useState(false)
  const nextId = useRef(0)
  const heading = useId()
  if (captureKey && currentKey && currentKey !== captureKey) setCaptureKey(null)
  const capturing = captureKey !== null && captureKey === currentKey
  const format = useMemo(() => clockFormatter(locale, prefs.clock).format, [locale, prefs.clock])
  const entries = buffer?.entries ?? emptyPackets
  const types = useMemo(() => {
    const labels = new Set(entries.map(({ packet }) => packet.header ? typeLabel(packet.header) : 'Unknown header'))
    if (type !== 'all') labels.add(type)
    return [...labels].sort()
  }, [entries, type])
  const filtered = useMemo(() => entries.filter(({ packet }) => (
    (validity === 'all' || packet.status === validity) &&
    (type === 'all' || (packet.header ? typeLabel(packet.header) : 'Unknown header') === type) &&
    (route === 'all' || (packet.header ? String(packet.header.routeCode) : 'unknown') === route)
  )), [entries, route, type, validity])
  const detail = filtered.find(({ id }) => id === selected)

  useEffect(() => {
    if (!captureKey) return
    return session.subscribeToPushes(({ code, payload }) => {
      if (code !== rxPacketPush) return
      const current = session.getSnapshot()
      if (connectedRadio(current) !== captureKey || !current.transport) return
      const entry = {
        id: ++nextId.current, time: Date.now(), transport: current.transport,
        packet: decodeRxPacket(payload),
      }
      setBuffer((previous) => previous?.key === captureKey ? {
        key: captureKey, entries: [entry, ...previous.entries.slice(0, maxRxPackets - 1)],
      } : previous)
    })
  }, [captureKey, session])

  function startCapture() {
    if (!currentKey) return
    if (buffer?.key !== currentKey) {
      setBuffer({ key: currentKey, entries: [] })
      setSelected(null)
      setType('all')
    }
    setCaptureKey(currentKey)
    setNotice('')
    setClipboardError(false)
  }

  function clear() {
    setBuffer((previous) => previous ? { ...previous, entries: [] } : previous)
    setSelected(null)
    setType('all')
    setNotice('Received packet log cleared.')
    setClipboardError(false)
  }

  async function copy(text: string, raw = false) {
    setNotice('')
    setClipboardError(false)
    try {
      await navigator.clipboard.writeText(text)
      setNotice(raw ? 'Raw packet copied.' : 'Redacted diagnostics copied.')
    } catch {
      setClipboardError(true)
      setNotice(raw ? 'Clipboard access failed. Select the packet hex to copy it manually.'
        : 'Clipboard access failed. Download the redacted diagnostics instead.')
    }
  }

  function exportReport() {
    const url = URL.createObjectURL(new Blob([redactedDiagnostics(filtered)], { type: 'application/json' }))
    const download = document.createElement('a')
    download.href = url
    download.download = 'packet-pigeon-rx-diagnostics.json'
    download.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  return <section className="rx-inspector" aria-labelledby={heading}>
    <div className="rx-controls">
      <h2 id={heading}>Received packets</h2>
      <p>Logs up to {maxRxPackets} packets from one radio in this tab. Capture continues across workspace sections.</p>
      <div className="rx-actions">
        {captureKey && (!currentKey || capturing) ? (
          <button type="button" onClick={() => setCaptureKey(null)}>Stop capture</button>
        ) : <button type="button" disabled={!currentKey} onClick={startCapture}>
          {buffer && currentKey && currentKey !== buffer.key ? 'Start new radio capture' : 'Start capture'}
        </button>}
        <button type="button" disabled={!entries.length} onClick={clear}>Clear log</button>
        <button type="button" disabled={!filtered.length}
          onClick={() => void copy(redactedDiagnostics(filtered))}>Copy redacted diagnostics</button>
        <button type="button" disabled={!filtered.length} onClick={exportReport}>Export redacted diagnostics</button>
      </div>
      <p role="status">{capturing ? `Capturing via ${snapshot.transport === 'bluetooth' ? 'Bluetooth' : 'USB'}.`
        : captureKey && !currentKey ? 'Capture paused until the selected radio reconnects.'
          : currentKey ? 'Capture stopped.' : 'Connect a radio to capture received packets.'}</p>
      {buffer && currentKey && buffer.key !== currentKey &&
        <p>The log belongs to a previous radio. Starting a capture on the current radio replaces it.</p>}
      {(snapshot.transport === 'bluetooth' || entries.some(({ transport }) => transport === 'bluetooth')) &&
        <p>Bluetooth notifications may be incomplete. A truncated packet can look valid. Use USB to check packet bytes.</p>}
      <p>Copy and export include the filtered rows with lengths, route and signal data. They omit raw bytes, payloads and identifiers.</p>
      {notice && <p role={clipboardError ? 'alert' : 'status'}>{notice}</p>}
    </div>
    <fieldset className="rx-filters">
      <legend>Filter received packets</legend>
      <label>Type
        <select value={type} onChange={(event) => setType(event.currentTarget.value)}>
          <option value="all">All types</option>
          {types.map((label) => <option key={label}>{label}</option>)}
        </select>
      </label>
      <label>Route
        <select value={route} onChange={(event) => setRoute(event.currentTarget.value)}>
          <option value="all">All routes</option>
          <option value="0">Flood with transport codes</option>
          <option value="1">Flood</option>
          <option value="2">Direct</option>
          <option value="3">Direct with transport codes</option>
          <option value="unknown">Unknown route</option>
        </select>
      </label>
      <label>Decode status
        <select value={validity} onChange={(event) => setValidity(event.currentTarget.value)}>
          <option value="all">All statuses</option>
          <option value="decoded">Decoded</option>
          <option value="unsupported">Unsupported</option>
          <option value="malformed">Malformed</option>
        </select>
      </label>
    </fieldset>
    <p>{filtered.length} of {entries.length} packets</p>
    {detail && <PacketDetails entry={detail} observations={matchingChannelObservations(detail, entries)} key={detail.id} format={format}
      close={() => setSelected(null)} copyRaw={(text) => void copy(text, true)} />}
    {filtered.length ? <div className="rx-table-wrap" role="region" aria-label="Received packet table" tabIndex={0}>
      <table>
        <caption>Captured packets, newest first</caption>
        <thead><tr><th scope="col">Received</th><th scope="col">Direction and type</th><th scope="col">Route</th>
          <th scope="col">Bytes</th><th scope="col">SNR</th><th scope="col">Decode status</th></tr></thead>
        <tbody>{filtered.map(({ id, time, packet }) => <tr key={id}>
          <td><time dateTime={new Date(time).toISOString()}>{format(new Date(time))}</time></td>
          <td><button type="button" aria-pressed={id === detail?.id} onClick={() => setSelected(id)}>
            RX {packet.header ? typeLabel(packet.header) : 'Unknown packet'}
          </button></td>
          <td>{packet.header ? routeLabel(packet.header) : 'Unknown'}</td>
          <td>{packet.wire.length}</td>
          <td>{packet.snrDb === null ? 'Unavailable' : `${packet.snrDb} dB`}</td>
          <td>{packet.status}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p>{entries.length ? 'No captured packets match the filters.' : 'No packets captured.'}</p>}
  </section>
}

function PacketDetails({ entry, observations, format, close, copyRaw }: {
  entry: CapturedPacket; observations: CapturedPacket[]; format: (date: Date) => string; close: () => void; copyRaw: (text: string) => void
}) {
  const [fingerprint, setFingerprint] = useState('')
  const { packet, time, transport } = entry
  const heading = useId()
  useEffect(() => {
    let current = true
    void rxPacketHash(packet).then(
      (hash) => { if (current) setFingerprint(hash ?? 'Unavailable') },
      () => { if (current) setFingerprint('Unavailable') },
    )
    return () => { current = false }
  }, [packet])

  const wire = packet.wire.length ? packetHex(packet.wire) : ''
  return <section className="rx-details" aria-labelledby={heading}>
    <div className="rx-actions">
      <h3 id={heading}>{packet.header ? typeLabel(packet.header) : 'Unknown packet'} details</h3>
      <button type="button" onClick={close}>Close details</button>
    </div>
    {packet.note && <p>{packet.note}</p>}
    <dl>
      <dt>Received in browser</dt><dd>{format(new Date(time))} <code>{new Date(time).toISOString()}</code></dd>
      <dt>Direction</dt><dd>RX</dd>
      <dt>Transport</dt><dd>{transport === 'bluetooth' ? 'Bluetooth' : 'USB'}</dd>
      {packet.header && <>
        <dt>Route</dt><dd>{routeLabel(packet.header)}</dd>
        <dt>Payload version</dt><dd>{packet.header.version}</dd>
        <dt>Type code</dt><dd>{packet.header.typeCode}</dd>
      </>}
      <dt>Wire bytes</dt><dd>{packet.wire.length}</dd>
      {packet.payload && <><dt>Payload bytes</dt><dd>{packet.payload.length}</dd></>}
      <dt>SNR</dt><dd>{packet.snrDb === null ? 'Unavailable' : `${packet.snrDb} dB`}</dd>
      <dt>RSSI</dt><dd>{packet.rssiDbm === null ? 'Unavailable' : `${packet.rssiDbm} dBm`}</dd>
      <dt>MeshCore packet hash</dt><dd><code>{fingerprint || 'Calculating…'}</code></dd>
      {packet.path && <>
        <dt>Path</dt><dd>{packet.path.count} hops
          {packet.path.hashWidth !== null && <> · {packet.path.hashWidth}-byte hashes</>}
          {packet.path.hashes?.length ? <> · <code>{packet.path.hashes.join(', ')}</code></> : null}</dd>
        {!!packet.path.traceSnrDb?.length && <>
          <dt>Trace hop SNR</dt><dd>{packet.path.traceSnrDb.join(', ')} dB</dd>
        </>}
      </>}
      {packet.transportCodes && <>
        <dt>Transport codes</dt><dd><code>{packet.transportCodes.map((code) => code.toString(16).padStart(4, '0')).join(', ')}</code></dd>
      </>}
      {payloadFields(packet).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{value}</code></dd></div>)}
    </dl>
    {observations.length > 0 && <div>
      <h4>Matching encrypted channel-packet observations: {observations.length}</h4>
      <p>These USB packets have identical encrypted payload bytes in this capture. They may be separate transmissions,
        not delivery confirmations. Missing packets are not evidence of no repeats; they cannot be reliably linked to a queued message.</p>
      <ul>{observations.map(({ id, time: observedAt, packet: observed }) => <li key={id}>
        <time dateTime={new Date(observedAt).toISOString()}>{format(new Date(observedAt))}</time>
        {observed.header && <> · {routeLabel(observed.header)} · {observed.path!.count}{' '}
          {observed.header.routeCode >= 2 ? 'remaining' : 'traversed'} hop{observed.path!.count === 1 ? '' : 's'}</>}
        {observed.path!.hashes?.length ? <> · <code>{observed.path!.hashes.join(', ')}</code></> : null}
        {observed.transportCodes && <> · transport codes <code>{observed.transportCodes.map((code) => code.toString(16).padStart(4, '0')).join(', ')}</code></>}
      </li>)}</ul>
    </div>}
    {wire && <details>
      <summary>Show raw packet hex</summary>
      <p>Raw bytes can include private data and identifiers.</p>
      <code className="rx-raw">{wire}</code>
      <button type="button" onClick={() => {
        if (window.confirm('Copy this raw packet, including any private data and identifiers?')) copyRaw(wire)
      }}>Copy raw packet</button>
    </details>}
  </section>
}
