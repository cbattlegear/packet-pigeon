import { useLayoutEffect, useState } from 'react'
import { parseAppPreferences, preferenceKey, resolveAppLanguage } from './appPreferences.ts'
import type { AppPreferences } from './appPreferences.ts'

function loadPreferences() {
  try {
    return parseAppPreferences(localStorage.getItem(preferenceKey))
  } catch {
    return parseAppPreferences(null)
  }
}

export function useAppPreferences() {
  const [preferences, setPreferences] = useState(loadPreferences)
  const [saveFailed, setSaveFailed] = useState(false)
  const locale = resolveAppLanguage(preferences.language, navigator.languages)

  useLayoutEffect(() => {
    document.documentElement.dataset.appearance = preferences.appearance
    document.documentElement.lang = locale
  }, [preferences.appearance, locale])

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

  return { preferences, locale, saveFailed, update }
}
