import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeTelemetry } from '../radio/cayenne-lpp.ts'
import type { CompanionSession, CompanionSnapshot } from '../radio/companion-session.ts'
import { telemetryProtocolVersion } from '../radio/telemetry.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioKey, StoredTelemetry } from '../storage/index.ts'
import './telemetry.css'

export type TelemetrySession = Pick<CompanionSession, 'readTelemetry'>

type ReaderProps = {
  session: TelemetrySession
  radioKey: RadioKey
  contactKey: string | null
  ready: boolean
  firmware: number
  radioBusy: boolean
}

const pollInterval = 60_000
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 })
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

function telemetryError(error: unknown) {
  return error instanceof Error ? error.message : 'Could not load telemetry.'
}

export function ContactTelemetry({ active, ...reader }: ReaderProps & { active: boolean }) {
  const [open, setOpen] = useState(false)
  return <details className="telemetry" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Contact telemetry</summary>
    {open && active && <TelemetryReader {...reader} />}
  </details>
}

export function OwnTelemetry({ active, snapshot, session, radioBusy }: {
  active: boolean
  snapshot: CompanionSnapshot
  session: TelemetrySession
  radioBusy: boolean
}) {
  const [open, setOpen] = useState(false)
  return <details className="telemetry own-telemetry" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Radio telemetry</summary>
    {open && active && <OwnTelemetryReader snapshot={snapshot} session={session} radioBusy={radioBusy} />}
  </details>
}

function OwnTelemetryReader({ snapshot, session, radioBusy }: {
  snapshot: CompanionSnapshot
  session: TelemetrySession
  radioBusy: boolean
}) {
  const live = snapshot.phase === 'ready' || snapshot.phase === 'syncing'
  const deviceKey = snapshot.device ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const [choice, setChoice] = useState<RadioKey | '' | null>(null)
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [error, setError] = useState('')
  const radioKey = live || choice === null ? deviceKey : choice || null

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const storage = await openRadioStorage()
        try {
          const keys = await storage.listRadioKeys()
          if (active) {
            setKeys(keys)
            setError('')
          }
        } finally {
          storage.close()
        }
      } catch (error) {
        if (active) setError(telemetryError(error))
      }
    }
    void load()
    return () => { active = false }
  }, [deviceKey, live])

  return <>
    {!live && <label>Telemetry cache radio
      <select value={radioKey ?? ''} onChange={(event) => {
        setChoice(keys.find((key) => key === event.currentTarget.value) ?? '')
      }}>
        <option value="">Select a saved radio</option>
        {keys.map((key) => <option key={key} value={key}>{key}</option>)}
      </select>
    </label>}
    {error && <p role="alert">{error}</p>}
    {radioKey ? <TelemetryReader key={radioKey} session={session} radioKey={radioKey} contactKey={null}
      ready={snapshot.phase === 'ready'} firmware={snapshot.device?.capabilities.firmwareProtocolVersion ?? 0}
      radioBusy={radioBusy} /> : <p>Connect a radio or select a saved one to view telemetry.</p>}
  </>
}

