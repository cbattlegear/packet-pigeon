import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CompanionSession, detectLanBridge, getWebBluetoothSupport, getWebSerialSupport } from './radio/index.ts'
import { framedTransport, transportName } from './radio/transport.ts'
import { SessionCache } from './integration/session-cache.ts'
import { MessageSync } from './integration/message-sync.ts'
import { DirectMessages } from './integration/direct-messages.ts'
import { ChatPanel } from './chats/ChatPanel.tsx'
import { ContactsPanel } from './contacts/ContactsPanel.tsx'
import { OwnTelemetry } from './telemetry/TelemetryPanel.tsx'
import { DiscoveryPanel } from './discovery/DiscoveryPanel.tsx'
import { ChannelsPanel } from './channels/ChannelsPanel.tsx'
import { discoveryEntries, discoveryMapNodes, discoveryPathNodes } from './discovery/model.ts'
import { useRadioDiscoveries } from './discovery/use-radio-discoveries.ts'
import { storedContact } from './integration/contact-record.ts'
import { mapRadioContacts, readSavedMapNodes } from './map/nodes.ts'
import type { Coordinates, MapNode, MapNodeData } from './map/nodes.ts'
import './App.css'
import { WorkspaceHeader } from './WorkspaceHeader.tsx'
import { sections } from './workspace-navigation.ts'
import type { Section } from './workspace-navigation.ts'
import { PreferencesPanel } from './preferences/PreferencesPanel.tsx'
import { useAppPreferences } from './preferences/use-app-preferences.ts'
import { useScreenWakeLock } from './preferences/use-screen-wake-lock.ts'
import { ImportShare, ShareCode } from './sharing/ShareDialogs.tsx'
import { formatCompanionSetup } from './sharing/setupLink.ts'
import { RxInspector } from './diagnostics/RxInspector.tsx'
import { openRadioStorage, radioKeyFromPublicKey } from './storage/index.ts'
import type { RadioKey } from './storage/index.ts'
import { messageAlert } from './chats/notification.ts'
import { TraceWorkspace } from './paths/TraceWorkspace.tsx'
import type { MapPath } from './paths/model.ts'
import { contactPosition, contactRole } from './contacts/model.ts'

const session = new CompanionSession()
const cache = new SessionCache(session)
const messageSync = new MessageSync(session, undefined, () => {
  const status = cache.getSnapshot()
  return !status.error && status.pending === 0 && !status.saving
})
const directMessages = new DirectMessages(session)
const MapWorkspace = lazy(() => import('./map/MapWorkspace.tsx'))
const DeviceSettingsPanel = lazy(() => import('./preferences/DeviceSettingsPanel.tsx'))
const BackupPanel = lazy(() => import('./backup/BackupPanel.tsx'))
let startupRetention: Promise<number> | undefined

function applyStartupRetention() {
  startupRetention ??= (async () => {
    const storage = await openRadioStorage()
    try { return await storage.pruneChannelMessages(Date.now()) }
    finally { storage.close() }
  })()
  return startupRetention
}

function sectionFromHash(): Section {
  const hash = window.location.hash.slice(1).toLowerCase()
  return sections.find((section) => section.toLowerCase() === hash) ?? 'Chats'
}

