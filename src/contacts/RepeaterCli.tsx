import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { MessageSync } from '../integration/message-sync.ts'
import type { CompanionSession } from '../radio/companion-session.ts'
import {
  parseRepeaterNeighbors, repeaterCliCommand, repeaterCliCommands, repeaterNameCommand, repeaterOwnerInfoCommand,
  repeaterPositionCommand, repeaterRegionQuery, repeaterHomeRegionCommand, UncertainRepeaterCliError,
} from '../radio/repeater-cli.ts'
import type { RepeaterCliReceipt } from '../radio/repeater-cli.ts'
import { mapPosition } from '../map/nodes.ts'
import { resolvePath } from '../paths/model.ts'
import type { MapPath, PathNode } from '../paths/model.ts'
import type { Coordinates } from '../map/nodes.ts'

export type RepeaterMessageSync = Pick<MessageSync, 'subscribe' | 'getSnapshot' | 'subscribeToSavedReceipts' | 'sync'>

type Props = {
  session: Pick<CompanionSession, 'sendRepeaterCommand'>
  messageSync: RepeaterMessageSync
  radioKey: string
  contactKey: string
  name: string
  route: { pathLength: number; pathHex: string }
  ready: boolean
  busy: boolean
  onPending: (pending: boolean) => void
  onReboot: (notice: string) => void
  neighborNodes: readonly PathNode[]
  repeaterPosition: Coordinates | null
  onMap?: (path: MapPath) => void
}

type HistoryEntry = {
  command: string
  description: string
  tag: string
  route: RepeaterCliReceipt['route'] | null
  deadline: number
  reply: { text: string; syncedAt: number } | null
  unconfirmed: boolean
}

const neighborTiming = 'Ages are seconds since heard when the repeater generated the reply; the reply may have been delayed before syncing.'

