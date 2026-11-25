import { useLayoutEffect, useRef, useState } from 'react'
import type { CompanionSession, CompanionSnapshot } from '../radio/companion-session.ts'
import { importSharedChannel } from './importChannel.ts'
import type { SetupShare } from './setupLink.ts'

type Props = { setup: SetupShare; snapshot: CompanionSnapshot; session: CompanionSession; discard: () => void }

export function SetupPreview({ setup, snapshot, session, discard }: Props) {
  const radio = snapshot.phase === 'ready' ? snapshot.device : null
  const [radioSettings, setRadioSettings] = useState(false)
  const [pathWidth, setPathWidth] = useState(false)
  const [includeContacts, setIncludeContacts] = useState(setup.contacts.length > 0)
  const [includeChannels, setIncludeChannels] = useState(setup.channels.length > 0)
  const [withoutScope, setWithoutScope] = useState(false)
  const [working, setWorking] = useState(false)
  const [results, setResults] = useState<{ text: string; failed: boolean }[]>([])
  const [started, setStarted] = useState(false)
  const mounted = useRef(false)
  const stop = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const pathSupported = radio?.capabilities.pathHashMode != null
  const channelChoices = setup.channels.filter((channel) => !channel.regionScope || withoutScope)
  const hasScoped = setup.channels.some((channel) => channel.regionScope)
  const hasChanges = radioSettings && setup.settings || pathWidth && pathSupported ||
    includeContacts && setup.contacts.length || includeChannels && channelChoices.length

  async function apply() {
    if (!radio || !hasChanges || started) return
    const key = radio.publicKey
    if (!window.confirm(`Apply the selected companion setup changes to "${radio.name || 'the connected radio'}"?`)) return
    const changes: { label: string; run: () => Promise<unknown> }[] = []
    if (radioSettings && setup.settings) {
      const settings = setup.settings
      changes.push({ label: 'Radio preset', run: () => session.setSetupRadioSettings(key, settings) })
    }
    if (pathWidth && pathSupported && setup.pathWidth) {
      const width = setup.pathWidth
      changes.push({ label: 'Path hash width', run: () => session.setSetupPathWidth(key, width) })
    }
    if (includeContacts) for (const contact of setup.contacts) {
      changes.push({ label: `Contact ${contact.name}`, run: () => session.addContact(key, contact) })
    }
    if (includeChannels) for (const channel of channelChoices) {
      changes.push({ label: `Channel ${channel.name}`, run: () => importSharedChannel(session, key, channel) })
    }
    setStarted(true)
    setWorking(true)
    for (const change of changes) {
      if (!mounted.current) return
      const current = session.getSnapshot()
      if (stop.current || current.phase !== 'ready' || current.device?.publicKey !== key) {
        setResults((entries) => [...entries, {
          failed: true, text: stop.current ? 'Stopped. Remaining changes were skipped.'
            : 'The selected radio disconnected. Remaining changes were skipped.',
        }])
        break
      }
      try {
        await change.run()
        if (mounted.current) setResults((entries) => [...entries, { text: `${change.label}: applied`, failed: false }])
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The radio rejected this change.'
        if (mounted.current) setResults((entries) => [...entries, { text: `${change.label}: ${message}`, failed: true }])
      }
    }
    if (mounted.current) setWorking(false)
  }

  return <div className="share-preview">
    <h3>{setup.title || 'Companion setup preview'}</h3>
    {setup.description && <p>{setup.description}</p>}
    <fieldset disabled={started}>
      <legend>Changes to apply</legend>
      {setup.settings && <label className="share-checkbox">
        <input type="checkbox" checked={radioSettings} onChange={(event) => setRadioSettings(event.currentTarget.checked)} />
        Set radio preset to {setup.settings.frequencyMHz} MHz, {setup.settings.bandwidthKHz} kHz,
        SF{setup.settings.spreadingFactor}, CR{setup.settings.codingRate}
      </label>}
      {setup.pathWidth && <label className="share-checkbox">
        <input type="checkbox" checked={pathWidth && pathSupported} disabled={!pathSupported}
          onChange={(event) => setPathWidth(event.currentTarget.checked)} />
        Use {setup.pathWidth}-byte path hashes{pathSupported ? '' : ' (requires a compatible connected radio)'}
      </label>}
      {setup.contacts.length > 0 && <label className="share-checkbox">
        <input type="checkbox" checked={includeContacts} onChange={(event) => setIncludeContacts(event.currentTarget.checked)} />
        Add contacts ({setup.contacts.map(({ name }) => name).join(', ')})
      </label>}
      {setup.channels.length > 0 && <label className="share-checkbox">
        <input type="checkbox" checked={includeChannels} onChange={(event) => setIncludeChannels(event.currentTarget.checked)} />
        Add channels ({setup.channels.map(({ name }) => name).join(', ')})
      </label>}
      {includeChannels && hasScoped && <label className="share-checkbox">
        <input type="checkbox" checked={withoutScope} onChange={(event) => setWithoutScope(event.currentTarget.checked)} />
        Join scoped channels without their scopes. Leave unchecked to skip these channels.
      </label>}
    </fieldset>
    {radio ? <p>Apply to {radio.name || 'the connected radio'}.</p> : <p>Connect and sync a radio to continue.</p>}
    {results.length > 0 && <ul aria-label="Setup results">{results.map(({ text, failed }, index) =>
      <li key={index}>{failed ? <strong>{text}</strong> : text}</li>)}</ul>}
    {working && <p role="status">Applying changes to the connected radio…</p>}
    <div className="share-actions">
      <button type="button" disabled={!radio || !hasChanges || started} onClick={() => void apply()}>Apply selected setup</button>
      {working ? <button type="button" onClick={(event) => { stop.current = true; event.currentTarget.disabled = true }}>
        Stop after current change
      </button> : <button type="button" onClick={discard}>{started ? 'Clear setup results' : 'Discard preview'}</button>}
    </div>
  </div>
}