function isMapSection(section: Section): section is 'Map' | 'Tools' {
  return section === 'Map' || section === 'Tools'
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
  const settings = useAppPreferences()
  const activeChat = useRef<{ key: RadioKey | null; id: string | null }>({ key: null, id: null })
  const [navigationRequest, setNavigationRequest] = useState<{ key: RadioKey; id: string; sequence: number } | null>(null)
  const [radioNavigation, setRadioNavigation] = useState<{
    key: RadioKey; section: 'Contacts' | 'Channels'; sequence: number; contactKey?: string
  } | null>(null)
  const navigationSequence = useRef(0)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    () => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const [notificationError, setNotificationError] = useState('')
  const fullStorageNotified = useRef(new Set<string>())
  const setActiveChat = useCallback((key: RadioKey | null, id: string | null) => {
    activeChat.current = { key, id }
  }, [])
  const wake = useScreenWakeLock(settings.preferences.keepScreenOn)
  const [retention, setRetention] = useState<{ checking: boolean; removed: number; error: string | null }>({
    checking: true, removed: 0, error: null,
  })
  const [{ activeSection, hasOpenedMap, hasOpenedContacts, hasOpenedDiscovery, hasOpenedDiagnostics }, setNavigation] = useState(() => {
    const activeSection = sectionFromHash()
    return {
      activeSection, hasOpenedMap: isMapSection(activeSection), hasOpenedContacts: activeSection === 'Contacts',
      hasOpenedDiscovery: activeSection === 'Discovery',
      hasOpenedDiagnostics: activeSection === 'Diagnostics',
    }
  })
  const [discoveryMapRequest, setDiscoveryMapRequest] = useState(0)
  const [contactFocus, setContactFocus] = useState<{ position: Coordinates; terrain: boolean } | null>(null)
  const [sharePosition, setSharePosition] = useState<Coordinates | null>(null)
  const [displayPath, setDisplayPath] = useState<MapPath | null>(null)
  const [mapData, setMapData] = useState<MapNodeData>(() => ({ local: readSavedMapNodes(), public: [] }))
  const [mapTrace, setMapTrace] = useState<MapNode[]>([])
  const [mapTraceRequest, setMapTraceRequest] = useState(0)
  const [shareDialog, setShareDialog] = useState<{ kind: 'import' } | { kind: 'export'; link: string } | null>(null)
  const [setupError, setSetupError] = useState('')
  const mapVisible = isMapSection(activeSection)
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const cacheStatus = useSyncExternalStore(cache.subscribe, cache.getSnapshot)
  const messageStatus = useSyncExternalStore(messageSync.subscribe, messageSync.getSnapshot)
  const directStatus = useSyncExternalStore(directMessages.subscribe, directMessages.getSnapshot)
  const discoveryConnected = snapshot.phase === 'syncing' || snapshot.phase === 'ready'
  const discovery = useRadioDiscoveries(snapshot.device?.publicKey, discoveryConnected,
    hasOpenedDiscovery || hasOpenedMap || hasOpenedDiagnostics || hasOpenedContacts, cacheStatus.saving)
  const selectDiscoveryRadio = discovery.selectRadio
  const clearRadioNavigation = useCallback(() => setRadioNavigation(null), [])
  const navigateRadioAlert = useCallback((key: RadioKey, section: 'Chats' | 'Discovery' | 'Contacts' | 'Channels', id?: string) => {
    const current = session.getSnapshot()
    if (['choosing', 'opening', 'handshake', 'reconnecting', 'closing'].includes(current.phase)
      || (['ready', 'syncing'].includes(current.phase) && current.device?.publicKey.toLowerCase() !== key)) {
      setNotificationError('The alert belongs to a different radio or a connection is changing. Disconnect or finish connecting, then open the alert again.')
      window.focus()
      return false
    }
    setNotificationError('')
    const sequence = ++navigationSequence.current
    if (section === 'Chats' && id) setNavigationRequest({ key, id, sequence })
    if (section === 'Discovery') selectDiscoveryRadio(key)
    if (section === 'Contacts' || section === 'Channels') setRadioNavigation({ key, section, sequence })
    window.location.hash = section.toLowerCase()
    window.focus()
    return true
  }, [selectDiscoveryRadio])
  const radioContacts = useMemo(() => snapshot.contacts.map(storedContact), [snapshot.contacts])
  const savedContactKeys = useMemo(() => new Set(radioContacts.map(({ publicKey }) => publicKey.toLowerCase())), [radioContacts])
  const adverts = useMemo(() => discoveryEntries(discovery.data,
    discoveryConnected && snapshot.progress?.stage !== 'contacts' ? radioContacts : undefined),
  [discovery.data, discoveryConnected, radioContacts, snapshot.progress?.stage])
  const radioNodes = useMemo(() => [...mapRadioContacts(snapshot.contacts), ...discoveryMapNodes(adverts)],
    [snapshot.contacts, adverts])
  const discoveredHops = useMemo(() => discoveryPathNodes(adverts), [adverts])
  const pathNodes = useMemo(() => [
    ...radioContacts.map(({ publicKey, name, details }) => ({
      publicKey, name, position: contactPosition(details), role: contactRole(details?.type),
    })),
    ...(discovery.key === snapshot.device?.publicKey ? discoveredHops : []),
  ], [discoveredHops, discovery.key, radioContacts, snapshot.device?.publicKey])
  const mapPathNodes = useMemo(() => [...mapData.local, ...mapData.public], [mapData])
  const knownPathNodes = useMemo(() => [...pathNodes, ...mapPathNodes], [pathNodes, mapPathNodes])
  const usbSupport = getWebSerialSupport()
  const bluetoothSupport = getWebBluetoothSupport()
  const [lanAvailable, setLanAvailable] = useState(false)
  const busy = snapshot.phase === 'choosing' || snapshot.phase === 'closing'
  const canDisconnect = ['opening', 'handshake', 'syncing', 'ready', 'reconnecting'].includes(snapshot.phase)
  const controlsDisabled = busy || snapshot.error?.code === 'cleanup-failed'
  const connection = {
    idle: 'Disconnected',
    choosing: 'Choosing device',
    opening: 'Opening connection',
    handshake: 'Identifying radio',
    syncing: 'Connected',
    ready: snapshot.transport === 'lan' ? 'Connected over local network' : 'Connected',
    reconnecting: 'Reconnecting',
    closing: 'Disconnecting',
    error: 'Error',
  }[snapshot.phase]
  const progress = snapshot.progress
  const radioSyncStatus = progress
    ? `${progress.stage}: ${progress.completed}${progress.total === null ? '' : ` / ${progress.total}`}`
    : snapshot.phase === 'syncing' ? 'Syncing' : null
  const receiptSyncStatus = messageStatus.syncing ? `messages: ${messageStatus.receiptsSaved} saved`
    : messageStatus.pending || messageStatus.error ? 'Needs attention' : null
  const syncStatus = [radioSyncStatus, receiptSyncStatus].filter(Boolean).join(' · ')
  const cacheDetail = cacheStatus.error ? 'Cache needs attention' : cacheStatus.pending ? `Saving ${cacheStatus.pending} update(s)` : null
  const chatView = activeSection === 'Chats'

  useEffect(() => messageSync.startAutomaticSync(cache.subscribe), [])

  useEffect(() => {
    if (!import.meta.env.PROD) return
    const probe = new AbortController()
    void detectLanBridge(probe.signal).then((available) => {
      if (!probe.signal.aborted) setLanAvailable(available)
    })
    return () => probe.abort()
  }, [])

  useEffect(() => {
    const refresh = () => setNotificationPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  useEffect(() => messageSync.subscribeToSavedReceipts((key, message, data) => {
    if (!settings.preferences.syncedMessageAlerts || typeof Notification === 'undefined'
      || Notification.permission !== 'granted') return
    const alert = messageAlert(data, message, snapshot.device?.publicKey.toLowerCase() === key ? snapshot.device.name : '')
    if (!alert || (!document.hidden && document.hasFocus()
      && activeChat.current.key === key && activeChat.current.id === alert.conversationId)) return
    try {
      const notification = new Notification(`Packet Pigeon: ${alert.title}`, { body: message.text, tag: `packet-pigeon:${key}:${message.id}` })
      notification.onclick = () => {
        if (navigateRadioAlert(key, 'Chats', alert.conversationId)) notification.close()
      }
    } catch (error) {
      setNotificationError(error instanceof Error ? `Could not show browser notification: ${error.message}` : 'Could not show browser notification.')
    }
  }), [settings.preferences.syncedMessageAlerts, snapshot.device, navigateRadioAlert])

  useEffect(() => cache.subscribeToDiscoveries((key, discovery) => {
    if (!settings.preferences.discoveredContactAlerts || typeof Notification === 'undefined'
      || Notification.permission !== 'granted') return
    try {
      const notification = new Notification('Packet Pigeon: New discovered contact', {
        body: discovery.name || discovery.publicKey.slice(0, 12),
        tag: `packet-pigeon:discovery:${key}:${discovery.publicKey}`,
      })
      notification.onclick = () => {
        if (navigateRadioAlert(key, 'Discovery')) notification.close()
      }
    } catch (error) {
      setNotificationError(error instanceof Error ? `Could not show browser notification: ${error.message}` : 'Could not show browser notification.')
    }
  }), [settings.preferences.discoveredContactAlerts, navigateRadioAlert])

  useEffect(() => {
    if (snapshot.phase !== 'ready' || !snapshot.device) return
    const key = radioKeyFromPublicKey(snapshot.device.publicKey)
    const capacities = [
      ['contacts', snapshot.contacts.length, snapshot.device.capabilities.maxContacts],
      ['channels', snapshot.channels.length, snapshot.device.capabilities.maxChannels],
    ] as const
    for (const [kind, count, limit] of capacities) {
      const id = `${key}:${kind}`
      if (!limit || count < limit) {
        fullStorageNotified.current.delete(id)
      } else if (settings.preferences.fullStorageAlerts && typeof Notification !== 'undefined'
        && Notification.permission === 'granted' && !fullStorageNotified.current.has(id)) {
        try {
          const notification = new Notification(`Packet Pigeon: Radio ${kind} full`, {
            body: `The connected radio reports ${count} of ${limit} ${kind} slots used.`,
            tag: `packet-pigeon:full:${id}`,
          })
          notification.onclick = () => {
            if (navigateRadioAlert(key, kind === 'contacts' ? 'Contacts' : 'Channels')) notification.close()
          }
          fullStorageNotified.current.add(id)
        } catch (error) {
          setNotificationError(error instanceof Error ? `Could not show browser notification: ${error.message}` : 'Could not show browser notification.')
        }
      }
    }
  }, [settings.preferences.fullStorageAlerts, snapshot, navigateRadioAlert])

  function requestNotifications() {
    if (typeof Notification === 'undefined') return
    void Notification.requestPermission().then((permission) => {
      setNotificationPermission(permission)
      setNotificationError('')
    }, (error: unknown) => setNotificationError(error instanceof Error ? error.message : 'Could not request notification permission.'))
  }

  useEffect(() => {
    let active = true
    void applyStartupRetention().then(
      (removed) => { if (active) setRetention({ checking: false, removed, error: null }) },
      (error: unknown) => {
        if (active) setRetention({
          checking: false, removed: 0,
          error: error instanceof Error ? error.message : 'Could not apply channel retention.',
        })
      },
    )
    return () => { active = false }
  }, [])

  useEffect(() => {
    const updateSection = () => {
      const activeSection = sectionFromHash()
      setShareDialog(null)
      setSetupError('')
      setNavigation((previous) => ({
        activeSection,
        hasOpenedMap: previous.hasOpenedMap || isMapSection(activeSection),
        hasOpenedContacts: previous.hasOpenedContacts || activeSection === 'Contacts',
        hasOpenedDiscovery: previous.hasOpenedDiscovery || activeSection === 'Discovery',
        hasOpenedDiagnostics: previous.hasOpenedDiagnostics || activeSection === 'Diagnostics',
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

  function showPathOnMap(path: MapPath) {
    setDisplayPath(path)
    window.location.hash = 'map'
  }

  if (retention.checking) return <div role="status">Applying channel retention…</div>

  return (
    <div className={`app-shell${chatView ? ' app-shell--chats' : ''}`}>
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

      <WorkspaceHeader section={activeSection} connection={connection} connected={snapshot.phase === 'ready'}
        deviceLabel={canDisconnect && snapshot.device && snapshot.transport
          ? `${snapshot.device.name || 'Radio'} · ${transportName(snapshot.transport)}` : canDisconnect ? connection : 'Connect radio'}
        controls={<>
          <button type="button" disabled={controlsDisabled || (!canDisconnect && !usbSupport.supported)}
            onClick={() => void (canDisconnect ? session.disconnect() : session.connect())}>
            {canDisconnect ? 'Disconnect' : 'Connect USB'}
          </button>
          {!canDisconnect && <button type="button" disabled={controlsDisabled || !bluetoothSupport.supported}
            onClick={() => void session.connectBluetooth()}>Connect Bluetooth</button>}
          {!canDisconnect && lanAvailable && <button type="button" disabled={controlsDisabled}
            onClick={() => void session.connectLan()}>Connect local network</button>}
          {!canDisconnect && !usbSupport.supported && <p role="status">{usbSupport.error.message}</p>}
          {!canDisconnect && !bluetoothSupport.supported && <p role="status">{bluetoothSupport.error.message}</p>}
        </>} />

      <main className="main-content" id="main-content" tabIndex={-1}>
        {(snapshot.error || retention.error || retention.removed > 0
          || cacheStatus.error || messageStatus.error || messageStatus.pending || directStatus.error
          || directStatus.cacheLoad.state === 'error' || notificationError) && (
          <div className="notices">
            {retention.error && <p role="alert">Channel retention could not finish: {retention.error} Check the radio cache and channel settings, then reload to retry.</p>}
            {retention.removed > 0 && <p role="status">Channel retention removed {retention.removed} cached message{retention.removed === 1 ? '' : 's'}.</p>}
            {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
            {messageStatus.error && <p role="alert">Message sync: {messageStatus.error}</p>}
            {notificationError && <p role="alert">{notificationError}</p>}
            {directStatus.error && (
              <div role="alert">
                <p>Messages: {directStatus.error}</p>
                {directStatus.pending > 0 && (
                  <button type="button" onClick={() => void directMessages.retrySaving()}>Retry saving message changes</button>
                )}
              </div>
            )}
            {directStatus.cacheLoad.state === 'error' && (
              <div role="alert">
                <p>Chats cache: {directStatus.cacheLoad.message}</p>
                {directStatus.key && <button type="button" onClick={() => {
                  if (directStatus.key) void directMessages.load(directStatus.key)
                }}>Retry chat cache</button>}
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
          <ChatPanel snapshot={snapshot} messageSync={messageSync} messageStatus={messageStatus} nodeSession={session}
            direct={directMessages} status={directStatus} cacheSaving={cacheStatus.saving}
            active={activeSection === 'Chats'} preferences={settings.preferences} locale={settings.locale}
            mapPosition={sharePosition}
            observationSource={session}
            navigationRequest={navigationRequest} onActiveConversation={setActiveChat}
            pathNodes={knownPathNodes} mapPathNodes={mapPathNodes} onPathMap={showPathOnMap}
            readChannelKey={(key, channel) => session.readChannelShareKey(key, channel.index, channel.name)} />
        </div>
        {hasOpenedDiagnostics && <div hidden={activeSection !== 'Diagnostics'}>
          <div className="section-pane">
            <div className="pane-heading"><h1>Diagnostics</h1></div>
            <OwnTelemetry active={activeSection === 'Diagnostics'} snapshot={snapshot} session={session}
              radioBusy={messageStatus.syncing || directStatus.activeId !== null} />
            <TraceWorkspace active={activeSection === 'Diagnostics'} snapshot={snapshot} session={session}
              nodes={knownPathNodes} mapSelection={mapTrace} mapRequest={mapTraceRequest} onMap={showPathOnMap} />
            <RxInspector snapshot={snapshot} session={session} prefs={settings.preferences} locale={settings.locale}
              pathNodes={knownPathNodes} mapPathNodes={mapPathNodes} onMap={showPathOnMap} />
          </div>
        </div>}
        {activeSection === 'Settings' && (
          <div className="section-pane">
            <div className="pane-heading"><h1>Settings</h1></div>
            <PreferencesPanel preferences={settings.preferences} saveFailed={settings.saveFailed} update={settings.update} wake={wake}
              notifications={{ permission: notificationPermission, error: notificationError, request: requestNotifications }} />
            <Suspense fallback={null}>
              <DeviceSettingsPanel snapshot={snapshot} session={session}
                radioBusy={messageStatus.syncing || directStatus.activeId !== null} />
              <BackupPanel snapshot={snapshot} session={session} syncMessages={messageSync.syncForMaintenance}
                radioBusy={messageStatus.syncing || directStatus.activeId !== null}
                canPurge={!cacheStatus.saving && cacheStatus.pending === 0 && directStatus.pending === 0 && !messageStatus.pending}
                onCacheChanged={(key, purged) => {
                  if (purged) directMessages.forgetSessionDrafts(key)
                  if (directMessages.getSnapshot().key === key) void directMessages.load(key)
                  discovery.refresh()
                }} />
            </Suspense>
            <section className="preferences" aria-label="Companion setup links">
              <h2>Companion setup links</h2>
              <div className="share-actions">
                <button type="button" onClick={() => setShareDialog({ kind: 'import' })}>Import link or QR code</button>
                <button type="button" disabled={snapshot.phase !== 'ready' || !snapshot.device?.radioParameters}
                  onClick={() => {
                    const device = snapshot.device
                    if (!device?.radioParameters) return
                    try {
                      setSetupError('')
                      const mode = device.capabilities.pathHashMode
                      setShareDialog({ kind: 'export', link: formatCompanionSetup(
                        'MeshCore companion radio preset', device.radioParameters, mode === null ? undefined : mode + 1,
                      ) })
                    } catch (error) {
                      setSetupError(error instanceof Error ? error.message : 'The radio preset could not be shared.')
                    }
                  }}>Share current radio preset</button>
              </div>
              {setupError && <p role="alert">{setupError}</p>}
            </section>
          </div>
        )}
        {activeSection === 'Channels' && (
          <div className="section-pane">
            <div className="pane-heading"><h1>Channels</h1></div>
            <ChannelsPanel snapshot={snapshot} session={session} cache={cache} cacheSaving={cacheStatus.saving} messageSyncing={messageStatus.syncing}
              radioNavigation={radioNavigation?.section === 'Channels' ? radioNavigation : null} onRadioNavigationHandled={clearRadioNavigation}
              onImport={() => setShareDialog({ kind: 'import' })}
              onBlockedSendersChanged={(key) => {
                if (directMessages.getSnapshot().key === key) void directMessages.load(key)
              }} />
          </div>
        )}
        {hasOpenedContacts && (
          <div hidden={activeSection !== 'Contacts'}>
            <div className="section-pane">
              <div className="pane-heading"><h1>Contacts</h1><a href="#discovery">Browse discovered adverts</a></div>
              <ContactsPanel snapshot={snapshot} session={session} messageSync={messageSync} cacheSaving={cacheStatus.saving}
                active={activeSection === 'Contacts'} messageStatus={directStatus}
                radioNavigation={radioNavigation?.section === 'Contacts' ? radioNavigation : null} onRadioNavigationHandled={clearRadioNavigation}
                messageSyncing={messageStatus.syncing} messageSending={directStatus.activeId !== null}
                onImport={() => setShareDialog({ kind: 'import' })}
                onShare={(link) => setShareDialog({ kind: 'export', link })}
                mapPathNodes={mapPathNodes} onPathMap={showPathOnMap}
                discoveredHops={discovery.data ? discoveredHops : undefined} discoveredRadio={discovery.key}
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
                connected={discoveryConnected} ready={snapshot.phase === 'ready'} framed={framedTransport(snapshot.transport)}
                active={activeSection === 'Discovery'} firmware={snapshot.device?.capabilities.firmwareProtocolVersion ?? 0}
                mapPathNodes={mapPathNodes} onPathMap={showPathOnMap}
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
                  mapData={mapData} setMapData={setMapData}
                  savedContactKeys={savedContactKeys}
                  onOpenContact={(contactKey) => {
                    if (!snapshot.device || !savedContactKeys.has(contactKey)) return
                    setRadioNavigation({ key: radioKeyFromPublicKey(snapshot.device.publicKey), contactKey,
                      section: 'Contacts', sequence: ++navigationSequence.current })
                    window.location.hash = 'contacts'
                  }}
                  contactFocus={contactFocus} discoveryRequest={discoveryMapRequest}
                  displayPath={displayPath} clearPath={() => setDisplayPath(null)}
                  traceSelection={mapTrace} changeTraceSelection={setMapTrace}
                  reviewTrace={() => {
                    setMapTraceRequest((value) => value + 1)
                    window.location.hash = 'diagnostics'
                  }}
                  onSharePosition={mapVisible ? (position) => {
                    setSharePosition(position)
                    window.location.hash = 'chats'
                  } : undefined} />
              </Suspense>
            </div>
          </div>
        )}
      </main>
      {shareDialog?.kind === 'import' && <ImportShare snapshot={snapshot} session={session} close={() => setShareDialog(null)} />}
      {shareDialog?.kind === 'export' && <ShareCode link={shareDialog.link} close={() => setShareDialog(null)} />}

      {(syncStatus || cacheDetail) && <footer className="status-bar" aria-label="Workspace status">
        {syncStatus && <strong role="status" aria-label="Sync status">{syncStatus}</strong>}
        {cacheDetail && <p>{cacheDetail}</p>}
      </footer>}
    </div>
  )
}

export default App
