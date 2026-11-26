import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/companion-session.ts'
import type { AdvancedDeviceEdits, DeviceDetails, DeviceEdits, DeviceSaveResult } from '../radio/device-settings.ts'
import type { CompanionDevice, RadioParameters } from '../radio/protocol.ts'
import './device-settings.css'

type Session = Pick<CompanionSession, 'getDeviceDetails' | 'saveDevicePreferences'>
type Draft = Partial<Record<string, string>>

const presets: { name: string; radio: RadioParameters }[] = [
  { name: 'USA / Canada', radio: { frequencyMHz: 910.525, bandwidthKHz: 62.5, spreadingFactor: 7, codingRate: 5 } },
  { name: 'EU / UK Narrow', radio: { frequencyMHz: 869.618, bandwidthKHz: 62.5, spreadingFactor: 8, codingRate: 8 } },
]
const radioFields = [
  { field: 'frequencyMHz', label: 'Frequency (MHz)', minimum: 150, maximum: 2500, step: 0.001 },
  { field: 'bandwidthKHz', label: 'Bandwidth (kHz)', minimum: 7, maximum: 500, step: 0.001 },
  { field: 'spreadingFactor', label: 'Spreading factor', minimum: 5, maximum: 12, step: 1 },
  { field: 'codingRate', label: 'Coding rate', minimum: 5, maximum: 8, step: 1 },
] as const
const policies = [['base', 'Base telemetry', 0], ['location', 'Location telemetry', 2], ['environment', 'Environment telemetry', 4]] as const
const savedFields: Record<string, readonly string[]> = {
  'Radio name': ['name'],
  'Advert position': ['latitude', 'longitude'],
  'Radio parameters and repeat mode': [...radioFields.map(({ field }) => field), 'repeat'],
  'Transmit power': ['txPower'],
  'Default path hash width': ['pathWidth'],
  'Advert and message policies': ['advertLocation', 'base', 'location', 'environment', 'extraAcknowledgements'],
}
const resultLabel = { saved: 'Saved', failed: 'Failed', uncertain: 'Result unknown', skipped: 'Skipped' }

function fields(device: CompanionDevice): Record<string, string> {
  const { capabilities, preferences, radioParameters } = device
  return {
    name: device.name,
    latitude: String(preferences.latitude),
    longitude: String(preferences.longitude),
    ...radioEntries(radioParameters),
    repeat: String(Number(capabilities.repeatEnabled)),
    txPower: String(preferences.txPowerDbm),
    pathWidth: capabilities.pathHashMode === null ? '' : String(capabilities.pathHashMode + 1),
    advertLocation: String(Number(preferences.advertLocation)),
    ...Object.fromEntries(policies.map(([field, , shift]) => [field, String(((preferences.telemetryPolicy ?? 0) >> shift) & 3)])),
    extraAcknowledgements: String(Number(preferences.extraAcknowledgements)),
  }
}

function radioEntries(radio?: RadioParameters) {
  return Object.fromEntries(radioFields.map(({ field }) => [field, radio ? String(radio[field]) : '']))
}

function buildEdits(draft: Draft, baseline: Record<string, string>): DeviceEdits {
  const text = (name: string) => draft[name] !== undefined && draft[name] !== baseline[name] ? draft[name] : undefined
  const number = (name: string) => {
    const value = text(name)
    return value === undefined || Number(value) === Number(baseline[name]) ? undefined : Number(value)
  }
  const getNumber = (name: string) => Number(draft[name] ?? baseline[name])
  const flag = (name: string) => text(name) === undefined ? undefined : number(name) === 1
  const edits: DeviceEdits = {
    name: text('name'),
    txPower: number('txPower'),
    pathWidth: number('pathWidth'),
    repeat: flag('repeat'),
    advertLocation: flag('advertLocation'),
    extraAcknowledgements: flag('extraAcknowledgements'),
  }
  if (number('latitude') !== undefined || number('longitude') !== undefined) {
    edits.position = { latitude: getNumber('latitude'), longitude: getNumber('longitude') }
  }
  if (radioFields.some(({ field }) => number(field) !== undefined)) {
    edits.radio = {
      frequencyMHz: getNumber('frequencyMHz'), bandwidthKHz: getNumber('bandwidthKHz'),
      spreadingFactor: getNumber('spreadingFactor'), codingRate: getNumber('codingRate'),
    }
  }
  if (policies.some(([field]) => number(field) !== undefined)) {
    edits.telemetry = { base: number('base'), location: number('location'), environment: number('environment') }
  }
  return edits
}

