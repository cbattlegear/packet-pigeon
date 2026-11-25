import { useEffect, useState } from 'react'
import './App.css'

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
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          <span>Radio integration unavailable</span>
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
        {activeSection === 'Chats' ? (
          <div className="chats-layout">
            <section className="conversation-list" aria-labelledby="chats-heading">
              <div className="pane-heading">
                <h1 id="chats-heading">Chats</h1>
                <p>Conversations</p>
              </div>
              <StateMessage
                kind="empty"
                title="No conversations"
                description="Conversations will appear here when chat data is available."
              />
            </section>

            <section className="conversation-pane" aria-label="Active conversation">
              <div className="conversation-heading">
                <p>Conversation</p>
                <span>No chat selected</span>
              </div>
              <StateMessage
                kind="empty"
                title="Select a conversation"
                description="Choose a conversation from the list to see it here."
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
        <div><span>Device</span><strong>Unavailable</strong></div>
        <div><span>Connection</span><strong>Unavailable</strong></div>
        <div><span>Sync</span><strong>Unavailable</strong></div>
        <p>No radio or storage integration yet</p>
      </footer>
    </div>
  )
}

export default App
