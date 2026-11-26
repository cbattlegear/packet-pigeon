import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession } from '../radio/companion-session.ts'
import type { RepeaterLogin, RepeaterStatus } from '../radio/repeater-management.ts'
import { decodeContactPath, pathUnknown } from '../radio/contact-path.ts'
import type { ContactEntry } from './model.ts'
import { contactPosition } from './model.ts'
import { RepeaterCli } from './RepeaterCli.tsx'
import type { RepeaterMessageSync } from './RepeaterCli.tsx'
import type { MapPath, PathNode } from '../paths/model.ts'

type Props = {
  session: Pick<CompanionSession, 'manageRepeater' | 'readRepeaterAccessList' | 'sendRepeaterCommand'>
  messageSync: RepeaterMessageSync
  contact: ContactEntry
  radioKey: string
  ready: boolean
  busy: boolean
  neighborNodes: readonly PathNode[]
  onMap?: (path: MapPath) => void
}

export function RepeaterManagement({ session, messageSync, contact, radioKey, ready, busy, neighborNodes, onMap }: Props) {
  const [login, setLogin] = useState<RepeaterLogin | null>(null)
  const [status, setStatus] = useState<RepeaterStatus | null>(null)
  const [clients, setClients] = useState<{
    entries: Awaited<ReturnType<CompanionSession['readRepeaterAccessList']>>
    receivedAt: number
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [cliPending, setCliPending] = useState(false)
  const [error, setError] = useState('')
  const [rebootNotice, setRebootNotice] = useState('')
  const password = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)
  const details = contact.details!
  const path = decodeContactPath(details.pathLength, details.pathHex)
  const route = path ? (path.hops.length ? `${path.hops.length} saved hops` : 'Direct, zero hops')
    : details.pathLength === pathUnknown ? 'Flood (no saved route)' : 'Invalid saved route'

  useEffect(() => () => request.current?.abort(new Error('Stopped waiting for the repeater.')), [])

  async function run(operation: 'login' | 'status', secret = '') {
    if (!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    if (operation === 'login') { setLogin(null); setStatus(null); setClients(null); setRebootNotice('') }
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

  async function readAccessList() {
    if (!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    setClients(null)
    try {
      const entries = await session.readRepeaterAccessList(radioKey, contact.publicKey,
        { pathLength: details.pathLength, pathHex: details.pathHex }, controller.signal)
      setClients({ entries, receivedAt: Date.now() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The repeater access-list request failed.')
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || cliPending) return
    const value = password.current?.value ?? ''
    if (password.current) password.current.value = ''
    void run('login', value)
  }

  return <details>
    <summary>Repeater login and status</summary>
    <p>Current route: {route}. Login and status each send a remote request; no requests are automatic.</p>
    <p>Passwords are used only for this login and are not saved. A repeater may grant access based on its existing access list.</p>
    <p>After a cancelled, timed-out, or unconfirmed login or status request, requests to this repeater are blocked until reconnecting.
      Reconnecting cannot rule out a delayed over-the-air reply; the reported role is not proof of current authorization.</p>
    <form className="contact-actions" onSubmit={submit}>
      <label>Repeater password
        <input ref={password} type="password" autoComplete="off" disabled={!ready || busy || pending || cliPending} />
      </label>
      <button type="submit" disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}>Log in</button>
    </form>
    {login && <p role="status">Login reported {login.role === 'guest-or-legacy' ? 'guest or legacy (admin not confirmed)' : login.role} access;
      the request used {login.route} routing.</p>}
    {login && <button type="button" disabled={!ready || busy || pending || cliPending} onClick={() => void run('status')}>Request status</button>}
    {login?.role === 'admin' && <details>
      <summary>Inspect repeater access</summary>
      <p>Requesting the access list transmits over the mesh. The reply contains six-byte public-key prefixes,
        not full identities; prefixes can collide. Guest entries can be omitted and the list can be truncated
        without notice, so absence does not prove a client lacks access. Older firmware may not support this request;
        some companion firmware does not surface an empty reply, which can result in a timeout. Request tags can repeat
        after a radio restart, so a delayed reply may be ambiguous.</p>
      <button type="button" disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}
        onClick={() => void readAccessList()}>Request access list</button>
      {clients && <div>
        <p>Reply received <time dateTime={new Date(clients.receivedAt).toISOString()}>
          {new Date(clients.receivedAt).toLocaleString()}
        </time>. It may have been delayed, and this snapshot can become stale.</p>
        {clients.entries.length ? <ul aria-label="Reported access entries">{clients.entries.map((client, index) =>
          <li key={`${client.prefix}:${index}`}><code>{client.prefix}</code> · {client.role}
            {' · '}permissions 0x{client.permissions.toString(16).padStart(2, '0')}</li>)}</ul>
          : <p>No entries were returned; this does not prove the list is complete.</p>}
      </div>}
    </details>}
    {login?.role === 'admin' && <RepeaterCli session={session} messageSync={messageSync}
      radioKey={radioKey} contactKey={contact.publicKey} name={contact.displayName}
      route={{ pathLength: details.pathLength, pathHex: details.pathHex }}
      ready={ready} busy={busy || pending} neighborNodes={neighborNodes} repeaterPosition={contactPosition(details)}
      onMap={onMap} onPending={setCliPending}
      onAccessChange={() => setClients(null)}
      onReboot={(notice) => { setLogin(null); setStatus(null); setClients(null); setRebootNotice(notice) }} />}
    {rebootNotice && <p role="status">{rebootNotice}</p>}
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
