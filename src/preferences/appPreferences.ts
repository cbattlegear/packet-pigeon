export const preferenceKey = 'packet-pigeon:app-preferences'
export const appearanceOptions = ['system', 'light', 'dark'] as const
export const languageOptions = ['system', 'en'] as const
export const clockOptions = ['system', '12-hour', '24-hour'] as const

export type AppPreferences = {
  appearance: typeof appearanceOptions[number]
  language: typeof languageOptions[number]
  clock: typeof clockOptions[number]
  saveDrafts: boolean
  oldestUnread: boolean
  keepScreenOn: boolean
  composerAutofocus: boolean
  chatPreviews: boolean
  pathMetadata: boolean
  regionMetadata: boolean
}

export const defaultPreferences: AppPreferences = {
  appearance: 'system', language: 'system', clock: 'system',
  saveDrafts: true, oldestUnread: false, keepScreenOn: false, composerAutofocus: false,
  chatPreviews: true, pathMetadata: true, regionMetadata: true,
}

export function parseAppPreferences(json: string | null): AppPreferences {
  if (json === null) return defaultPreferences

  try {
    const stored: unknown = JSON.parse(json)
    if (typeof stored !== 'object' || stored === null) return defaultPreferences

    const values = stored as Partial<Record<keyof AppPreferences, unknown>>
    type BooleanPreference = Exclude<keyof AppPreferences, 'appearance' | 'clock' | 'language'>
    const enabled = (key: BooleanPreference) => {
      const value = values[key]
      return typeof value === 'boolean' ? value : defaultPreferences[key]
    }
    return {
      appearance: appearanceOptions.find((option) => option === values.appearance)
        ?? defaultPreferences.appearance,
      language: languageOptions.find((option) => option === values.language)
        ?? defaultPreferences.language,
      clock: clockOptions.find((option) => option === values.clock) ?? defaultPreferences.clock,
      saveDrafts: enabled('saveDrafts'),
      oldestUnread: enabled('oldestUnread'),
      keepScreenOn: enabled('keepScreenOn'),
      composerAutofocus: enabled('composerAutofocus'),
      chatPreviews: enabled('chatPreviews'),
      pathMetadata: enabled('pathMetadata'),
      regionMetadata: enabled('regionMetadata'),
    }
  } catch {
    return defaultPreferences
  }
}

export function resolveAppLanguage(
  preference: AppPreferences['language'],
  browserLanguages: readonly string[],
): string {
  if (preference !== 'system') return preference

  for (const language of browserLanguages) {
    try {
      const canonical = Intl.getCanonicalLocales(language)[0]
      if (canonical && new Intl.Locale(canonical).language === 'en') return canonical
    } catch {
      // Ignore malformed browser language tags and continue to the fallback.
    }
  }
  return 'en'
}

export function clockFormatter(locale: string, clock: AppPreferences['clock']) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(clock === 'system' ? {} : { hour12: clock === '12-hour' }),
  })
}
