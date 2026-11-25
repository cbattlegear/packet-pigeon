export const preferenceKey = 'packet-pigeon:app-preferences'
export const appearanceOptions = ['system', 'light', 'dark'] as const
export const languageOptions = ['system', 'en'] as const

export type AppPreferences = {
  appearance: typeof appearanceOptions[number]
  language: typeof languageOptions[number]
}

const defaults: AppPreferences = { appearance: 'system', language: 'system' }

export function parseAppPreferences(json: string | null): AppPreferences {
  if (json === null) return defaults

  try {
    const stored: unknown = JSON.parse(json)
    if (typeof stored !== 'object' || stored === null) return defaults

    const values = stored as Partial<Record<keyof AppPreferences, unknown>>
    return {
      appearance: appearanceOptions.find((option) => option === values.appearance)
        ?? defaults.appearance,
      language: languageOptions.find((option) => option === values.language)
        ?? defaults.language,
    }
  } catch {
    return defaults
  }
}

export function resolveAppLanguage(
  preference: AppPreferences['language'],
  browserLanguages: readonly string[],
): string {
  if (preference !== 'system') return preference

  for (const language of browserLanguages) {
    const canonical = Intl.getCanonicalLocales(language)[0]
    if (canonical === 'en' || canonical?.startsWith('en-')) return canonical
  }
  return 'en'
}
