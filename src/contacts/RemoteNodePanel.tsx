import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession } from '../radio/companion-session.ts'
import type { RemoteNodeAdmin } from '../radio/remote-nodes.ts'

export type RemoteNodeLoginSession = Pick<CompanionSession, 'getRemoteNodeAccess' | 'loginNode'>
export type RemoteNodeSession = RemoteNodeLoginSession & Pick<CompanionSession,
  'readRoomStatus' | 'readNodeClients' | 'readSensorHistory' | 'administerNode'>

type Target = { radioKey: string; nodeKey: string; name: string; type: 3 | 4; active: boolean; ready: boolean; busy: boolean }

function useNodeAction(active: boolean) {
  const current = useRef<AbortController | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => () => current.current?.abort(), [active])

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (!active || current.current) return
    const controller = new AbortController()
    current.current = controller
    setWaiting(true)
    setNotice('')
    setError('')
    try { await action(controller.signal) }
    catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The node action failed.')
    } finally {
      current.current = null
      setWaiting(false)
    }
  }
  return { waiting, notice, error, setNotice, run, stop: () => current.current?.abort() }
}

export function RemoteNodeLogin({ session, radioKey, nodeKey, type, active, ready, busy }:
  Omit<Target, 'name'> & { session: RemoteNodeLoginSession }) {
  const action = useNodeAction(active)
  const [password, setPassword] = useState('')
  const access = session.getRemoteNodeAccess(radioKey, nodeKey)
  const label = type === 3 ? 'Room access' : 'Sensor access'
  const disabled = !ready || busy || action.waiting

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    const value = password
    setPassword('')
    void action.run(async (signal) => {
      await session.loginNode(radioKey, nodeKey, value, signal)
    })
  }

  return <section className="contact-management" aria-label={label}>
    <h3>{label}</h3>
    {access ? <p role="status">{access.role === 'admin' ? 'Administrator access' : access.role === 'read-write'
      ? 'Read and write access' : access.role === 'read-only' || access.role === 'guest' ? 'Read-only access' : 'Access level unavailable'}
      {' · '}{access.route === 'direct' ? 'Direct' : 'Flood'}</p> : <p>{ready ? 'Sign in to request access.' : 'Connect this radio to sign in.'}</p>}
    <form className="contact-actions" onSubmit={login}>
      <label>Password <input type="password" autoComplete="off" value={password} disabled={disabled}
        onChange={(event) => setPassword(event.currentTarget.value)} /></label>
      <button type="submit" disabled={disabled}>Sign in</button>
    </form>
    <p>Leave the password empty to request access already granted to this radio.
      {type === 3 && ' Depending on the room settings, an empty password may also grant new read-only or posting access.'}</p>
    {action.waiting && <button type="button" onClick={action.stop}>Stop waiting for login</button>}
    {action.error && <p role="alert">{action.error}</p>}
  </section>
}