export function RepeaterCli({ session, messageSync, radioKey, contactKey, name, route, ready, busy, onPending, onReboot,
  neighborNodes, repeaterPosition, onMap }: Props) {
  const ownerInfoId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [intervalKind, setIntervalKind] = useState<'advert.interval' | 'flood.advert.interval'>('advert.interval')
  const [interval, setInterval] = useState('')
  const [floodLimitKind, setFloodLimitKind] = useState<'flood.max' | 'flood.max.unscoped' | 'flood.max.advert'>('flood.max')
  const [floodLimit, setFloodLimit] = useState('')
  const [loopDetection, setLoopDetection] = useState('')
  const [pathHashMode, setPathHashMode] = useState('')
  const [regionName, setRegionName] = useState('')
  const [homeRegion, setHomeRegion] = useState('')
  const [ownerInfo, setOwnerInfo] = useState('')
  const [repeaterName, setRepeaterName] = useState('')
  const [advertPolicy, setAdvertPolicy] = useState('')
  const powerSavingCommands = repeaterCliCommands.filter((item) =>
    item.command === 'powersaving on' || item.command === 'powersaving off')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState(false)
  const [syncRequested, setSyncRequested] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const syncStatus = useSyncExternalStore(messageSync.subscribe, messageSync.getSnapshot)
  const term = query.trim().toLowerCase()
  const choices = repeaterCliCommands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(term))
  const matchingHistory = history.filter((item) =>
    `${item.command} ${item.description} ${item.reply?.text ?? ''}`.toLowerCase().includes(term))
  const action = repeaterCliCommands.find((item) => item.command === selected)
  const regionActions = repeaterCliCommands.filter((item) =>
    item.command === 'region allowf *' || item.command === 'region denyf *' || item.command === 'region save')

  useEffect(() => messageSync.subscribeToSavedReceipts((key, message) => {
    const receipt = message.receipt
    if (key !== radioKey || receipt?.kind !== 'direct-text' || receipt.textType !== 1 ||
      receipt.senderKeyPrefix !== contactKey.slice(0, 12) || receipt.text[2] !== '|') return
    const tag = receipt.text.slice(0, 2)
    const syncedAt = Date.now()
    setHistory((current) => current.map((item) => item.tag === tag && item.reply === null
      ? { ...item, reply: { text: receipt.text.slice(3).trimStart(), syncedAt } } : item))
  }), [messageSync, radioKey, contactKey])

  useEffect(() => {
    const next = history.reduce((earliest, item) =>
      item.reply === null && item.deadline > now ? Math.min(earliest, item.deadline) : earliest, Infinity)
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now()))
    return () => clearTimeout(timer)
  }, [history, now])

  useEffect(() => () => request.current?.abort(new Error('Stopped waiting for the radio.')), [])

  async function send(command: string, description: string, confirmed: boolean, warning = '') {
    if (!ready || busy || pending || syncStatus.syncing) return
    const target = command === 'reboot' ? `${name} (${contactKey.slice(0, 12)})` : name
    if (confirmed && !window.confirm(`${description} on ${target}? This will transmit over the mesh.${warning ? ` ${warning}` : ''}`)) return
    if (term && !`${command} ${description}`.toLowerCase().includes(term)) setQuery('')
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    onPending(true)
    setError('')
    try {
      const result = await session.sendRepeaterCommand(radioKey, contactKey, route, command, confirmed, controller.signal)
      if (command === 'reboot') {
        onReboot(`Reboot accepted by the radio (${result.route}), but execution is unverified. No reply is expected. Log in again when the repeater is available; a delayed reboot may still arrive.`)
        return
      }
      const sentAt = Date.now()
      setNow(sentAt)
      setHistory((current) => [...current.slice(-99), {
        command, description, tag: result.tag, route: result.route, deadline: sentAt + result.timeoutMs,
        reply: null, unconfirmed: false,
      }])
    } catch (reason) {
      if (command === 'reboot' && reason instanceof UncertainRepeaterCliError) {
        onReboot('The radio may have sent the reboot but did not confirm it. No reply is expected. Log in again when the repeater is available; a delayed reboot may still arrive.')
        return
      }
      if (command === 'reboot') {
        const detail = reason instanceof Error ? reason.message : 'The repeater command failed.'
        onReboot(`Reboot was not confirmed: ${detail} If sent, it may still arrive without a reply. Log in again when the repeater is available.`)
        return
      }
      if (reason instanceof UncertainRepeaterCliError) {
        const sentAt = Date.now()
        setNow(sentAt)
        setHistory((current) => [...current.slice(-99), {
          command, description, tag: reason.tag, route: null, deadline: sentAt + 120_000,
          reply: null, unconfirmed: true,
        }])
      }
      setError(reason instanceof Error ? reason.message : 'The repeater command failed.')
    } finally {
      if (request.current === controller) request.current = null
      setPending(false)
      onPending(false)
    }
  }

  function sendChoice(item: (typeof repeaterCliCommands)[number]) {
    void send(item.command, item.description, 'confirm' in item && item.confirm,
      'warning' in item ? item.warning : '')
  }

  function submitInterval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set ${intervalKind} ${interval}`)
      const unit = intervalKind === 'advert.interval' ? 'minutes' : 'hours'
      const description = interval === '0' ? `Disable ${intervalKind === 'advert.interval' ? 'local' : 'flood'} advertisements`
        : `${command.description} to ${interval} ${unit}`
      void send(command.command, description, true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid advertisement interval.')
    }
  }

  function submitOwnerInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterOwnerInfoCommand(ownerInfo)
      const description = ownerInfo ? 'Replace owner information' : 'Clear owner information'
      const preview = ownerInfo ? `\n\n${ownerInfo}` : ''
      void send(command.command, description, true,
        `This information can be requested over the mesh. Do not include passwords or private data.${preview}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid owner information.')
    }
  }

  function submitFloodLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set ${floodLimitKind} ${floodLimit}`)
      void send(command.command, `${command.description} to ${floodLimit}`, true,
        'Lower limits can disrupt mesh routes and remote access. Zero stops forwarding matching floods. Other applicable limits can be more restrictive.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid flood hop limit.')
    }
  }

  function submitLoopDetection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set loop.detect ${loopDetection}`)
      const warning = loopDetection === 'off'
        ? 'This disables flood loop detection.'
        : 'This can drop flooded packets when this repeater ID/hash repeats in the route. Stricter modes drop at lower repetition counts and may reduce reachability. Requires repeater firmware v1.14 or later.'
      void send(command.command, command.description, true, warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Choose a supported loop detection mode.')
    }
  }

  function submitPathHashMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterCliCommand(`set path.hash.mode ${pathHashMode}`)
      const mode = Number(pathHashMode)
      const hashBytes = mode + 1
      const warning = mode === 0
        ? 'This uses one-byte hashes for this repeater\'s manual flood advertisements.'
        : `This uses ${hashBytes}-byte hashes for this repeater's manual flood advertisements. On repeater v1.14.0 scheduled flood advertisements still use one-byte hashes. Repeater firmware v1.13 or earlier drops packets with multi-byte path hashes, which can limit flood propagation. Confirm the mesh is sufficiently upgraded first.`
      void send(command.command, command.description, true, warning)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Choose a supported advert path hash size.')
    }
  }

  function submitRegionQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterRegionQuery(regionName)
      void send(command.command, command.description, false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid region name.')
    }
  }

  function submitHomeRegion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterHomeRegionCommand(homeRegion)
      void send(command.command, command.description, 'confirm' in command && command.confirm,
        'warning' in command ? command.warning : '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid home region.')
    }
  }

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterNameCommand(repeaterName)
      void send(command.command, `Set repeater name to "${repeaterName}"`, true,
        'This changes the advertised name, not the public key. An advertisement is not sent automatically.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid repeater name.')
    }
  }

  function submitPosition(event: FormEvent<HTMLFormElement>, axis: 'lat' | 'lon', value: string) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    try {
      const command = repeaterPositionCommand(axis, value)
      const coordinate = axis === 'lat' ? 'latitude' : 'longitude'
      void send(command.command, `Set stored ${coordinate} to ${value}`,
        true, 'Advertisements use stored coordinates only when the GPS advert policy is prefs.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid advertised position.')
    }
  }

  function submitAdvertPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || pending || syncStatus.syncing) return
    const command = repeaterCliCommands.find((item) => item.command === `gps advert ${advertPolicy}`)
    if (!command) {
      setError('Choose a supported GPS advert policy.')
      return
    }
    sendChoice(command)
  }

  return <details>
    <summary>Administrator CLI</summary>
    <p>Choose a supported query or confirmed management action. Commands are never retried automatically.
      Replies are saved with other messages when you sync; history here lasts while this repeater stays selected.</p>
    <p>Companion firmware v1.11 and earlier may cause CLI commands to be ignored. Upgrade the companion firmware if commands do not receive replies.</p>
    <p>Reply tags help match responses, but a delayed reply from an earlier browser session can still be mistaken for a new one.</p>
    <label>Search CLI commands and history
      <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
    </label>
    <ul className="repeater-cli-choices" aria-label="Available CLI commands">
      {choices.map((item) => <li key={item.command}>
        <button type="button" aria-pressed={selected === item.command} disabled={!ready || busy || pending}
          onClick={() => setSelected(item.command)}><code>{item.command}</code> — {item.description}</button>
      </li>)}
    </ul>
    {!choices.length && <p>No commands match.</p>}
    {selected === 'neighbors' && <p>Each reply line is a four-byte key prefix, seconds since heard, and SNR multiplied by 4, separated by colons.
      The list is limited by the repeater. Only unique matches with saved coordinates can be mapped; separate dots do not imply a route.</p>}
    <div className="contact-actions">
      <button type="button" disabled={!action || !ready || busy || pending || syncStatus.syncing} onClick={() => {
        if (action) sendChoice(action)
      }}>
        {action ? `Send ${action.command}` : 'Select a command'}
      </button>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing} onClick={() => {
        setSyncRequested(true)
        void messageSync.sync()
      }}>Sync messages for replies</button>
      <button type="button" disabled={!history.length || pending} onClick={() => setHistory([])}>Clear CLI history</button>
    </div>
    <details>
      <summary>Inspect repeater regions</summary>
      <p>The read controls do not change regions; setting the home region below changes the active map. The tree reply
        may be truncated without an indication, so it is not a
        complete inventory. In the tree, <code>F</code> marks flood permission, <code>^</code> marks the home region,
        and <code>*</code> is the wildcard for unscoped floods. Other routing rules can still block forwarding.</p>
      <p>Individual queries use firmware prefix matching: an exact match is preferred, but an incomplete or ambiguous
        prefix can return a different region. Compare the returned name. Region-tree replies require repeater firmware
        v1.12 or later; other query support varies by firmware.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region', 'Read the region tree', false)}>Read region tree</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region home', 'Read the home region', false)}>Read home region</button>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region default', 'Read the default scope region', false)}>Read default scope region</button>
      </div>
      <form className="contact-actions" onSubmit={submitRegionQuery}>
        <label>Region name or prefix
          <input type="text" required value={regionName} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRegionName(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Read region</button>
      </form>
      <p>The home region is the entry marked <code>^</code> in the tree. Firmware prefers an exact name, but a prefix can select a different region;
        compare the reply and read the home setting again. Setting <code>*</code> marks the wildcard as home. Changes are active but not saved
        until you separately save the entire region map.</p>
      <form className="contact-actions" onSubmit={submitHomeRegion}>
        <label>Home region name or prefix (<code>*</code> for wildcard)
          <input type="text" required value={homeRegion} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setHomeRegion(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set home region</button>
      </form>
      <p>Unscoped flood forwarding can be changed for the wildcard region only. Denying it can disrupt mesh routes
        and remote access. Other routing rules can still block forwarding when allowed. Changes affect the live map
        but are not saved by these commands. Sync the reply and read the wildcard state before deciding whether to save.</p>
      <p>Saving is separate and writes the entire current region map, including unrelated changes by other administrators.
        Radio acceptance alone does not confirm the change or save.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('region get *', 'Read wildcard region', false)}>Read wildcard region</button>
        {regionActions.map((item) => <button key={item.command} type="button"
          disabled={!ready || busy || pending || syncStatus.syncing} onClick={() => sendChoice(item)}>{item.description}</button>)}
      </div>
    </details>
    <details>
      <summary>Change flood hop limits</summary>
      <p>These limits apply to forwarded flood packets, not direct packets. The overall limit applies to all floods;
        the unscoped and advertisement limits also apply to their matching packets. The lowest applicable limit wins.
        Zero stops forwarding matching floods and can disrupt routes or remote access. Other routing and region
        rules still apply.</p>
      <p>Verify firmware support before using a specific limit: some older firmware answers its query with the overall
        limit instead, so a numeric reply does not prove support. If an unscoped query returns 255, it indicates an
        unset value tracking the overall limit; these controls cannot restore that unset state after changing it.</p>
      <form className="contact-actions" onSubmit={submitFloodLimit}>
        <label>Flood limit type
          <select value={floodLimitKind} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'flood.max' || value === 'flood.max.unscoped' || value === 'flood.max.advert') setFloodLimitKind(value)
            }}>
            <option value="flood.max">Overall</option>
            <option value="flood.max.unscoped">Unscoped</option>
            <option value="flood.max.advert">Advertisement</option>
          </select>
        </label>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send(`get ${floodLimitKind}`, `Read ${floodLimitKind} hop limit`, false)}>Read selected limit</button>
        <label>Flood hop limit (0 to 64)
          <input type="text" inputMode="numeric" required value={floodLimit}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setFloodLimit(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set flood hop limit</button>
      </form>
    </details>
    <details>
      <summary>Change flood loop detection</summary>
      <p>Loop detection only checks forwarded flood packets for repeated occurrences of this repeater's ID/hash in
        their path. Thresholds for 1-, 2-, and 3-byte path hashes are: minimal (4/2/1), moderate (2/1/1), and strict
        (1/1/1). Off disables the check. More restrictive modes can drop flooded packets and reduce reachability.
        This CLI setting requires repeater firmware v1.14 or later.</p>
      <form className="contact-actions" onSubmit={submitLoopDetection}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get loop.detect', 'Read flood loop detection mode', false)}>Read current mode</button>
        <label>New flood loop detection mode
          <select required value={loopDetection} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setLoopDetection(event.currentTarget.value)}>
            <option value="">Choose a mode</option>
            <option value="off">Off</option>
            <option value="minimal">Minimal</option>
            <option value="moderate">Moderate</option>
            <option value="strict">Strict</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set loop detection</button>
      </form>
    </details>
    <details>
      <summary>Change advert path hash size</summary>
      <p>This controls the hash width used in this repeater's manual flood advertisements, not the hash widths of packets it
        forwards. On repeater v1.14.0, scheduled flood advertisements still use one-byte hashes; v1.14.1 and later also
        apply the setting to scheduled flood advertisements. Repeater firmware v1.14 and later can forward all supported hash widths. Repeater
        firmware v1.13 and earlier drops multi-byte path hashes, so enabling them can limit flood propagation across a mixed-version mesh.
        Modes 0, 1, and 2 use 1, 2, and 3 bytes (256, 65,536, and 16,777,216 possible IDs), respectively; their
        paths can encode at most 63, 32, and 21 hops. This setting requires repeater firmware v1.14 or later.</p>
      <form className="contact-actions" onSubmit={submitPathHashMode}>
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('get path.hash.mode', 'Read advert path hash size', false)}>Read current size</button>
        <label>New advert path hash size
          <select required value={pathHashMode} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setPathHashMode(event.currentTarget.value)}>
            <option value="">Choose a size</option>
            <option value="0">1 byte — 256 IDs, up to 63 encoded hops</option>
            <option value="1">2 bytes — 65,536 IDs, up to 32 encoded hops</option>
            <option value="2">3 bytes — 16,777,216 IDs, up to 21 encoded hops</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set advert hash size</button>
      </form>
    </details>
    <details>
      <summary>Change repeater power-saving preference</summary>
      <p>Depending on the board and firmware, enabling this preference may let the repeater sleep when idle and be less responsive.
        An <code>on</code> reply reports the preference, not actual sleep; for example, Pico W repeater firmware v1.14.1 does not implement sleep.
        Read the preference explicitly; sync each reply and check it after changing it. Radio acceptance alone does not confirm the command succeeded.</p>
      <div className="contact-actions">
        <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
          onClick={() => void send('powersaving', 'Read repeater power-saving preference', false)}>Read power-saving preference</button>
        {powerSavingCommands.map((item) => (
          <button key={item.command} type="button" disabled={!ready || busy || pending || syncStatus.syncing}
            onClick={() => sendChoice(item)}>{item.description}</button>
        ))}
      </div>
    </details>
    <details>
      <summary>Change advertisement interval</summary>
      <p>Changing an interval affects future transmissions. Use 0 to disable. Local intervals are even minutes
        from 60 to 240; flood intervals are hours from 3 to 168.</p>
      <form className="contact-actions" onSubmit={submitInterval}>
        <label>Advertisement interval type
          <select value={intervalKind} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'advert.interval' || value === 'flood.advert.interval') setIntervalKind(value)
            }}>
            <option value="advert.interval">Local (minutes)</option>
            <option value="flood.advert.interval">Flood (hours)</option>
          </select>
        </label>
        <label>Interval value
          <input type="number" min="0" step="1" required value={interval}
            disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setInterval(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set interval</button>
      </form>
    </details>
    <details>
      <summary>Change repeater name</summary>
      <p>The field starts empty. Read the stored name first; this does not change the public key or send an advertisement.
        Advertisements can show a shorter name when they include location. Names must be 1 to 31 UTF-8 bytes,
        without leading or trailing spaces, control characters, or <code>[]/\:,?*</code>.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('get name', 'Read the advertised name', false)}>Read repeater name</button>
      <form className="contact-actions" onSubmit={submitName}>
        <label>New repeater name
          <input type="text" required value={repeaterName} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setRepeaterName(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set repeater name</button>
      </form>
    </details>
    <details>
      <summary>Change owner information</summary>
      <p>Replaces the current owner information. It can be requested over the mesh; do not include passwords or private data.
        Repeater firmware v1.12 or later is required. The field starts empty; use get owner.info to read the current value.
        Use line breaks instead of |, and leave blank to clear.</p>
      <form className="repeater-owner-form" onSubmit={submitOwnerInfo}>
        <label htmlFor={ownerInfoId}>Owner information</label>
        <textarea id={ownerInfoId} rows={4} value={ownerInfo} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setOwnerInfo(event.currentTarget.value)} />
        <p>Maximum 119 UTF-8 bytes, including line breaks.</p>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set owner information</button>
      </form>
    </details>
    <details>
      <summary>Change stored position</summary>
      <p>Advertisements use these stored coordinates only when the GPS advert policy is <code>prefs</code>.
        Policy <code>none</code> omits location; <code>share</code> uses sensor coordinates.
        Read the current values with <code>get lat</code> and <code>get lon</code>. Changing one coordinate does not change the other.</p>
      <p>Check the policy explicitly below. Some firmware builds do not support this command; an unsupported reply does not establish the policy.
        Changes affect newly created advertisements but do not send one or recall already queued or transmitted locations. Sensor coordinates may be stale or zero;
        selecting share does not enable GPS. Sync replies and read the policy again to check the change.</p>
      <button type="button" disabled={!ready || busy || pending || syncStatus.syncing}
        onClick={() => void send('gps advert', 'Read GPS advert policy', false)}>Read GPS advert policy</button>
      <form className="contact-actions" onSubmit={submitAdvertPolicy}>
        <label>New GPS advert policy
          <select required value={advertPolicy} disabled={!ready || busy || pending || syncStatus.syncing}
            onChange={(event) => setAdvertPolicy(event.currentTarget.value)}>
            <option value="">Choose a policy</option>
            <option value="none">None — omit location</option>
            <option value="prefs">Prefs — stored coordinates</option>
            <option value="share">Share — sensor coordinates</option>
          </select>
        </label>
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set GPS advert policy</button>
      </form>
      <form className="repeater-position-form" onSubmit={(event) => submitPosition(event, 'lat', latitude)}>
        <label htmlFor={`${ownerInfoId}-latitude`}>Latitude (-90 to 90)</label>
        <input id={`${ownerInfoId}-latitude`} type="text" inputMode="decimal" required
          value={latitude} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setLatitude(event.currentTarget.value)} />
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set latitude</button>
      </form>
      <form className="repeater-position-form" onSubmit={(event) => submitPosition(event, 'lon', longitude)}>
        <label htmlFor={`${ownerInfoId}-longitude`}>Longitude (-180 to 180)</label>
        <input id={`${ownerInfoId}-longitude`} type="text" inputMode="decimal" required
          value={longitude} disabled={!ready || busy || pending || syncStatus.syncing}
          onChange={(event) => setLongitude(event.currentTarget.value)} />
        <button type="submit" disabled={!ready || busy || pending || syncStatus.syncing}>Set longitude</button>
      </form>
    </details>
    {pending && <p role="status">Sending to the radio…</p>}
    {syncRequested && syncStatus.error && <p role="alert">{syncStatus.error}</p>}
    {error && <p role="alert">{error}</p>}
    <h4>CLI history</h4>
    {!history.length ? <p>No commands sent in this view.</p> : !matchingHistory.length ? <p>No history matches.</p> :
      <ol className="repeater-cli-history">
        {[...matchingHistory].reverse().map((item) => <li key={item.tag}>
          <strong><code>{item.command}</code></strong>
          <span> · {item.unconfirmed ? 'Send unconfirmed' : `Accepted by radio (${item.route})`}</span>
          {item.reply !== null ? <pre>{item.reply.text || '(empty reply)'}</pre> :
            <p>{now >= item.deadline ? 'No reply synced before the deadline. It may still arrive.' :
              'Waiting for a reply. Sync messages to check.'}</p>}
          {item.command === 'region' && item.reply !== null &&
            <p className="contact-status">The region tree may be truncated without an indication; it is not a complete inventory.
              F marks flood permission, ^ marks the home region, and * is the unscoped wildcard.</p>}
          {item.command.startsWith('region get ') && item.reply !== null &&
            <p className="contact-status">Firmware may match a prefix to a different region. Compare the returned name.</p>}
          {item.command === 'powersaving' && item.reply !== null &&
            <p className="contact-status">An on reply reports the preference, not actual sleep; behavior depends on the board and firmware.</p>}
          {item.command === 'neighbors' && item.reply !== null &&
            <NeighborReport reply={item.reply.text} syncedAt={item.reply.syncedAt} name={name} repeaterPosition={repeaterPosition}
              nodes={neighborNodes} onMap={onMap} />}
        </li>)}
      </ol>}
  </details>
}