function TelemetryReader({ session, radioKey, contactKey, ready, firmware, radioBusy }: ReaderProps) {
  const subjectKey = contactKey ?? radioKey
  const available = ready && firmware >= telemetryProtocolVersion
  const [sample, setSample] = useState<StoredTelemetry | null>(null)
  const [fromCache, setFromCache] = useState(true)
  const [loading, setLoading] = useState(true)
  const [waiting, setWaiting] = useState(false)
  const [poll, setPoll] = useState(false)
  const [error, setError] = useState('')
  const [cacheError, setCacheError] = useState('')
  const pending = useRef<AbortController | null>(null)
  if (!available && poll) setPoll(false)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const storage = await openRadioStorage()
        try {
          const data = await storage.read(radioKey)
          const cached = data?.telemetry?.find((sample) => sample.subjectKey === subjectKey)
          if (active && cached) setSample((current) => current ?? cached)
        } finally {
          storage.close()
        }
      } catch (error) {
        if (active) setCacheError(telemetryError(error))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [radioKey, subjectKey])

  useEffect(() => {
    function stopWhenHidden() {
      if (document.hidden) {
        setPoll(false)
        pending.current?.abort()
      }
    }
    document.addEventListener('visibilitychange', stopWhenHidden)
    return () => {
      document.removeEventListener('visibilitychange', stopWhenHidden)
      pending.current?.abort()
    }
  }, [available])

  const refresh = useCallback(async () => {
    if (!available || radioBusy || pending.current || document.hidden) return
    const controller = new AbortController()
    const { signal } = controller
    pending.current = controller
    setWaiting(true)
    setError('')
    try {
      const payload = await session.readTelemetry(radioKey, contactKey, signal)
      signal.throwIfAborted()
      if (decodeTelemetry(payload).issue?.kind === 'truncated') throw new Error('The telemetry reply was incomplete. Refresh to try again.')
      const reading = { subjectKey, receivedAt: Date.now(), payload }
      setSample(reading)
      setFromCache(false)
      try {
        const storage = await openRadioStorage()
        try {
          signal.throwIfAborted()
          await storage.update(radioKey, { telemetry: reading })
          if (!signal.aborted) setCacheError('')
        } finally {
          storage.close()
        }
      } catch (error) {
        if (!signal.aborted) {
          setCacheError(`Could not save this reading. ${telemetryError(error)}`)
          setPoll(false)
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        setError(telemetryError(error))
        setPoll(false)
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setWaiting(false)
      }
    }
  }, [available, contactKey, radioBusy, radioKey, session, subjectKey])

  useEffect(() => {
    if (!poll || !available || waiting || radioBusy) return
    const timer = setTimeout(() => void refresh(), pollInterval)
    return () => clearTimeout(timer)
  }, [poll, available, waiting, radioBusy, refresh])

  return <div className="telemetry-content">
    {contactKey && <p>Each refresh sends one mesh request. The contact’s firmware and permissions determine which readings it shares.</p>}
    {!ready && <p>Connect the selected radio and finish syncing to refresh.</p>}
    {ready && !available && <p>This radio needs MeshCore companion protocol v{telemetryProtocolVersion} or newer for telemetry.</p>}
    <div className="telemetry-actions">
      <button type="button" onClick={() => void refresh()} disabled={!available || radioBusy || waiting}>Refresh telemetry</button>
      <label><input type="checkbox" checked={poll} disabled={!available || (radioBusy && !poll)}
        onChange={(event) => {
          const enabled = event.currentTarget.checked
          setPoll(enabled)
          if (enabled) void refresh()
        }} /> Poll every minute while this view is open</label>
      {waiting && <button type="button" onClick={() => {
        setPoll(false)
        pending.current?.abort()
      }}>Stop waiting</button>}
    </div>
    {waiting && <p role="status">Waiting for telemetry…</p>}
    {error && <p role="alert">{error}</p>}
    {cacheError && <p role="alert">{cacheError}</p>}
    {sample ? <TelemetryValues sample={sample} fromCache={fromCache} />
      : <p>{loading ? 'Loading cached telemetry…' : 'No telemetry has been saved for this device.'}</p>}
  </div>
}

function TelemetryValues({ sample, fromCache }: { sample: StoredTelemetry; fromCache: boolean }) {
  const { readings, issue } = decodeTelemetry(sample.payload)
  const channels = [...new Set(readings.map(({ channel }) => channel))].sort((a, b) => a - b)
  const date = new Date(sample.receivedAt)
  return <>
    <p>{fromCache ? 'Cached reading from' : 'Received'} <time dateTime={date.toISOString()}>{dateTime.format(date)}</time></p>
    {!readings.length && <p>The reply contained no supported readings.</p>}
    {channels.map((channel) => <section key={channel}>
      <h3>{channel === 1 ? 'Device readings (channel 1)' : `Sensor channel ${channel}`}</h3>
      <dl>{readings.filter((entry) => entry.channel === channel).map(({ type, label, values, unit }, index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{type === 136 ? `${number.format(values[0])}°, ${number.format(values[1])}° · altitude ${number.format(values[2])} m`
            : `${values.map((value) => number.format(value)).join(', ')}${unit ? ` ${unit}` : ''}`}</dd>
        </div>
      ))}</dl>
    </section>)}
    {issue?.kind === 'unsupported' && <p>Unrecognized Cayenne LPP type 0x{issue.type?.toString(16)}. Later readings could not be decoded.</p>}
    {issue?.kind === 'truncated' && <p>The saved reply is incomplete.</p>}
  </>
}
