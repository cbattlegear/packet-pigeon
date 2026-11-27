import type { ReactNode } from 'react'
import { OfflineStatus } from './offline/OfflineStatus.tsx'
import { primarySections, secondarySections } from './workspace-navigation.ts'
import type { Section } from './workspace-navigation.ts'

function WorkspaceMenu({ name, label, children, current = false }: {
  name: string
  label: ReactNode
  children: ReactNode
  current?: boolean
}) {
  return <details className="workspace-menu" name="workspace-menu" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
  }} onKeyDown={(event) => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.stopPropagation()
      event.currentTarget.open = false
      event.currentTarget.querySelector('summary')?.focus()
    }
  }} onClick={(event) => {
    if (!(event.target as Element).closest('a, button:not(:disabled)')) return
    event.currentTarget.open = false
    event.currentTarget.querySelector('summary')?.focus({ preventScroll: true })
  }}>
    <summary aria-label={name} data-current={current || undefined}>{label}</summary>
    <div className="workspace-menu-items">{children}</div>
  </details>
}

export function WorkspaceHeader({ section, connection, deviceLabel, connected, controls }: {
  section: Section
  connection: string
  deviceLabel: string
  connected: boolean
  controls: ReactNode
}) {
  const link = (destination: Section) => <a key={destination} href={`#${destination.toLowerCase()}`}
    aria-current={section === destination ? 'page' : undefined}>{destination}</a>
  return <header className="app-header">
    <a href="#chats" className="brand">Packet Pigeon</a>
    <nav className="workspace-nav" aria-label="Main navigation">
      {primarySections.map(link)}
      <WorkspaceMenu name="More" label={<>More <span className="menu-chevron" aria-hidden="true" /></>}
        current={secondarySections.some((item) => item === section)}>
        {secondarySections.map(link)}
      </WorkspaceMenu>
    </nav>
    <div className="connection-area">
      <span className="visually-hidden" role="status">{connection}</span>
      <WorkspaceMenu name="Radio connection" label={<>
        <span className={`status-dot${connected ? ' status-dot--connected' : ''}`} aria-hidden="true" />
        <span className="radio-summary">{deviceLabel}</span>
        <span className="menu-chevron" aria-hidden="true" />
      </>}>
        {controls}
      </WorkspaceMenu>
    </div>
    <div className="header-notice"><OfflineStatus quiet /></div>
  </header>
}
