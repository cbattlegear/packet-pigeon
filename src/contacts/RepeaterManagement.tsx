import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession } from '../radio/companion-session.ts'
import type { RepeaterLogin, RepeaterStatus } from '../radio/repeater-management.ts'
import { decodeContactPath, pathUnknown } from '../radio/contact-path.ts'
import type { ContactEntry } from './model.ts'
import { contactPosition } from './model.ts'
import { RepeaterCli } from './RepeaterCli.tsx'
import { RepeaterCredentialStorage } from './RepeaterCredentialStorage.tsx'
import { browserRepeaterCredentialVault } from '../radio/repeater-credentials.ts'
import type { RepeaterMessageSync } from './RepeaterCli.tsx'
import { mapPosition } from '../map/nodes.ts'
import { resolvePath } from '../paths/model.ts'
import type { MapPath, PathNode } from '../paths/model.ts'

type Props = {
  session: Pick<CompanionSession, 'manageRepeater' | 'readRepeaterAccessList' | 'readRepeaterNeighbors' | 'sendRepeaterCommand' |
    'hasRememberedRepeaterPassword' | 'forgetRepeaterPassword' | 'resumeRepeater'>
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
  const [statsResetSent, setStatsResetSent] = useState(false)
  const [batteryCalibrationSent, setBatteryCalibrationSent] = useState(false)
  const [clients, setClients] = useState<{
    entries: Awaited<ReturnType<CompanionSession['readRepeaterAccessList']>>
    receivedAt: number
  } | null>(null)
  const [neighbors, setNeighbors] = useState<{
    page: Awaited<ReturnType<CompanionSession['readRepeaterNeighbors']>>
    offset: number
    previousOffsets: number[]
    receivedAt: number
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [cliPending, setCliPending] = useState(false)
  const [error, setError] = useState('')
  const [rebootNotice, setRebootNotice] = useState('')
  const [rememberPassword, setRememberPassword] = useState(false)
  const [remembered, setRemembered] = useState(() => session.hasRememberedRepeaterPassword(radioKey, contact.publicKey))
  const password = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)
  const details = contact.details!
  const path = decodeContactPath(details.pathLength, details.pathHex)
  const route = path ? (path.hops.length ? `${path.hops.length} saved hops` : 'Direct, zero hops')
    : details.pathLength === pathUnknown ? 'Flood (no saved route)' : 'Invalid saved route'
  const resolvedNeighbors = (neighbors?.page.entries ?? []).map((entry) => ({
    ...entry,
    matches: resolvePath([entry.publicKey], neighborNodes)[0].matches
      .filter((node) => node.publicKey.toLowerCase() === entry.publicKey),
  }))
  const mappableNeighbors = resolvedNeighbors.filter(({ matches }) => matches.length === 1 && mapPosition(matches[0].position))

  useEffect(() => () => request.current?.abort(new Error('Stopped waiting for the repeater.')), [])

  async function run(operation: 'login' | 'resume' | 'vault' | 'status', secret = '', remember = false) {
    if (!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    if (operation !== 'status') { setLogin(null); setStatus(null); setClients(null); setNeighbors(null); setRebootNotice('') }
    try {
      const currentRoute = { pathLength: details.pathLength, pathHex: details.pathHex }
      const result = operation === 'resume'
        ? await session.resumeRepeater(radioKey, contact.publicKey, currentRoute, controller.signal)
        : operation === 'vault'
          ? await session.manageRepeater(radioKey, contact.publicKey, currentRoute, 'login',
            await browserRepeaterCredentialVault().unlock(radioKey, contact.publicKey, secret, controller.signal), controller.signal)
          : await session.manageRepeater(radioKey, contact.publicKey, currentRoute, operation, secret, controller.signal, remember)
      if (operation !== 'status' && 'role' in result) {
        setRemembered(session.hasRememberedRepeaterPassword(radioKey, contact.publicKey))
        setLogin(result)
      }
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

  async function readNeighbors(offset: number, previousOffsets: number[] = []) {
    if (!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    setNeighbors(null)
    try {
      const page = await session.readRepeaterNeighbors(radioKey, contact.publicKey,
        { pathLength: details.pathLength, pathHex: details.pathHex }, offset, controller.signal)
      setNeighbors({ page, offset, previousOffsets, receivedAt: Date.now() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The repeater neighbor request failed.')
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
    if (rememberPassword && !value) {
      setError('Enter a nonempty password to remember it, or uncheck the remember option.')
      return
    }
    void run('login', value, rememberPassword)
  }

  return <details>
    <summary>Repeater login and status</summary>
    <p>Current route: {route}. Login and status each send a remote request; no requests are automatic.</p>
    <p>A blank password can use the repeater's access list; a blank guest password may also grant guest access to a new radio.</p>
    <p>Tab-only remembering is optional and keeps the password only in this tab's memory after a reported successful login, until forgotten or
      the tab reloads or closes. This option does not save it to browser storage. Forgetting removes the remembered password but does not
      revoke repeater access or cancel a request already started.
      Other scripts or extensions with access to this page may read it; the browser may retain copies after forgetting.</p>
    <p>After a cancelled, timed-out, or unconfirmed login or status request, requests to this repeater are blocked until reconnecting.
      Reconnecting cannot rule out a delayed over-the-air reply; the reported role is not proof of current authorization.</p>
    <form className="contact-actions" onSubmit={submit}>
      <label>Repeater password
        <input ref={password} type="password" autoComplete="off" disabled={!ready || busy || pending || cliPending} />
      </label>
      <label><input type="checkbox" checked={rememberPassword} disabled={!ready || busy || pending || cliPending}
        onChange={(event) => setRememberPassword(event.currentTarget.checked)} /> Remember password for this tab</label>
      <button type="submit" disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}>Log in</button>
    </form>
    {remembered && <div className="contact-actions">
      <button type="button" disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}
        onClick={() => { if (password.current) password.current.value = ''; void run('resume') }}>Log in with remembered password</button>
      <button type="button" onClick={() => {
        session.forgetRepeaterPassword(radioKey, contact.publicKey)
        setRemembered(false)
      }}>Forget remembered password</button>
    </div>}
    {remembered && <p>Logging in with the remembered password sends a new request and clears any password typed above.
      Unchecking the remember option does not forget the saved password.</p>}
    <RepeaterCredentialStorage radioKey={radioKey} contactKey={contact.publicKey}
      disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}
      onUnlock={(phrase) => { if (password.current) password.current.value = ''; void run('vault', phrase) }} />
    {login && <p role="status">Login reported {login.role === 'guest-or-legacy' ? 'guest or legacy (admin not confirmed)' : login.role} access;
      the request used {login.route} routing.</p>}
    {login && <button type="button" disabled={!ready || busy || pending || cliPending} onClick={() => void run('status')}>Request status</button>}
    {statsResetSent && <p role="status">A statistics reset was sent or may have been sent. Earlier status was cleared;
      the reset may still arrive after a new status request.</p>}
    {batteryCalibrationSent && <p role="status">A battery calibration change was sent or may have been sent. Earlier status was cleared;
      the change may still arrive after a new status request.</p>}
    {login && <details>
      <summary>Inspect nearby repeater keys</summary>
      <p>Each page is an explicit request over the mesh, up to three entries ordered by most recently heard.
        Repeater firmware v1.14.1 supports this request; other builds may not. Entries can be stale or change between
        pages, causing omissions or duplicates. Discovery responses are unauthenticated, so even a full key does not
        prove identity; verify it independently before using it. Request tags can repeat after a radio restart,
        so a delayed reply may be ambiguous. Map points use saved contact positions for this page only and do not imply a route.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}
          onClick={() => void readNeighbors(0)}>Request first neighbor page</button>
        {neighbors && neighbors.previousOffsets.length > 0 && <button type="button"
          disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}
          onClick={() => void readNeighbors(neighbors.previousOffsets.at(-1)!, neighbors.previousOffsets.slice(0, -1))}>
          Request previous page</button>}
        {neighbors && neighbors.page.entries.length > 0 &&
          neighbors.offset + neighbors.page.entries.length < neighbors.page.total &&
          <button type="button" disabled={!ready || busy || pending || cliPending || (!path && details.pathLength !== pathUnknown)}
            onClick={() => void readNeighbors(neighbors.offset + neighbors.page.entries.length,
              [...neighbors.previousOffsets, neighbors.offset])}>Request next page</button>}
      </div>
      {neighbors && <div>
        <p>Reply received <time dateTime={new Date(neighbors.receivedAt).toISOString()}>
          {new Date(neighbors.receivedAt).toLocaleString()}
        </time>. Reported total: {neighbors.page.total}; page offset: {neighbors.offset}.
          Ages are seconds since heard when the repeater generated the reply; the reply may have been delayed.</p>
        {neighbors.page.entries.length ? <ul className="repeater-neighbor-keys" aria-label="Reported nearby repeater keys">
          {resolvedNeighbors.map((entry, index) => <li key={`${entry.publicKey}:${index}`}>
            <code>{entry.publicKey}</code> · {entry.secondsAgo}s · {entry.snrDb} dB
            {entry.matches.length === 1 ? ` · Saved contact: ${entry.matches[0].name}` : ' · Not in saved contacts'}
            {entry.matches.length === 1 && !mapPosition(entry.matches[0].position) ? ' · Position unavailable' : ''}
          </li>)}
        </ul> : <p>No entries were returned on this page.</p>}
        {onMap && neighbors.page.entries.length > 0 && <button type="button" disabled={!mappableNeighbors.length} onClick={() => onMap({
          title: `Reported neighbors of ${contact.displayName} (page offset ${neighbors.offset})`,
          description: `Reply received ${new Date(neighbors.receivedAt).toLocaleString()} (browser time). Ages are at reply and may be delayed. ` +
            'Request tags can repeat after a radio restart. Discovery responses are unauthenticated; a full-key match does not prove identity. ' +
            'Positions are saved contact positions and may be stale. ' +
            'Pages can change; points do not imply a route.',
          connect: false,
          points: mappableNeighbors.map(({ publicKey, secondsAgo, snrDb, matches }) => ({
            label: `${matches[0].name} (${publicKey}) · reported age ${secondsAgo}s at reply · SNR ${snrDb} dB`,
            position: matches[0].position,
          })),
        })}>Show this page on map</button>}
        {neighbors.page.entries.length > 0 && !mappableNeighbors.length &&
          <p>No entries on this page have mappable saved contact positions.</p>}
      </div>}
    </details>}
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
      onNeighborChange={() => setNeighbors(null)}
      onStatsReset={() => { setStatus(null); setStatsResetSent(true) }}
      onBatteryCalibration={() => { setStatus(null); setBatteryCalibrationSent(true) }}
      onReboot={(notice) => { setLogin(null); setStatus(null); setClients(null); setNeighbors(null); setRebootNotice(notice) }} />}
    {rebootNotice && <p role="status">{rebootNotice}</p>}
    {pending && <p role="status">Waiting for the repeater…
      <button type="button" onClick={() => request.current?.abort(new Error('Stopped waiting. A sent request cannot be recalled.'))}>Stop waiting</button>
    </p>}
    {status && <>
      <dl>
        <dt>Battery</dt><dd>{status.batteryMv} mV</dd>
        <dt>Uptime</dt><dd>{status.uptime} seconds</dd>
        <dt>Outbound queue</dt><dd>{status.queue}</dd>
        <dt>Noise floor / last RSSI / last SNR</dt><dd>{status.noiseFloor} / {status.rssi} dBm / {status.snr} dB</dd>
        <dt>Packets received / sent</dt><dd>{status.received} / {status.sent}</dd>
        <dt>Transmit airtime</dt><dd>{status.txAir} seconds</dd>
      </dl>
      <details>
        <summary>Detailed packet statistics</summary>
        <p>These are reported values, not live measurements. Counters may reset or wrap, and replies may be delayed.
          Field meanings and availability can vary by firmware.</p>
        <dl>
          <dt>Flood packets received / sent</dt><dd>{status.floodReceived} / {status.floodSent}</dd>
          <dt>Direct packets received / sent</dt><dd>{status.directReceived} / {status.directSent}</dd>
          <dt>Duplicate direct / flood packets</dt><dd>{status.directDuplicates} / {status.floodDuplicates}</dd>
          <dt>Error/event field</dt><dd>0x{status.errorEvents.toString(16).padStart(4, '0')}</dd>
          <dt>Receive airtime</dt><dd>{status.rxAir === null ? 'Not included or incomplete' : `${status.rxAir} seconds`}</dd>
          <dt>Receive errors</dt><dd>{status.receiveErrors === null ? 'Not included or incomplete' : status.receiveErrors}</dd>
        </dl>
        <p>In repeater v1.14.1 the error/event field is a bitmask; older firmware may report a different value.
          Receive errors depend on the radio driver. Zero does not prove that no errors occurred.</p>
      </details>
    </>}
    {error && <p role="alert">{error}</p>}
  </details>
}