export function RemoteNodePanel({ session, ...target }: Target & { session: RemoteNodeSession }) {
  const { radioKey, nodeKey, name, type, active, ready, busy } = target
  const access = session.getRemoteNodeAccess(radioKey, nodeKey)
  const action = useNodeAction(active)
  const [roomStatus, setRoomStatus] = useState<Awaited<ReturnType<RemoteNodeSession['readRoomStatus']>>>()
  const [clients, setClients] = useState<Awaited<ReturnType<RemoteNodeSession['readNodeClients']>>>()
  const [history, setHistory] = useState<Awaited<ReturnType<RemoteNodeSession['readSensorHistory']>>>()
  const admin = access?.role === 'admin'
  const disabled = !ready || busy || action.waiting
  const sensor = type === 4

  function send(settings: RemoteNodeAdmin, description: string, confirm = true, warning = '') {
    if (disabled || !admin || (confirm &&
      !window.confirm(`${description} on ${name} (${nodeKey.slice(0, 12)})?${warning ? ` ${warning}` : ''}`))) return
    void action.run(async (signal) => {
      const route = await session.administerNode(radioKey, nodeKey, settings, signal)
      action.setNotice(`Command queued over ${route === 'direct' ? 'direct' : 'flood'} routing. Use Sync messages in Chats to read the node’s reply.`)
    })
  }

  return <div className="remote-node">
    <RemoteNodeLogin {...target} session={session} busy={busy || action.waiting} />
    {sensor && access?.permissions != null && <p>Alert permissions for this radio
      {' · '}Low priority {access.permissions & 64 ? 'enabled' : 'off'}
      {' · '}High priority {access.permissions & 128 ? 'enabled' : 'off'}</p>}
    {sensor && <section className="contact-management" aria-label="Sensor history">
      <form className="contact-actions" onSubmit={(event) => {
        event.preventDefault()
        const seconds = Number(new FormData(event.currentTarget).get('window'))
        void action.run(async (signal) => setHistory(await session.readSensorHistory(radioKey, nodeKey, seconds, signal)))
      }}>
        <label>History window <select name="window" defaultValue="3600">
          <option value="3600">Last hour</option><option value="86400">Last day</option><option value="604800">Last week</option>
        </select></label>
        <button type="submit" disabled={disabled || !access?.role || access.role === 'guest'}>Request sensor history</button>
      </form>
      {history && <p>Sensor time <time dateTime={new Date(history.timestamp * 1_000).toISOString()}>
        {new Date(history.timestamp * 1_000).toLocaleString()}
      </time></p>}
      {history && (history.readings.length ? <ul>{history.readings.map((reading) => <li key={`${reading.channel}:${reading.type}`}>
        Channel {reading.channel} {reading.label} · Min {reading.minimum} · Max {reading.maximum} · Avg {reading.average} {reading.unit}
      </li>)}</ul> : <p>No history readings returned.</p>)}
    </section>}
    {!sensor && <section className="contact-management" aria-label="Room status">
      <div className="contact-actions"><button type="button" disabled={disabled || !access}
        onClick={() => void action.run(async (signal) => setRoomStatus(await session.readRoomStatus(radioKey, nodeKey, signal)))}>
        Request room status
      </button></div>
      {roomStatus && <dl>
        <dt>Battery</dt><dd>{roomStatus.batteryVolts} V</dd>
        <dt>Transmit queue</dt><dd>{roomStatus.queueSize}</dd>
        <dt>Noise floor</dt><dd>{roomStatus.noiseFloorDbm} dBm</dd>
        <dt>Received packets</dt><dd>{roomStatus.packetsReceived}</dd>
        <dt>Uptime</dt><dd>{roomStatus.uptimeSeconds} seconds</dd>
      </dl>}
    </section>}
    {admin && <details className="contact-management">
      <summary>{sensor ? 'Sensor administration' : 'Room administration'}</summary>
      <div className="contact-actions"><button type="button" disabled={disabled}
        onClick={() => void action.run(async (signal) => setClients(await session.readNodeClients(radioKey, nodeKey, signal)))}>
        Read access list
      </button></div>
      {clients && <div>
        <p>{sensor ? 'Clients reported by the sensor' : 'Administrator entries reported by the room server'}</p>
        {clients.length ? <ul>{clients.map((client, index) => <li key={`${client.prefix}:${index}`}>
          <code>{client.prefix}</code> · {client.role}{sensor && ` · alerts ${client.permissions & 64 ? 'low ' : ''}${client.permissions & 128 ? 'high' : ''}`}
        </li>)}</ul> : <p>No entries returned.</p>}
      </div>}
      <form className="contact-actions" onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const key = String(data.get('key'))
        const role = data.get('role')
        const permissions = role === 'remove' ? 0 : Number(role) | (data.has('low') ? 64 : 0) | (data.has('high') ? 128 : 0)
        send({ kind: 'client-permissions', publicKey: key, permissions }, `Change access for client ${key.slice(0, 12)}`)
      }}>
        <label>Client public key <input name="key" required pattern="[0-9A-Fa-f]{64}" /></label>
        <label>Client role <select name="role" defaultValue="1">
          <option value="remove">Remove access</option><option value="1">Read only</option>
          <option value="2">Read and write</option><option value="3">Administrator</option>
        </select></label>
        {sensor && <><label><input type="checkbox" name="low" /> Low-priority alerts</label>
          <label><input type="checkbox" name="high" /> High-priority alerts</label></>}
        <button type="submit" disabled={disabled}>Set client permissions</button>
      </form>
      <form className="contact-actions" onSubmit={(event) => {
        event.preventDefault()
        send({ kind: 'name', value: String(new FormData(event.currentTarget).get('name')) }, 'Change the advertised name')
      }}>
        <label>Advertised name <input name="name" required maxLength={31} /></label>
        <button type="submit" disabled={disabled}>Set advertised name</button>
      </form>
      {!sensor && <>
        <p>With automatic read-only entry enabled, an unrecognized password can grant read-only access.
          Disabling it does not revoke existing access-list entries; known clients may still sign in with a blank password.
          A blank room password may still grant posting access.</p>
        <p>Companion firmware v1.11 and earlier may cause these commands to be ignored.
          Read and change replies sync automatically into Chats while connected; they are not matched to commands and may arrive late.</p>
        <div className="contact-actions">
          <button type="button" disabled={disabled}
            onClick={() => send({ kind: 'read-allow-read-only' }, 'Read automatic read-only entry', false)}>Read read-only setting</button>
          <button type="button" disabled={disabled}
            onClick={() => send({ kind: 'allow-read-only', enabled: true }, 'Enable automatic read-only entry', true,
              'Unrecognized passwords can grant read-only access.')}>Enable automatic read-only entry</button>
          <button type="button" disabled={disabled}
            onClick={() => send({ kind: 'allow-read-only', enabled: false }, 'Disable automatic read-only entry', true,
              'Existing access-list entries are not revoked; known clients may still sign in with a blank password.')}>Disable automatic read-only entry</button>
        </div>
        <form className="contact-actions" onSubmit={(event) => {
          event.preventDefault()
          send({ kind: 'room-announcement', text: String(new FormData(event.currentTarget).get('announcement')) }, 'Post an announcement')
        }}>
          <label>Announcement <input name="announcement" required /></label>
          <button type="submit" disabled={disabled}>Post announcement</button>
        </form>
      </>}
    </details>}
    {action.waiting && <button type="button" onClick={action.stop}>Stop waiting for node</button>}
    {action.notice && <p role="status">{action.notice}</p>}
    {action.error && <p role="alert">{action.error}</p>}
  </div>
}