function NeighborReport({ reply, syncedAt, name, repeaterPosition, nodes, onMap }: {
  reply: string
  syncedAt: number
  name: string
  repeaterPosition: Coordinates | null
  nodes: readonly PathNode[]
  onMap?: (path: MapPath) => void
}) {
  const date = new Date(syncedAt)
  const syncTime = date.toLocaleString()
  const timing = <p className="contact-status">Reply synced <time dateTime={date.toISOString()}>{syncTime}</time> (browser time). {neighborTiming}</p>
  let neighbors
  try {
    neighbors = parseRepeaterNeighbors(reply)
  } catch (reason) {
    return <>{timing}<p className="contact-status">{reason instanceof Error ? reason.message : 'The neighbor list could not be read.'}</p></>
  }
  if (!neighbors.length) return <>{timing}<p className="contact-status">No neighbors were reported.</p></>

  const resolved = neighbors.map((neighbor) => ({
    ...neighbor,
    matches: resolvePath([neighbor.keyPrefix], nodes)[0].matches,
  }))
  const mappedCount = resolved.filter(({ matches }) => matches.length === 1 && mapPosition(matches[0].position)).length
  const path: MapPath = {
    title: `Neighbors heard by ${name}`,
    description: `Reply synced ${syncTime} (browser time). ${neighborTiming}`,
    connect: false,
    points: [
      { label: `${name} (repeater)`, position: repeaterPosition },
      ...resolved.map(({ keyPrefix, secondsAgo, snrQuarterDb, matches }) => ({
        label: `${matches.length === 1 ? matches[0].name : `${keyPrefix} (${matches.length ? 'ambiguous prefix' : 'not in saved contacts'})`} · reported age ${secondsAgo}s at reply · SNR ${snrQuarterDb / 4} dB`,
        position: matches.length === 1 ? matches[0].position : null,
      })),
    ],
  }
  return <div className="repeater-neighbor-report">
    {timing}
    <ul aria-label="Neighbors in reply">
      {resolved.map(({ keyPrefix, secondsAgo, snrQuarterDb, matches }, index) => <li key={`${keyPrefix}:${index}`}>
        {matches.length === 1 ? matches[0].name : keyPrefix} · reported age {secondsAgo}s at reply · {snrQuarterDb / 4} dB
        {matches.length > 1 ? ' · Ambiguous saved-contact prefix; not mapped'
          : matches.length === 0 ? ' · Not in saved contacts'
            : !mapPosition(matches[0].position) ? ' · Position unavailable' : ''}
      </li>)}
    </ul>
    {onMap && <button type="button" disabled={!mappedCount} onClick={() => onMap(path)}>
      Show known neighbors on map
    </button>}
    {!mappedCount && <p className="contact-status">No uniquely matched neighbors have mappable saved positions.</p>}
  </div>
}
