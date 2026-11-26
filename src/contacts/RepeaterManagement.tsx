import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession } from '../radio/companion-session.ts'
import type { RepeaterLogin, RepeaterStatus } from '../radio/repeater-management.ts'
import { decodeContactPath, pathUnknown } from '../radio/contact-path.ts'
import type { ContactEntry } from './model.ts'

type Props = {
  session: Pick<CompanionSession, 'manageRepeater'>
  contact: ContactEntry
  radioKey: string
  ready: boolean
  busy: boolean
}

export function RepeaterManagement({ session, contact, radioKey, ready, busy }: Props) {
  const [login, setLogin] = useState<RepeaterLogin | null>(null)
  const [status, setStatus] = useState<RepeaterStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const password = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)
  const details = contact.details!
  const path = decodeContactPath(details.pathLength, details.pathHex)
  const route = path ? (path.hops.length ? `${path.hops.length} saved hops` : 'Direct, zero hops')
    : details.pathLength === pathUnknown ? 'Flood (no saved route)' : 'Invalid saved route'

  useEffect(() => () => request.current?.abort(new Error('Stopped waiting for the repeater.')), [])

  async function run(operation: 'login' | 'status', secret = '') {
    if (!ready || busy || pending || (!path && details.pathLength !== pathUnknown)) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    if (operation === 'login') { setLogin(null); setStatus(null) }
    try {
      const result = await session.manageRepeater(radioKey, contact.publicKey,
        { pathLength: details.pathLength, pathHex: details.pathHex }, operation, secret, controller.signal)
      if (operation === 'login' && 'role' in result) setLogin(result)
      if (operation === 'status' && 'batteryMv' in result) setStatus(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The repeater request failed.')
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending) return
    const value = password.current?.value ?? ''
    if (password.current) password.current.value = ''
    void run('login', value)
  }

  return <details>
    <summary>Repeater login and status</summary>
    <p>Current route: {route}. Login and status each send a remote request; no requests are automatic.</p>
    <p>Passwords are used only for this login and are not saved. A repeater may grant access based on its existing access list.</p>
    <form className="contact-actions" onSubmit={submit}>
      <label>Repeater password
        <input ref={password} type="password" autoComplete="off" disabled={!ready || busy || pending} />
      </label>
      <button type="submit" disabled={!ready || busy || pending || (!path && details.pathLength !== pathUnknown)}>Log in</button>
    </form>
    {login && <p role="status">Login reported {login.role === 'guest-or-legacy' ? 'guest or legacy (admin not confirmed)' : login.role} access;
      the request used {login.route} routing.</p>}
    {login && <button type="button" disabled={!ready || busy || pending} onClick={() => void run('status')}>Request status</button>}
    {pending && <p role="status">Waiting for the repeater…
      <button type="button" onClick={() => request.current?.abort(new Error('Stopped waiting. A sent request cannot be recalled.'))}>Stop waiting</button>
    </p>}
    {status && <dl>
      <dt>Battery</dt><dd>{status.batteryMv} mV</dd>
      <dt>Uptime</dt><dd>{status.uptime} seconds</dd>
      <dt>Outbound queue</dt><dd>{status.queue}</dd>
      <dt>Noise floor / last RSSI / last SNR</dt><dd>{status.noiseFloor} / {status.rssi} dBm / {status.snr} dB</dd>
      <dt>Packets received / sent</dt><dd>{status.received} / {status.sent}</dd>
      <dt>Transmit airtime</dt><dd>{status.txAir} seconds</dd>
    </dl>}
    {error && <p role="alert">{error}</p>}
  </details>
}
