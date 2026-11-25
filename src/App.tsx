import './App.css'

function App() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">Skip to workspace</a>

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">PP</span>
          <div>
            <p className="brand-name">Packet Pigeon</p>
            <p className="brand-description">Open source MeshCore web UI</p>
          </div>
        </div>
        <p className="connection-status">Radio integration not yet available</p>
      </header>

      <nav className="sidebar" aria-label="Main navigation">
        <a href="#workspace">Workspace</a>
        <a href="#about">About this starter</a>
      </nav>

      <main className="main-content" id="workspace" tabIndex={-1}>
        <h1>Workspace</h1>
        <p className="page-description">Your MeshCore workspace starts here.</p>

        <section className="empty-workspace" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No radio session</h2>
          <p>
            This starter does not connect to radios or send packets.
            Connection and session features will be added incrementally.
          </p>
        </section>

        <section className="about-starter" id="about" aria-labelledby="about-heading">
          <h2 id="about-heading">About this starter</h2>
          <p>
            A client-only foundation for Packet Pigeon. The interface and
            radio logic can grow independently, then meet through a thin
            UI integration layer when real behavior is ready.
          </p>
          <p>
            See the repository README for setup commands and workstream boundaries.
          </p>
        </section>
      </main>
    </div>
  )
}

export default App
