import { useLayoutEffect, useState } from 'react'
import {
  appearanceOptions,
  languageOptions,
  parseAppPreferences,
  preferenceKey,
  resolveAppLanguage,
} from './appPreferences.ts'
import type { AppPreferences } from './appPreferences.ts'
import './preferences.css'

const strings = {
  heading: 'Settings',
  appearanceLabel: 'Appearance',
  appearance: { system: 'Follow system', light: 'Light', dark: 'Dark' },
  languageLabel: 'App language',
  language: { system: 'Use browser preference', en: 'English' },
  languageHelp: 'English is currently available.',
  storageError: 'Settings changed for this visit. The browser could not save them.',
}

function loadPreferences() {
  try {
    return parseAppPreferences(localStorage.getItem(preferenceKey))
  } catch {
    return parseAppPreferences(null)
  }
}

export function PreferencesPanel() {
  const [preferences, setPreferences] = useState(loadPreferences)
  const [saveFailed, setSaveFailed] = useState(false)

  useLayoutEffect(() => {
    document.documentElement.dataset.appearance = preferences.appearance
    document.documentElement.lang = resolveAppLanguage(preferences.language, navigator.languages)
  }, [preferences.appearance, preferences.language])

  function update<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    const next = { ...preferences, [key]: value }
    setPreferences(next)
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next))
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    }
  }

  return (
    <section className="preferences" id="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading">{strings.heading}</h2>
      <div className="preference-field">
        <label htmlFor="appearance">{strings.appearanceLabel}</label>
        <select id="appearance" value={preferences.appearance} onChange={(event) => {
          const option = appearanceOptions.find((value) => value === event.currentTarget.value)
          if (option) update('appearance', option)
        }}>
          {appearanceOptions.map((option) => (
            <option key={option} value={option}>{strings.appearance[option]}</option>
          ))}
        </select>
      </div>
      <div className="preference-field">
        <label htmlFor="language">{strings.languageLabel}</label>
        <select id="language" value={preferences.language} aria-describedby="language-help"
          onChange={(event) => {
            const option = languageOptions.find((value) => value === event.currentTarget.value)
            if (option) update('language', option)
          }}>
          {languageOptions.map((option) => (
            <option key={option} value={option}>{strings.language[option]}</option>
          ))}
        </select>
        <p id="language-help">{strings.languageHelp}</p>
      </div>
      <p role="status">{saveFailed ? strings.storageError : ''}</p>
    </section>
  )
}
