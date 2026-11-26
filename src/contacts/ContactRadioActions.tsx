import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CompanionSession } from '../radio/companion-session.ts'
import { contactPermissions } from '../radio/contact-commands.ts'
import type { ContactPermissions } from '../radio/contact-commands.ts'
import { decodeContactPath, parseContactPath, pathUnknown } from '../radio/contact-path.ts'
import type { ContactPathWidth } from '../radio/contact-path.ts'
import { contactPingWidth } from '../radio/contact-ping.ts'
import type { PingHashWidth } from '../radio/contact-ping.ts'
import type { ContactEntry } from './model.ts'
import { contactPosition } from './model.ts'
import { PathDetails } from '../paths/PathDetails.tsx'
import { resolvePath } from '../paths/model.ts'
import type { MapPath, PathNode } from '../paths/model.ts'

export type ContactRadioSession = Pick<CompanionSession,
  'addContact' | 'removeContact' | 'saveContactPath' | 'resetContactPath' | 'saveContactPermissions' | 'pingContact'>

type Props = {
  session: ContactRadioSession
  contact: ContactEntry
  contacts: readonly ContactEntry[]
  radioKey: string
  ready: boolean
  framed: boolean
  firmware: number
  busy: boolean
  onMap?: (path: MapPath) => void
  additionalPathNodes?: readonly PathNode[]
}

const permissionLabels = {
  telemetry: 'Base telemetry',
  location: 'Location telemetry',
  environment: 'Environment telemetry',
  remoteCli: 'Remote CLI access',
} as const

function radioError(error: unknown) {
  return error instanceof Error ? error.message : 'The radio action failed.'
}

