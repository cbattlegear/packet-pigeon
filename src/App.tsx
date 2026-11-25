import { useEffect, useState, useSyncExternalStore } from 'react'
import { CompanionSession, getWebSerialSupport } from './radio/index.ts'
import { SessionCache } from './integration/session-cache.ts'
import './App.css'
import { OfflineStatus } from './offline/OfflineStatus.tsx'

const session = new CompanionSession()
const cache = new SessionCache(session)

const sections = ['Chats', 'Contacts', 'Channels', 'Map', 'Tools', 'Settings'] as const
type Section = (typeof sections)[number]

function sectionFromHash(): Section {
  const hash = window.location.hash.slice(1).toLowerCase()
  return sections.find((section) => section.toLowerCase() === hash) ?? 'Chats'
}

const sectionDescriptions: Record<Exclude<Section, 'Chats'>, string> = {
  Contacts: 'Contacts will appear here when that feature is available.',
  Channels: 'Channels will appear here when that feature is available.',
  Map: 'The map will appear here when that feature is available.',
  Tools: 'Tools will appear here when they are available.',
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
  const [activeSection, setActiveSection] = useState<Section>(sectionFromHash)
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const cacheStatus = useSyncExternalStore(cache.subscribe, cache.getSnapshot)
  const support = getWebSerialSupport()
  const busy = snapshot.phase === 'choosing' || snapshot.phase === 'closing'
  const canDisconnect = ['opening', 'handshake', 'syncing', 'ready'].includes(snapshot.phase)
  const connection = {
    idle: 'Disconnected',
    choosing: 'Choosing port',
    opening: 'Opening port',
    handshake: 'Identifying radio',
    syncing: 'Connected',
    ready: 'Connected',
    closing: 'Disconnecting',
    error: 'Error',
  }[snapshot.phase]
  const progress = snapshot.progress
  const syncStatus = progress
    ? `${progress.stage}: ${progress.completed}${progress.total === null ? '' : ` / ${progress.total}`}`
    : snapshot.phase === 'syncing' ? 'Syncing' : snapshot.phase === 'ready' ? 'Idle' : 'Not syncing'

  useEffect(() => {
    const updateSection = () => setActiveSection(sectionFromHash())
    window.addEventListener('hashchange', updateSection)
    return () => window.removeEventListener('hashchange', updateSection)
  }, [])

  return (
    <div className="app-shell">
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
              disabled={busy || (!canDisconnect && !support.supported)}
              aria-describedby="connection-warning"
              onClick={() => void (canDisconnect ? session.disconnect() : session.connect())}
            >
              {canDisconnect ? 'Disconnect' : 'Connect USB'}
            </button>
          </div>
          <p className="connection-warning" id="connection-warning">
            Message sync is paused; queued messages remain on the radio.
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
        {(!support.supported || snapshot.error || cacheStatus.error) && (
          <div className="notices">
            {!support.supported && <p role="status">{support.error.message}</p>}
            {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
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
        {activeSection === 'Chats' ? (
          <div className="chats-layout">
            <section className="conversation-list" aria-labelledby="chats-heading">
              <div className="pane-heading">
                <h1 id="chats-heading">Chats</h1>
                <p>Conversations</p>
              </div>
              <StateMessage
                kind="empty"
                title="Conversation browsing unavailable"
                description="Conversation browsing and message sync are not available yet."
              />
            </section>

            <section className="conversation-pane" aria-label="Active conversation">
              <div className="conversation-heading">
                <p>Conversation</p>
                <span>Not available yet</span>
              </div>
              <StateMessage
                kind="empty"
                title="Conversation view unavailable"
                description="Conversation browsing will be added in a later increment."
              />
            </section>
          </div>
        ) : (
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
