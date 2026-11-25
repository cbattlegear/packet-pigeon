import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CompanionSession, getWebBluetoothSupport, getWebSerialSupport } from './radio/index.ts'
import { SessionCache } from './integration/session-cache.ts'
import { MessageSync } from './integration/message-sync.ts'
import { DirectMessages } from './integration/direct-messages.ts'
import { ChatPanel } from './chats/ChatPanel.tsx'
import { ContactsPanel } from './contacts/ContactsPanel.tsx'
import { DiscoveryPanel } from './discovery/DiscoveryPanel.tsx'
import { discoveryEntries, discoveryMapNodes } from './discovery/model.ts'
import { useRadioDiscoveries } from './discovery/use-radio-discoveries.ts'
import { storedContact } from './integration/contact-record.ts'
import { mapRadioContacts } from './map/nodes.ts'
import type { Coordinates } from './map/nodes.ts'
import './App.css'
import { OfflineStatus } from './offline/OfflineStatus.tsx'

const session = new CompanionSession()
const cache = new SessionCache(session)
const messageSync = new MessageSync(session, undefined, () => {
  const status = cache.getSnapshot()
  return !status.error && status.pending === 0 && !status.saving
})
const directMessages = new DirectMessages(session)
const MapWorkspace = lazy(() => import('./map/MapWorkspace.tsx'))

const sections = ['Chats', 'Contacts', 'Discovery', 'Channels', 'Map', 'Tools', 'Settings'] as const
type Section = (typeof sections)[number]

function sectionFromHash(): Section {
  const hash = window.location.hash.slice(1).toLowerCase()
  return sections.find((section) => section.toLowerCase() === hash) ?? 'Chats'
}

function isMapSection(section: Section): section is 'Map' | 'Tools' {
  return section === 'Map' || section === 'Tools'
}

const sectionDescriptions: Record<Exclude<Section, 'Chats' | 'Contacts' | 'Discovery' | 'Map' | 'Tools'>, string> = {
  Channels: 'Channels will appear here when that feature is available.',
  Settings: 'Settings will appear here when they are available.',
}

type StateMessageProps =
  | { kind: 'empty'; title: string; description: string }
  | { kind: 'loading'; title: string; description: string }
  | { kind: 'error'; title: string; description: string }

