import { useEffect, useRef, useState } from 'react'
import type { CompanionSnapshot } from '../radio/companion-session.ts'
import type { IdentityRecoveryPreparation } from '../radio/identity-backup.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioKey } from '../storage/index.ts'
import { exportBackup, exportLocalArchive, restoreBackup } from './device-backup.ts'
import type { BackupResult, BackupSession } from './device-backup.ts'
import { backupOptions, maxBackupBytes, parseBackup } from './model.ts'
import type { BackupData, BackupSection } from './model.ts'
import './backup.css'

const secretSections = new Set<BackupSection>(['identity', 'channels', 'regions'])
const defaultExport = new Set<BackupSection>(['name', 'radio', 'position', 'other', 'autoAdd', 'contacts'])
const label = { saved: 'Saved', matched: 'Already on radio', failed: 'Failed', uncertain: 'Unconfirmed', skipped: 'Skipped' }
type Preview = { file: string; source?: string; fields: Partial<Record<BackupSection, string>>; names: string[] }

function describe(data: BackupData, file: string): Preview {
  const { radio, position, other, autoAdd, channels, contacts, regions } = data
  return {
    file, source: data.source,
    names: [
      ...(channels ?? []).map(({ name }) => `Channel: ${name}`),
      ...(contacts ?? []).map(({ name, publicKey }) => `Contact: ${name} (${publicKey.slice(0, 12)})`),
      ...(regions ?? []).map(({ name }) => `Region: ${name}`),
    ],
    fields: {
      name: data.name,
      identity: data.identity?.publicKey,
      radio: radio === undefined ? undefined : [
        radio.settings && `${radio.settings.frequencyMHz} MHz · ${radio.settings.bandwidthKHz} kHz · SF${radio.settings.spreadingFactor} · CR${radio.settings.codingRate}`,
        radio.txPower === undefined ? null : `${radio.txPower} dBm`,
        radio.pathWidth === undefined ? null : `${radio.pathWidth}-byte path hashes`,
      ].filter(Boolean).join(' · '),
      position: position ? `${position.latitude}, ${position.longitude}` : undefined,
      other: other ? 'Advert, telemetry, acknowledgement or contact-mode settings' : undefined,
      autoAdd: autoAdd ? 'Contact roles, overwrite behavior and hop limit' : undefined,
      channels: channels ? `${channels.length} channels · keys hidden` : undefined,
      contacts: contacts ? `${contacts.length} contacts · includes saved routes and permissions where present` : undefined,
      regions: regions ? `${regions.length} saved regions · keys hidden${data.defaultRegion === undefined ? ''
        : data.defaultRegion === null ? ' · clears the radio default' : ` · default ${data.defaultRegion.name}`}` : undefined,
    },
  }
}