export default function DeviceSettingsPanel({ snapshot, session, radioBusy }: {
  snapshot: CompanionSnapshot
  session: Session
  radioBusy: boolean
}) {
  return <section className="preferences device-settings" aria-label="Radio device settings">
    <h2>Radio device settings</h2>
    {snapshot.device ? <DeviceSettings key={snapshot.device.publicKey} device={snapshot.device} session={session}
      ready={snapshot.phase === 'ready'} radioBusy={radioBusy}
      contactCount={snapshot.contacts.length} channelCount={snapshot.channels.length} />
      : <p>Connect a companion radio to view and change its settings.</p>}
  </section>
}

function DeviceSettings({ device, session, ready, radioBusy, contactCount, channelCount }: {
  device: CompanionDevice; session: Session; ready: boolean; radioBusy: boolean; contactCount: number; channelCount: number
}) {
  const { capabilities, preferences, publicKey } = device
  const [draft, setDraft] = useState<Draft>({})
  const [details, setDetails] = useState<DeviceDetails | null>(null)
  const [pending, setPending] = useState(false)
  const [results, setResults] = useState<DeviceSaveResult[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const disabled = !ready || pending || radioBusy
  const settings = fields(device)
  const control = (field: string) => ({
    value: draft[field] ?? settings[field],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.currentTarget.value
      setDraft((previous) => ({ ...previous, [field]: value }))
    },
  })
  const checked = (field: string) => ({
    checked: (draft[field] ?? settings[field]) === '1',
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.currentTarget.checked ? '1' : '0'
      setDraft((previous) => ({ ...previous, [field]: value }))
    },
  })

  async function readDetails() {
    setDetails(await session.getDeviceDetails(publicKey))
  }

  async function run(operation: () => Promise<void>) {
    if (disabled) return
    setPending(true)
    setResults([])
    setNotice('')
    setError('')
    try {
      await operation()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The radio action failed.')
    } finally {
      setPending(false)
    }
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const edits = buildEdits(draft, settings)
    if (!Object.values(edits).some((value) => value !== undefined)) {
      setResults([])
      setError('')
      setNotice('No changes to save.')
      return
    }
    if ((edits.radio || edits.repeat !== undefined || edits.txPower !== undefined || edits.pathWidth !== undefined ||
      edits.position || edits.advertLocation === true || edits.telemetry) &&
      !window.confirm('Save these radio settings? Radio parameters affect which mesh you can reach. The advert and telemetry settings control what other nodes can see.')) return
    void run(async () => {
      const saved = await session.saveDevicePreferences(publicKey, edits)
      setResults(saved)
      const applied = new Set(saved.filter(({ status }) => status === 'saved').flatMap(({ label }) => savedFields[label] ?? []))
      setDraft((previous) => Object.fromEntries(Object.entries(previous).filter(([field]) => !applied.has(field))))
    })
  }

  function saveAdvanced(edits: AdvancedDeviceEdits, confirmation: string, reload = true) {
    if (disabled) return
    if (!Object.values(edits).some((value) => value !== undefined)) {
      setResults([])
      setError('')
      setNotice('No changes to save.')
      return
    }
    if (!window.confirm(confirmation)) return
    void run(async () => {
      const saved = await session.saveDevicePreferences(publicKey, {}, edits)
      setResults(saved)
      if (reload && saved.some(({ status }) => status === 'saved')) await readDetails()
    })
  }

  return <>
    <dl className="device-summary">
      <div><dt>Device</dt><dd>{capabilities.manufacturer || device.name || 'MeshCore companion'}</dd></div>
      <div><dt>Firmware</dt><dd>{capabilities.firmwareVersion || 'Version unavailable'} · protocol v{capabilities.firmwareProtocolVersion}</dd></div>
      {capabilities.firmwareBuildDate && <div><dt>Build date</dt><dd>{capabilities.firmwareBuildDate}</dd></div>}
      <div><dt>Contact slots</dt><dd>{contactCount} / {capabilities.maxContacts}</dd></div>
      <div><dt>Channel slots</dt><dd>{channelCount} / {capabilities.maxChannels}</dd></div>
      {details?.storage && <div><dt>Radio storage</dt><dd>{details.storage.usedKb} / {details.storage.totalKb} KB</dd></div>}
    </dl>
    {!ready && <p>Connect this radio and finish syncing to make changes.</p>}
    <form className="device-form" onSubmit={saveSettings}>
      <fieldset disabled={disabled}>
        <legend>Identity and position</legend>
        <div className="device-fields">
          <label>Radio name<input required {...control('name')} /></label>
          <label>Latitude (°)<input type="number" min={-90} max={90} step={0.000001} required {...control('latitude')} /></label>
          <label>Longitude (°)<input type="number" min={-180} max={180} step={0.000001} required {...control('longitude')} /></label>
        </div>
        {preferences.advertLocation !== null && preferences.telemetryPolicy !== null && <label className="preference-check">
          <input type="checkbox" {...checked('advertLocation')} /> Include location in adverts
        </label>}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Radio parameters</legend>
        {device.radioParameters && (capabilities.firmwareProtocolVersion < 9 || capabilities.repeatEnabled !== null) ? <>
          <label className="device-preset">Load a preset
            <select value="" onChange={(event) => {
              if (!event.currentTarget.value) return
              const preset = presets[Number(event.currentTarget.value)]
              if (preset) setDraft((previous) => ({ ...previous, ...radioEntries(preset.radio) }))
            }}>
              <option value="">Choose a preset</option>
              {presets.map(({ name }, index) => <option key={name} value={index}>{name}</option>)}
            </select>
          </label>
          <div className="device-fields">{radioFields.map(({ field, label, minimum, maximum, step }) => (
            <label key={field}>{label}<input type="number" required min={minimum} max={maximum} step={step} {...control(field)} /></label>
          ))}</div>
        </> : <p>The radio did not report all settings needed to change its parameters.</p>}
        <div className="device-fields">
          <label>Transmit power (dBm)<input type="number" min={-9} max={preferences.maxTxPowerDbm} step={1} required {...control('txPower')} /></label>
          {capabilities.pathHashMode !== null && capabilities.pathHashMode < 3
            ? <label>Default path hash width<select {...control('pathWidth')}>
              <option value="1">1 byte</option><option value="2">2 bytes</option><option value="3">3 bytes</option>
            </select></label> : <p>Default path hash width editing is unavailable on this firmware.</p>}
        </div>
        {capabilities.repeatEnabled !== null && device.radioParameters
          ? <label className="preference-check"><input type="checkbox" {...checked('repeat')} /> Enable repeat mode</label>
          : <p>Repeat mode editing is unavailable on this firmware.</p>}
        {details?.repeatRanges && <p>Repeat frequencies reported by the radio: {details.repeatRanges.map(({ minimumMHz, maximumMHz }) =>
          minimumMHz === maximumMHz ? minimumMHz : `${minimumMHz}–${maximumMHz}`).join(', ') || 'none'} MHz</p>}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Telemetry and messages</legend>
        {preferences.telemetryPolicy !== null ? <div className="device-fields">
          {policies.map(([field, label]) => <label key={field}>{label}<select {...control(field)}>
            <option value="0">Deny</option><option value="1">Use contact permissions</option><option value="2">Allow all</option>
            {settings[field] === '3' && <option value="3" disabled>Unknown firmware setting</option>}
          </select></label>)}
        </div> : <p>Telemetry policies are unavailable on this firmware.</p>}
        {preferences.extraAcknowledgements !== null && preferences.advertLocation !== null && <label className="preference-check">
          <input type="checkbox" {...checked('extraAcknowledgements')} /> Send extra acknowledgements
        </label>}
        <a href="#discovery">Manage radio auto-add policy in Discovery</a>
      </fieldset>
      <div className="device-actions"><button type="submit" disabled={disabled}>Save radio settings</button></div>
    </form>
    <details>
      <summary>Advanced radio settings</summary>
      <div className="device-advanced">
        <div className="device-actions">
          <button type="button" disabled={disabled} onClick={() => void run(readDetails)}>Read advanced settings</button>
        </div>
        {details && <AdvancedSettings details={details} disabled={disabled} firmware={capabilities.firmwareProtocolVersion}
          save={saveAdvanced} />}
      </div>
    </details>
    {pending && <p role="status">Working with the radio…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {results.length > 0 && <ul className="device-results" aria-label="Radio settings results" aria-live="polite">
      {results.map(({ label, status, reason }) => <li key={label}>
        <strong>{label}</strong> · {resultLabel[status]}{reason ? `. ${reason}` : ''}
      </li>)}
    </ul>}
  </>
}