function StateMessage({ kind, title, description }: StateMessageProps) {
  return (
    <div
      className={`state-message state-message--${kind}`}
      role={kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : undefined}
    >
      <span className="state-symbol" aria-hidden="true">
        {kind === 'error' ? '!' : kind === 'loading' ? '…' : '—'}
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}

function App() {
  const [{ activeSection, hasOpenedMap, hasOpenedContacts, hasOpenedDiscovery }, setNavigation] = useState(() => {
    const activeSection = sectionFromHash()
    return {
      activeSection, hasOpenedMap: isMapSection(activeSection), hasOpenedContacts: activeSection === 'Contacts',
      hasOpenedDiscovery: activeSection === 'Discovery',
    }
  })
  const [discoveryMapRequest, setDiscoveryMapRequest] = useState(0)
  const [contactFocus, setContactFocus] = useState<{ position: Coordinates; terrain: boolean } | null>(null)
  const mapVisible = isMapSection(activeSection)
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const cacheStatus = useSyncExternalStore(cache.subscribe, cache.getSnapshot)
  const messageStatus = useSyncExternalStore(messageSync.subscribe, messageSync.getSnapshot)
  const directStatus = useSyncExternalStore(directMessages.subscribe, directMessages.getSnapshot)
  const discoveryConnected = snapshot.phase === 'syncing' || snapshot.phase === 'ready'
  const discovery = useRadioDiscoveries(snapshot.device?.publicKey, discoveryConnected,
    hasOpenedDiscovery || hasOpenedMap, cacheStatus.saving)
  const radioContacts = useMemo(() => snapshot.contacts.map(storedContact), [snapshot.contacts])
  const adverts = useMemo(() => discoveryEntries(discovery.data,
    discoveryConnected && snapshot.progress?.stage !== 'contacts' ? radioContacts : undefined),
  [discovery.data, discoveryConnected, radioContacts, snapshot.progress?.stage])
  const radioNodes = useMemo(() => [...mapRadioContacts(snapshot.contacts), ...discoveryMapNodes(adverts)],
    [snapshot.contacts, adverts])
  const usbSupport = getWebSerialSupport()
  const bluetoothSupport = getWebBluetoothSupport()
  const busy = snapshot.phase === 'choosing' || snapshot.phase === 'closing'
  const canDisconnect = ['opening', 'handshake', 'syncing', 'ready', 'reconnecting'].includes(snapshot.phase)
  const controlsDisabled = busy || snapshot.error?.code === 'cleanup-failed'
  const connection = {
    idle: 'Disconnected',
    choosing: 'Choosing device',
    opening: 'Opening connection',
    handshake: 'Identifying radio',
    syncing: 'Connected',
    ready: 'Connected',
    reconnecting: 'Reconnecting',
    closing: 'Disconnecting',
    error: 'Error',
  }[snapshot.phase]
  const progress = snapshot.progress
  const syncStatus = progress
    ? `${progress.stage}: ${progress.completed}${progress.total === null ? '' : ` / ${progress.total}`}`
    : snapshot.phase === 'syncing' ? 'Syncing' : snapshot.phase === 'ready' ? 'Idle' : 'Not syncing'

  useEffect(() => {
    const updateSection = () => {
      const activeSection = sectionFromHash()
      setNavigation((previous) => ({
        activeSection,
        hasOpenedMap: previous.hasOpenedMap || isMapSection(activeSection),
        hasOpenedContacts: previous.hasOpenedContacts || activeSection === 'Contacts',
        hasOpenedDiscovery: previous.hasOpenedDiscovery || activeSection === 'Discovery',
      }))
    }
    window.addEventListener('hashchange', updateSection)
    return () => window.removeEventListener('hashchange', updateSection)
  }, [])

  useEffect(() => {
    if (snapshot.device?.publicKey) void messageSync.load(snapshot.device.publicKey)
  }, [snapshot.device?.publicKey])

  useEffect(() => {
    if (!messageStatus.syncing && !messageStatus.pending && !directStatus.activeId && !directStatus.pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [messageStatus.syncing, messageStatus.pending, directStatus.activeId, directStatus.pending])

  return (
    <div className={`app-shell${activeSection === 'Chats' ? ' app-shell--chats' : ''}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to content
      </a>

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">PP</span>
          <div>
            <p className="brand-name">Packet Pigeon</p>
            <p className="brand-description">MeshCore workspace</p>
          </div>
        </div>
        <div className="connection-area">
          <div className="connection-controls">
            <div className="header-status" role="status">
              <span className={`status-dot${snapshot.phase === 'ready' ? ' status-dot--connected' : ''}`} aria-hidden="true" />
              <span>{connection}</span>
            </div>
            <button
              type="button"
              disabled={controlsDisabled || (!canDisconnect && !usbSupport.supported)}
              aria-describedby="connection-warning"
              onClick={() => void (canDisconnect ? session.disconnect() : session.connect())}
            >
              {canDisconnect ? 'Disconnect' : 'Connect USB'}
            </button>
            {!canDisconnect && (
              <button type="button" disabled={controlsDisabled || !bluetoothSupport.supported}
                aria-describedby="connection-warning" onClick={() => void session.connectBluetooth()}>
                Connect Bluetooth
              </button>
            )}
          </div>
          <p className="connection-warning" id="connection-warning">
            Message sync is manual and requires USB.
          </p>
          <OfflineStatus />
        </div>
      </header>

      <nav className="sidebar" aria-label="Main navigation">
        <p className="nav-label">Workspace</p>
        <ul className="nav-list">
          {sections.map((section) => (
            <li key={section}>
              <a
                href={`#${section.toLowerCase()}`}
                aria-current={activeSection === section ? 'page' : undefined}
              >
                <span className="nav-marker" aria-hidden="true">
                  {section.slice(0, 1)}
                </span>
                {section}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main className="main-content" id="main-content" tabIndex={-1}>
        {(!usbSupport.supported || !bluetoothSupport.supported || snapshot.error
          || cacheStatus.error || messageStatus.error || messageStatus.pending || directStatus.error) && (
          <div className="notices">
            {!usbSupport.supported && <p role="status">{usbSupport.error.message}</p>}
            {!bluetoothSupport.supported && <p role="status">{bluetoothSupport.error.message}</p>}
            {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
            {messageStatus.error && <p role="alert">Message sync: {messageStatus.error}</p>}
            {directStatus.error && (
              <div role="alert">
                <p>Messages: {directStatus.error}</p>
                {directStatus.pending > 0 && (
                  <button type="button" onClick={() => void directMessages.retrySaving()}>Retry saving message changes</button>
                )}
              </div>
            )}
            {messageStatus.pending && (
              <div role="alert">
                <p>A received message is not saved. Keep this page open and retry saving. Radio ownership stays reserved until the receipt is saved.</p>
                <button type="button" disabled={messageStatus.syncing} onClick={() => void messageSync.sync()}>Retry saving</button>
              </div>
            )}
            {cacheStatus.error && (
              <div role="alert">
                <p>Cache error: {cacheStatus.error}</p>
                {cacheStatus.pending > 0 && (
                  <>
                    <p>{cacheStatus.pending} unsaved update(s) remain in memory. Keep this page open and retry.</p>
                    <button type="button" onClick={cache.retry}>Retry saving</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <div className="chat-slot" hidden={activeSection !== 'Chats'}>
          <ChatPanel snapshot={snapshot} messageSync={messageSync} messageStatus={messageStatus}
            direct={directMessages} status={directStatus} cacheSaving={cacheStatus.saving} />
        </div>
        {activeSection !== 'Chats' && !mapVisible && activeSection !== 'Contacts' && activeSection !== 'Discovery' && (
          <section className="section-pane" aria-labelledby="section-heading">
            <div className="pane-heading">
              <h1 id="section-heading">{activeSection}</h1>
              <p>Workspace</p>
            </div>
            <StateMessage
              kind="empty"
              title={`${activeSection} is not available yet`}
              description={sectionDescriptions[activeSection]}
            />
          </section>
        )}
        {hasOpenedContacts && (
          <div hidden={activeSection !== 'Contacts'}>
            <div className="section-pane">
              <div className="pane-heading"><h1>Contacts</h1><a href="#discovery">Browse discovered adverts</a></div>
              <ContactsPanel snapshot={snapshot} session={session} cacheSaving={cacheStatus.saving}
                messageSyncing={messageStatus.syncing} messageSending={directStatus.activeId !== null}
                onMap={(position, terrain) => {
                  setContactFocus({ position, terrain })
                  window.location.hash = terrain ? 'tools' : 'map'
                }} />
            </div>
          </div>
        )}
        {hasOpenedDiscovery && (
          <div hidden={activeSection !== 'Discovery'}>
            <div className="section-pane">
              <div className="pane-heading"><h1>Discovery</h1></div>
              <DiscoveryPanel view={discovery} entries={adverts} radioContacts={radioContacts}
                connected={discoveryConnected} ready={snapshot.phase === 'ready'} usb={snapshot.transport === 'usb'}
                pending={cacheStatus.pending}
                session={session} openMap={() => {
                  setDiscoveryMapRequest((value) => value + 1)
                  window.location.hash = 'map'
                }} />
            </div>
          </div>
        )}
        {hasOpenedMap && (
          <div hidden={!mapVisible}>
            <div className="section-pane">
              <div className="pane-heading">
                <h1>{activeSection === 'Tools' ? 'Tools' : 'Map'}</h1>
              </div>
              <Suspense fallback={<StateMessage kind="loading" title="Loading map" description="Opening the map and terrain tools." />}>
                <MapWorkspace radioNodes={radioNodes} showTerrain={activeSection === 'Tools'}
                  contactFocus={contactFocus} discoveryRequest={discoveryMapRequest} />
              </Suspense>
            </div>
          </div>
        )}
      </main>

      <footer className="status-bar" aria-label="Workspace status">
        <div><span>Device</span><strong>{snapshot.device
          ? `${snapshot.phase === 'syncing' || snapshot.phase === 'ready' ? '' : 'Last: '}${snapshot.device.name || 'Unnamed radio'}`
          : 'None'}</strong></div>
        <div><span>Connection</span><strong>{connection}</strong></div>
        <div><span>Sync</span><strong>{syncStatus}</strong></div>
        <p>{cacheStatus.error ? 'Cache needs attention' : cacheStatus.pending ? `Saving ${cacheStatus.pending} update(s)` : 'Local cache idle'}</p>
      </footer>
    </div>
  )
}

export default App
