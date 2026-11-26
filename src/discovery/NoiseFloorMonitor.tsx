import { useEffect, useState } from 'react'
import type { CompanionSession } from '../radio/index.ts'

type Props = {
  radioKey: string
  active: boolean
  ready: boolean
  framed: boolean
  firmware: number
  session: Pick<CompanionSession, 'noiseFloor'>
}

export function NoiseFloorMonitor({ radioKey, active, ready, framed, firmware, session }: Props) {
  const [polling, setPolling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState<{ value: number; time: number } | null>(null)
  const [error, setError] = useState('')
  const supported = ready && firmware >= 8

  if ((!active || !supported) && polling) setPolling(false)

  useEffect(() => {
    if (!active || !supported || !polling) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      setBusy(true)
      try {
        const value = await session.noiseFloor(radioKey)
        if (!stopped) {
          setReading({ value, time: Date.now() })
          timer = setTimeout(() => void poll(), 2000)
        }
      } catch (reason) {
        if (!stopped) {
          setError(reason instanceof Error ? reason.message : 'Could not read the noise floor.')
          setPolling(false)
        }
      } finally {
        setBusy(false)
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [active, supported, polling, radioKey, session])

  return <section className="contact-new" aria-labelledby="noise-floor-heading">
    <h2 id="noise-floor-heading">Live noise floor</h2>
    <p>Read radio statistics locally every 2 seconds. This does not transmit a mesh request.
      Stopping prevents further polls; an in-flight read must finish or time out.</p>
    {!ready ? <p>Connect a radio and finish syncing to read its noise floor.</p>
      : firmware < 8 ? <p>Radio statistics require companion protocol v8 or newer.</p> : null}
    {supported && !framed && <p>Bluetooth notifications can be split or dropped. Malformed or missing replies stop polling.</p>}
    <div className="contact-actions">
      <button type="button" disabled={!active || !supported || polling || busy} onClick={() => {
        setError('')
        setReading(null)
        setPolling(true)
      }}>Start noise-floor polling</button>
      <button type="button" disabled={!polling} onClick={() => setPolling(false)}>Stop noise-floor polling</button>
    </div>
    <p role="status">{polling ? busy ? 'Reading noise floor…' : 'Polling noise floor.' : busy ? 'Finishing the current read…' : 'Noise-floor polling stopped.'}</p>
    {reading && <p>Last reading: {reading.value} dBm at {new Date(reading.time).toLocaleTimeString()}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
