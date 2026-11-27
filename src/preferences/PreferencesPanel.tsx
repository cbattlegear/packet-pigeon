import { appearanceOptions, clockOptions, languageOptions } from './appPreferences.ts'
import type { AppPreferences } from './appPreferences.ts'
import './preferences.css'

const appearanceLabels = { system: 'Follow system', light: 'Light', dark: 'Dark' }
const languageLabels = { system: 'Use browser preference', en: 'English' }
const clockLabels = { system: 'Use language preference', '12-hour': '12-hour', '24-hour': '24-hour' }
const chatOptions = [
  ['saveDrafts', 'Save draft edits between visits'],
  ['oldestUnread', 'Open conversations at the oldest unread message'],
  ['composerAutofocus', 'Focus the composer when opening a conversation'],
  ['chatPreviews', 'Show conversation previews'],
  ['pathMetadata', 'Show message path details'],
  ['regionMetadata', 'Show message regions when available'],
] as const

type Props = {
  preferences: AppPreferences
  saveFailed: boolean
  update: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void
  wake: { supported: boolean; status: string }
  notifications: { permission: NotificationPermission | 'unsupported'; error: string; request: () => void }
}

export function PreferencesPanel({ preferences, saveFailed, update, wake, notifications }: Props) {
  return (
    <section className="preferences app-preferences" aria-label="App preferences">
      <fieldset>
        <legend>Appearance and language</legend>
        <div className="preference-field">
          <label htmlFor="appearance">Appearance</label>
          <select id="appearance" value={preferences.appearance} onChange={(event) => {
            const option = appearanceOptions.find((value) => value === event.currentTarget.value)
            if (option) update('appearance', option)
          }}>
            {appearanceOptions.map((option) => <option key={option} value={option}>{appearanceLabels[option]}</option>)}
          </select>
        </div>
        <div className="preference-field">
          <label htmlFor="language">App language</label>
          <select id="language" value={preferences.language} onChange={(event) => {
            const option = languageOptions.find((value) => value === event.currentTarget.value)
            if (option) update('language', option)
          }}>
            {languageOptions.map((option) => <option key={option} value={option}>{languageLabels[option]}</option>)}
          </select>
        </div>
        <div className="preference-field">
          <label htmlFor="clock">Clock format</label>
          <select id="clock" value={preferences.clock} onChange={(event) => {
            const option = clockOptions.find((value) => value === event.currentTarget.value)
            if (option) update('clock', option)
          }}>
            {clockOptions.map((option) => <option key={option} value={option}>{clockLabels[option]}</option>)}
          </select>
        </div>
      </fieldset>
      <fieldset>
        <legend>Browser notifications</legend>
        <p>Alerts work while the app is open. Sync to check for messages.</p>
        <p role="status">Permission: {notifications.permission}. {notifications.permission === 'denied' && 'Change notification permission in your browser site settings.'}</p>
        <button type="button" disabled={notifications.permission !== 'default'} onClick={notifications.request}>Allow browser notifications</button>
        <label className="preference-check">
          <input type="checkbox" checked={preferences.syncedMessageAlerts}
            onChange={(event) => update('syncedMessageAlerts', event.currentTarget.checked)} />
          Alert for synced messages
        </label>
        <label className="preference-check">
          <input type="checkbox" checked={preferences.discoveredContactAlerts}
            onChange={(event) => update('discoveredContactAlerts', event.currentTarget.checked)} />
          Alert for newly discovered contacts (USB)
        </label>
        <label className="preference-check">
          <input type="checkbox" checked={preferences.fullStorageAlerts}
            onChange={(event) => update('fullStorageAlerts', event.currentTarget.checked)} />
          Alert when radio contact or channel storage is full
        </label>
        {notifications.error && <p role="alert">{notifications.error}</p>}
      </fieldset>
      <fieldset>
        <legend>Messaging</legend>
        {chatOptions.map(([key, title]) => (
          <label className="preference-check" key={key}>
            <input type="checkbox" checked={preferences[key]} onChange={(event) => update(key, event.currentTarget.checked)} />
            {title}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Display</legend>
        <label className="preference-check">
          <input type="checkbox" checked={preferences.keepScreenOn} aria-describedby="wake-help"
            disabled={!wake.supported} onChange={(event) => update('keepScreenOn', event.currentTarget.checked)} />
          Keep screen on
        </label>
        <p id="wake-help" role="status">{wake.supported
          ? wake.status || 'Applies while the Packet Pigeon tab is visible.'
          : 'Screen wake lock is unavailable in this browser.'}</p>
      </fieldset>
      <p role="status">{saveFailed ? 'Settings changed for this visit. The browser could not save them.' : ''}</p>
    </section>
  )
}