export function ContactRadioActions({ session, contact, contacts, radioKey, ready, framed, firmware, busy, onMap,
  additionalPathNodes = [] }: Props) {
  const key = contact.publicKey
  const details = contact.details
  const saved = details ? decodeContactPath(details.pathLength, details.pathHex) : null
  const pathNodes = [...contacts.map((entry) => ({
    publicKey: entry.publicKey, name: entry.displayName, position: contactPosition(entry.details),
  })), ...additionalPathNodes]
  const [width, setWidth] = useState<ContactPathWidth>(() => saved?.width ?? 1)
  const [text, setText] = useState(() => saved?.hops.join(' ') ?? '')
  const [repeaterKey, setRepeaterKey] = useState('')
  const [permissions, setPermissions] = useState<ContactPermissions>({})
  const [pingWidth, setPingWidth] = useState<PingHashWidth>(() => firmware >= 10 ? 2 : 1)
  const [pending, setPending] = useState<'route' | 'permissions' | 'ping' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const ping = useRef<AbortController | null>(null)
  useEffect(() => () => ping.current?.abort(new Error('Stopped waiting for the ping.')), [])

  const repeaters = contacts.filter(({ details, publicKey }) => details?.type === 2 && publicKey !== key)
  const routeWidth = firmware >= 10 ? width : 1
  const chosenPingWidth = contactPingWidth(firmware, pingWidth) ? pingWidth : 1
  const pingPrefix = key.slice(0, chosenPingWidth * 2).toLowerCase()
  const matchingPing = contacts.filter(({ publicKey }) => publicKey !== key && publicKey.toLowerCase().startsWith(pingPrefix))
  const ambiguousPing = matchingPing.length > 0 || radioKey.startsWith(pingPrefix)
  const disabled = pending !== null || busy
  const canEdit = ready && framed && !disabled
  const supportedPermissions = (Object.keys(contactPermissions) as (keyof ContactPermissions)[])
    .filter((name) => name === 'remoteCli' ? firmware >= 14 : firmware >= 5)

  async function perform(action: NonNullable<typeof pending>, finish: () => Promise<string>) {
    setPending(action)
    setNotice('')
    setError('')
    try {
      setNotice(await finish())
    } catch (reason) {
      setError(radioError(reason))
    } finally {
      setPending(null)
    }
  }

  function saveRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit) return
    void perform('route', async () => {
      const path = parseContactPath(text, routeWidth)
      const parsed = decodeContactPath(path.encoded, path.hex)!
      if (resolvePath(parsed.hops, pathNodes).some(({ matches }) => matches.length > 1) &&
        !window.confirm('Some path hashes match several known radios. The route may reach a different repeater. Save this route?')) {
        return 'Route left unchanged.'
      }
      await session.saveContactPath(radioKey, key, routeWidth, text)
      setText(parsed.hops.join(' '))
      return 'Saved the contact route.'
    })
  }

  function resetRoute() {
    if (!canEdit || !window.confirm('Clear the saved route? The next message or request may use flood routing.')) return
    void perform('route', async () => {
      await session.resetContactPath(radioKey, key)
      setText('')
      return 'Cleared the saved route.'
    })
  }

  function savePermissions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || !supportedPermissions.length) return
    const changes = Object.fromEntries(supportedPermissions.flatMap((name) =>
      typeof permissions[name] === 'boolean' ? [[name, permissions[name]]] : [],
    )) satisfies ContactPermissions
    if (!Object.keys(changes).length) return
    if (changes.remoteCli === true && !window.confirm(
      `Give ${contact.displayName} permission to run commands on your radio?`,
    )) return
    void perform('permissions', async () => {
      await session.saveContactPermissions(radioKey, key, changes)
      setPermissions({})
      return 'Saved contact permissions.'
    })
  }

  function sendPing() {
    if (!ready || disabled || ambiguousPing || !window.confirm(
      `Send a zero-hop ping to ${contact.displayName} using prefix ${pingPrefix}?`,
    )) return
    const controller = new AbortController()
    ping.current = controller
    void perform('ping', async () => {
      try {
        const result = await session.pingContact(radioKey, key, chosenPingWidth, controller.signal)
        return `Ping reply in ${result.elapsedMs} ms. Outbound SNR ${result.outboundSnrDb} dB. Return SNR ${result.returnSnrDb} dB.`
      } finally {
        if (ping.current === controller) ping.current = null
      }
    })
  }

  return <div className="contact-radio-actions">
    <details>
      <summary>Saved route and repeater hops</summary>
      {saved && <PathDetails title="Saved route" width={saved.width} hashes={saved.hops} nodes={pathNodes} onMap={onMap} />}
      {!ready || !framed ? <p>Connect the selected radio over USB or the local network to edit its saved route.</p> :
        <form className="contact-actions" onSubmit={saveRoute}>
          <label>Contact path hash width
            <select value={routeWidth} disabled={!canEdit} onChange={(event) => {
              const value = Number(event.currentTarget.value)
              if (value === 1 || value === 2 || value === 3) setWidth(value)
            }}>
              <option value="1">1 byte</option>
              {firmware >= 10 && <><option value="2">2 bytes</option><option value="3">3 bytes</option></>}
            </select>
          </label>
          <label>Path hops in order
            <input value={text} disabled={!canEdit} autoComplete="off" spellCheck={false}
              onChange={(event) => setText(event.currentTarget.value)} />
          </label>
          <label>Repeater to append
            <select value={repeaterKey} disabled={!canEdit || !repeaters.length} onChange={(event) => setRepeaterKey(event.currentTarget.value)}>
              <option value="">Select a repeater</option>
              {repeaters.map(({ publicKey, displayName }) => <option key={publicKey} value={publicKey}>
                {displayName} ({publicKey.slice(0, routeWidth * 2)})
              </option>)}
            </select>
          </label>
          <button type="button" disabled={!canEdit || !repeaterKey} onClick={() => {
            setText((value) => [value.trim(), repeaterKey.slice(0, routeWidth * 2)].filter(Boolean).join(' '))
            setRepeaterKey('')
          }}>Append repeater</button>
          <p>Use hex hashes or append repeaters in order. Leave the list empty for a direct zero-hop route.</p>
          <button type="submit" disabled={!canEdit}>Save route</button>
          <button type="button" disabled={!canEdit || details?.pathLength === pathUnknown} onClick={resetRoute}>Clear saved route</button>
        </form>}
    </details>
    <details>
      <summary>Contact permissions</summary>
      {!ready || !framed ? <p>Connect the selected radio over USB or the local network to edit permissions.</p>
        : !supportedPermissions.length ? <p>This firmware does not report support for contact permissions.</p>
          : <form onSubmit={savePermissions}>
            <p>Contact telemetry permissions apply when the radio’s global telemetry policy uses contact flags.</p>
            <fieldset disabled={!canEdit}>
              <legend>Allow this contact</legend>
              {supportedPermissions.map((name) => <label className="contact-checkbox" key={name}>
                <input type="checkbox" checked={permissions[name] ?? Boolean((details?.flags ?? 0) & contactPermissions[name])}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked
                    setPermissions((current) => ({ ...current, [name]: enabled }))
                  }} />
                {permissionLabels[name]}
              </label>)}
            </fieldset>
            <button type="submit" disabled={!canEdit || !Object.keys(permissions).length}>Save permissions</button>
          </form>}
    </details>
    {(details?.type === 2 || details?.type === 3) && <details>
      <summary>Zero-hop ping</summary>
      <p>Sends one direct ping to a nearby repeater or repeat-enabled room server. It does not use the saved route.</p>
      <div className="contact-actions">
        <label>Ping hash width
          <select value={chosenPingWidth} disabled={!ready || disabled} onChange={(event) => {
            const value = Number(event.currentTarget.value)
            if (value === 1 || value === 2 || value === 4) setPingWidth(value)
          }}>
            <option value="1">1 byte</option>
            {firmware >= 10 && <><option value="2">2 bytes</option><option value="4">4 bytes</option></>}
          </select>
        </label>
        <button type="button" disabled={!ready || disabled || ambiguousPing} onClick={sendPing}>Send ping</button>
        {pending === 'ping' && <button type="button" onClick={() => {
          ping.current?.abort(new Error('Stopped waiting for the ping. A sent packet cannot be recalled.'))
        }}>Stop waiting</button>}
      </div>
      {ambiguousPing && <p>Prefix <code>{pingPrefix}</code> matches more than one known radio. Choose a wider ping hash.</p>}
    </details>}
    {pending && <p role="status">{pending === 'ping' ? 'Waiting for a ping reply…' : 'Saving to the radio…'}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