function download(name: string, json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function toggle(set: ReadonlySet<BackupSection>, section: BackupSection) {
  const next = new Set(set)
  if (next.has(section)) next.delete(section)
  else next.add(section)
  return next
}

export default function BackupPanel({ snapshot, session, radioBusy, canPurge, onCacheChanged }: {
  snapshot: CompanionSnapshot
  session: BackupSession
  radioBusy: boolean
  canPurge: boolean
  onCacheChanged: (key: RadioKey, purged?: boolean) => void
}) {
  const [keys, setKeys] = useState<RadioKey[]>([])
  const [choice, setChoice] = useState<RadioKey | '' | null>(null)
  const [revision, setRevision] = useState(0)
  const [exportSelection, setExportSelection] = useState(defaultExport)
  const [importSelection, setImportSelection] = useState(() => new Set<BackupSection>())
  const [preview, setPreview] = useState<Preview | null>(null)
  const [results, setResults] = useState<BackupResult[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preparation, setPreparation] = useState<IdentityRecoveryPreparation>()
  const [expectedIdentity, setExpectedIdentity] = useState<string>()
  const parsed = useRef<BackupData | null>(null)
  const operation = useRef<AbortController | null>(null)
  const fileVersion = useRef(0)
  const liveKey = snapshot.phase === 'ready' && snapshot.device ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const lastKey = snapshot.device ? radioKeyFromPublicKey(snapshot.device.publicKey) : null
  const key = liveKey ?? (choice === null ? lastKey : choice || null)
  const selectedLabel = liveKey ? snapshot.device?.name || liveKey.slice(0, 12) : key?.slice(0, 12) ?? ''
  const disabled = !key || busy || radioBusy
  const offline = snapshot.phase === 'idle' || snapshot.phase === 'error'
  const exportable = backupOptions.map(([section]) => section).filter((section) => liveKey !== null || section === 'regions')
  const availableImport = backupOptions.map(([section]) => section)
    .filter((section) => preview?.fields[section] !== undefined && (liveKey !== null || section === 'regions'))
  const selectedExport = new Set(exportable.filter((section) => exportSelection.has(section)))
  const selectedImport = new Set(availableImport.filter((section) => importSelection.has(section)))
  const replacingIdentity = selectedImport.has('identity') && preview?.fields.identity !== liveKey
  const needsPreparation = replacingIdentity && preparation?.radioKey !== liveKey
  const knownCache = key !== null && keys.includes(key)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const storage = await openRadioStorage()
        try {
          const keys = await storage.listRadioKeys()
          if (active) setKeys(keys)
        } finally { storage.close() }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Could not list saved radios.')
      }
    }
    void load()
    return () => { active = false }
  }, [revision, liveKey])

  useEffect(() => () => {
    fileVersion.current++
    operation.current?.abort()
    parsed.current?.identity?.privateKey.fill(0)
  }, [])

  async function loadFile(file: File | undefined) {
    const version = ++fileVersion.current
    parsed.current?.identity?.privateKey.fill(0)
    parsed.current = null
    setPreparation(undefined)
    setPreview(null)
    setImportSelection(new Set())
    setResults([])
    setNotice('')
    setError('')
    if (!file) return
    try {
      if (file.size > maxBackupBytes) throw new Error('Choose a configuration JSON file under 2 MB.')
      const text = await file.text()
      if (version !== fileVersion.current) return
      let value: unknown
      try { value = JSON.parse(text.replace(/^\uFEFF/, '')) }
      catch { throw new Error('The selected file is not valid JSON.') }
      parsed.current = parseBackup(value)
      setPreview(describe(parsed.current, file.name))
    } catch (error) {
      if (version === fileVersion.current) setError(error instanceof Error ? error.message : 'Could not read this backup.')
    }
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (disabled || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setError(''); setNotice(''); setResults([])
    try {
      await action(controller.signal)
      if (controller.signal.aborted) setNotice('Operation stopped. A command already sent may have taken effect.')
    } catch (error) {
      if (controller.signal.aborted) setNotice('Operation stopped.')
      else setError(error instanceof Error ? error.message : 'The operation failed.')
    } finally {
      operation.current = null
      setBusy(false)
    }
  }

  function exportSelected() {
    if (!key || !selectedExport.size) return
    if ([...selectedExport].some((section) => secretSections.has(section)) &&
      !window.confirm('Download a backup with selected keys in readable JSON? Anyone who gets the file can use those keys. Save it somewhere private.')) return
    void run(async (signal) => {
      const { json, failures } = await exportBackup(session, key, selectedExport, signal)
      setResults(failures)
      if (json) {
        download(`meshcore-config-${key.slice(0, 12)}.json`, json)
        setNotice('Backup sent to browser downloads.')
      } else setError('The selected sections could not be backed up.')
    })
  }

  function confirmKey(description: string) {
    if (!key) return false
    const prefix = key.slice(0, 12)
    return window.prompt(`${description}\n\nType ${prefix} to confirm.`)?.trim().toLowerCase() === prefix
  }

  function applySelected() {
    const data = parsed.current
    if (!key || !data || !selectedImport.size) return
    if (needsPreparation) {
      if (!confirmKey(`Reboot ${selectedLabel} to save pending contacts before identity recovery? Reconnect to continue the restore.`)) return
      void run(async (signal) => {
        setPreparation(await session.prepareIdentityRecovery(key, signal))
        setNotice('Radio reboot requested to save pending contacts. Reconnect the same radio to continue recovery.')
      })
      return
    }
    if (replacingIdentity) {
      if (!confirmKey(`Apply the selected settings and replace the identity of ${selectedLabel}? The radio may restart to save contacts. Reconnect afterward to verify the new public key.`)) return
    } else if (!window.confirm(`Restore the selected sections for ${selectedLabel}? Matching contact details and selected browser settings can be replaced. Existing radio channel keys stay in place.`)) return
    void run(async (signal) => {
      const applied = await restoreBackup(session, key, data, selectedImport, signal, preparation).catch((error: unknown) => {
        if (replacingIdentity) setPreparation(undefined)
        throw error
      })
      setResults(applied.results)
      setExpectedIdentity(applied.transferredIdentity)
      if (applied.transferredIdentity) setPreparation(undefined)
      if (!applied.results.length) setNotice('No entries were selected for writing.')
      onCacheChanged(key)
      if (applied.transferredIdentity) onCacheChanged(radioKeyFromPublicKey(applied.transferredIdentity))
      setRevision((value) => value + 1)
    })
  }

  function maintenance(action: 'reset' | 'reboot') {
    if (!liveKey) return
    const confirmed = action === 'reset'
      ? confirmKey(`Factory reset ${selectedLabel}? This erases its identity, contacts, channels and settings from the radio.`)
      : window.confirm(`Reboot ${selectedLabel} now? You will need to reconnect.`)
    if (!confirmed) return
    void run(async () => {
      await session.sendMaintenance(liveKey, action)
      setNotice('Radio command sent. Reconnect to verify the result.')
    })
  }

  function purge() {
    if (!key || !knownCache || !offline || !canPurge ||
      !confirmKey(`Permanently clear this browser’s cache for radio ${selectedLabel}? The radio itself keeps its data.`)) return
    void run(async () => {
      await session.whileRadioDisconnected(async () => {
        const storage = await openRadioStorage()
        try { await storage.purge(key) }
        finally { storage.close() }
      })
      onCacheChanged(key, true)
      setRevision((value) => value + 1)
      setNotice('Cleared the selected radio’s browser cache.')
    })
  }

  return <section className="preferences backup-panel" aria-label="Backup and recovery">
    <h2>Backup and recovery</h2>
    {liveKey ? <p>Connected radio {selectedLabel} · {liveKey.slice(0, 12)}</p> : (
      <label className="backup-radio">Backup cache radio<select value={key ?? ''} disabled={busy} onChange={(event) => {
        const value = event.currentTarget.value
        setChoice(keys.find((key) => key === value) ?? '')
      }}>
        <option value="">Select a saved radio</option>
        {lastKey && !keys.includes(lastKey) && <option value={lastKey}>{lastKey}</option>}
        {keys.map((key) => <option key={key} value={key}>{key}</option>)}
      </select></label>
    )}
    <details>
      <summary>Export configuration</summary>
      <fieldset disabled={disabled}>
        <legend>Sections to export</legend>
        <div className="backup-actions">
          <button type="button" onClick={() => setExportSelection(new Set(exportable))}>Select all export sections</button>
          <button type="button" onClick={() => setExportSelection(new Set())}>Deselect all export sections</button>
        </div>
        {backupOptions.map(([section, title]) => <label className="preference-check" key={section}>
          <input type="checkbox" disabled={!exportable.includes(section)} checked={selectedExport.has(section)}
            onChange={() => setExportSelection(toggle(exportSelection, section))} /> {title}
        </label>)}
        {!liveKey && <p>Connect a companion to export its device settings and keys.</p>}
        <p>Identity, channel and region keys are included only when selected. Keep files containing keys private.</p>
        <button type="button" disabled={!selectedExport.size} onClick={exportSelected}>Download configuration</button>
      </fieldset>
    </details>
    <details>
      <summary>Restore configuration</summary>
      <label className="backup-radio">Configuration JSON file
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => void loadFile(event.currentTarget.files?.[0])} />
      </label>
      {preview && <fieldset disabled={disabled}>
        <legend>Restore preview</legend>
        <p>{preview.file}{preview.source ? ` · source ${preview.source.slice(0, 12)}` : ''}</p>
        <div className="backup-actions">
          <button type="button" onClick={() => setImportSelection(new Set(availableImport))}>Select all restore sections</button>
          <button type="button" onClick={() => setImportSelection(new Set())}>Deselect all restore sections</button>
        </div>
        {backupOptions.filter(([section]) => preview.fields[section] !== undefined).map(([section, title]) =>
          <label className="preference-check" key={section}>
            <input type="checkbox" disabled={!availableImport.includes(section)} checked={selectedImport.has(section)}
              onChange={() => setImportSelection(toggle(importSelection, section))} />
            <span><strong>{title}</strong><span className="backup-value">{preview.fields[section]}</span></span>
          </label>,
        )}
        {preview.names.length > 0 && <details>
          <summary>Names in this backup</summary>
          <ul className="backup-names">{preview.names.map((name, index) => <li key={index}>{name}</li>)}</ul>
        </details>}
        <p>Contacts with matching public keys are updated. New channels use free slots. Matching channels can receive browser scope and retention settings.</p>
        <button type="button" disabled={!selectedImport.size} onClick={applySelected}>
          {needsPreparation ? 'Prepare identity recovery' : 'Restore selected sections'}
        </button>
      </fieldset>}
    </details>
    <details>
      <summary>Local archive and radio maintenance</summary>
      <fieldset disabled={disabled}>
        <legend>Local archive</legend>
        <div className="backup-actions">
          <button type="button" disabled={!knownCache} onClick={() => {
            if (!key || !window.confirm('Download cached messages and drafts? The archive contains private message text.')) return
            void run(async () => {
              download(`packet-pigeon-chat-${key.slice(0, 12)}.json`, await exportLocalArchive(key))
              setNotice('Chat archive sent to browser downloads.')
            })
          }}>Download local chat archive</button>
          <button type="button" disabled={!knownCache || !offline || !canPurge} onClick={purge}>Purge local radio cache</button>
        </div>
        {!offline && <p>Disconnect before clearing saved browser data.</p>}
      </fieldset>
      <fieldset disabled={disabled || !liveKey}>
        <legend>Radio maintenance</legend>
        <div className="backup-actions">
          <button type="button" onClick={() => maintenance('reboot')}>Reboot radio</button>
          <button type="button" disabled={(snapshot.device?.capabilities.firmwareProtocolVersion ?? 0) < 7}
            onClick={() => maintenance('reset')}>Factory reset radio</button>
        </div>
      </fieldset>
    </details>
    {busy && <div className="backup-actions">
      <p role="status">Working on the selected radio…</p>
      <button type="button" onClick={() => operation.current?.abort()}>Stop after current command</button>
    </div>}
    {expectedIdentity && <p role="status">{liveKey === expectedIdentity ? 'Restored identity verified' : 'Reconnect and verify the public key'} <code>{expectedIdentity}</code></p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {results.length > 0 && <ul aria-label="Backup and restore results">
      {results.map((entry, index) => <li key={index}>{entry.label} · {label[entry.status]}{entry.reason ? `. ${entry.reason}` : ''}</li>)}
    </ul>}
  </section>
}
