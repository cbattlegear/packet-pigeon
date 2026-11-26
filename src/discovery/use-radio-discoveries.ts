import { useCallback, useEffect, useState } from 'react'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioData, RadioKey, RadioUpdate } from '../storage/index.ts'

type View = { key: RadioKey | null; keys: RadioKey[]; data: RadioData | null; error: string }
const initial: View = { key: null, keys: [], data: null, error: '' }

export function useRadioDiscoveries(sessionKey: string | undefined, connected: boolean, enabled: boolean, cacheSaving: boolean) {
  const [choice, setChoice] = useState<RadioKey | '' | null>(null)
  const [view, setView] = useState<View>(initial)
  const [revision, setRevision] = useState(0)
  const lastKey = sessionKey ? radioKeyFromPublicKey(sessionKey) : null
  const key = connected ? lastKey : choice === null ? lastKey : choice || null
  const selectRadio = useCallback((key: RadioKey) => setChoice(key), [])

  useEffect(() => {
    if (!enabled) return
    let current = true
    async function load() {
      try {
        const store = await openRadioStorage()
        try {
          const [keys, data] = await Promise.all([store.listRadioKeys(), key ? store.read(key) : null])
          if (current) setView({ key, keys, data, error: '' })
        } finally {
          store.close()
        }
      } catch (error) {
        if (current) setView((previous) => ({
          ...previous, error: error instanceof Error ? error.message : 'Could not read discovery history.',
        }))
      }
    }
    void load()
    return () => { current = false }
  }, [enabled, key, cacheSaving, revision])

  function refresh() {
    setRevision((previous) => previous + 1)
  }

  async function update(radio: RadioKey, discovery: NonNullable<RadioUpdate['discovery']>) {
    const storage = await openRadioStorage()
    try {
      await storage.update(radio, { discovery })
    } finally {
      storage.close()
    }
    refresh()
  }

  return {
    key, keys: view.keys, data: view.key === key ? view.data : null, error: view.error,
    choose: (value: string) => setChoice(view.keys.find((key) => key === value) ?? ''),
    update, refresh, selectRadio,
  }
}