function AdvancedSettings({ details, firmware, disabled, save }: {
  details: DeviceDetails; firmware: number; disabled: boolean
  save: (edits: AdvancedDeviceEdits, confirmation: string, reload?: boolean) => void
}) {
  const { region, gps, wifi } = details
  return <>
    <fieldset disabled={disabled}>
      <legend>Radio clock</legend>
      {details.clock === null ? <p>The radio clock is unavailable.</p> : <>
        <p>Last read {new Date(details.clock * 1_000).toLocaleString()}</p>
        <button type="button" onClick={() => save({ syncClock: true }, 'Advance the radio clock to this browser’s current time?')}>
          Sync radio clock
        </button>
      </>}
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Default region</legend>
      {region ? <form key={region.name ?? ''} className="device-form" onSubmit={(event) => {
        event.preventDefault()
        const name = String(new FormData(event.currentTarget).get('region')).trim()
        save({ region: name || null }, name
          ? 'Set this default flood region with the key derived from its name? This replaces the radio’s current default region key.'
          : 'Clear the radio’s default flood region?')
      }}>
        <label className="device-preset">Region name<input name="region" defaultValue={region.name ?? ''} /></label>
        <p>Leave the name empty to clear the radio’s default flood region.</p>
        <button type="submit">Save default region</button>
      </form> : <p>Default flood region settings are unavailable on this firmware.</p>}
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>GPS</legend>
      {gps ? <form className="device-form" key={`${gps.enabled}:${gps.intervalSeconds}`} onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const enabled = form.has('gps')
        const interval = gps.intervalSeconds === null ? undefined : Number(form.get('gpsInterval'))
        save({
          gpsEnabled: enabled === gps.enabled ? undefined : enabled,
          gpsIntervalSeconds: interval === gps.intervalSeconds ? undefined : interval,
        }, 'Save GPS settings on this radio?')
      }}>
        <label className="preference-check"><input type="checkbox" name="gps" defaultChecked={gps.enabled} /> Enable GPS</label>
        {gps.intervalSeconds !== null &&
          <label className="device-preset">GPS interval (seconds)<input name="gpsInterval" type="number" min={0} max={86400}
            defaultValue={gps.intervalSeconds} required /></label>}
        <button type="submit">Save GPS settings</button>
      </form> : <p>This radio does not advertise configurable GPS.</p>}
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Bluetooth pairing</legend>
      {firmware >= 5 ? <form className="device-form" onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const pin = String(new FormData(form).get('pin'))
        form.reset()
        save({ pin }, 'Change the radio pairing PIN? The new PIN takes effect after restarting the radio.', false)
      }}>
        <label className="device-preset">New BLE PIN<input type="password" name="pin" inputMode="numeric" required
          pattern="0|[1-9][0-9]{5}" autoComplete="new-password" /></label>
        <p>Use six digits from 100000 to 999999, or 0 for the firmware default.</p>
        <button type="submit">Set BLE PIN</button>
      </form> : <p>PIN editing is unavailable on this firmware.</p>}
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Radio Wi-Fi</legend>
      {wifi ? <form className="device-form" key={`${wifi.enabled}:${wifi.ssid}`} onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        const ssid = String(data.get('ssid'))
        const password = String(data.get('password'))
        const wifiEnabled = data.has('enabled')
        const field = form.elements.namedItem('password')
        if (field instanceof HTMLInputElement) field.value = ''
        save({
          wifiSsid: ssid && ssid !== wifi.ssid ? ssid : undefined,
          wifiPassword: data.has('clearPassword') ? '' : password || undefined,
          wifiEnabled: wifiEnabled === wifi.enabled ? undefined : wifiEnabled,
        }, 'Save Wi-Fi settings on this radio? Restart the radio to apply the changes.')
      }}>
        <label className="preference-check"><input type="checkbox" name="enabled" defaultChecked={wifi.enabled} /> Enable device Wi-Fi</label>
        <div className="device-fields">
          <label>Wi-Fi network name<input name="ssid" defaultValue={wifi.ssid ?? ''} autoComplete="off" /></label>
          <label>New Wi-Fi password<input name="password" type="password" autoComplete="new-password" /></label>
        </div>
        <label className="preference-check"><input type="checkbox" name="clearPassword" /> Clear the saved Wi-Fi password</label>
        <p>Leave the password blank to keep it. Packet Pigeon connects over USB or Bluetooth.</p>
        <button type="submit">Save Wi-Fi settings</button>
      </form> : <p>This firmware build does not advertise Wi-Fi configuration.</p>}
    </fieldset>
  </>
}
