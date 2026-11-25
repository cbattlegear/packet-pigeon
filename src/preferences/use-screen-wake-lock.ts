import { useEffect, useState } from 'react'

export function useScreenWakeLock(enabled: boolean) {
  const supported = Boolean(navigator.wakeLock?.request)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!enabled || !supported) return
    let disposed = false
    let pending = false
    let sentinel: WakeLockSentinel | null = null
    let visible = document.visibilityState === 'visible'
    let visibilityVersion = 0

    async function reconcile() {
      if (disposed || pending) return
      pending = true
      const version = visibilityVersion
      try {
        if (!visible) {
          const previous = sentinel
          sentinel = null
          await previous?.release()
          return
        }
        if (sentinel) return
        const request = await navigator.wakeLock.request('screen')
        if (disposed || version !== visibilityVersion) {
          if (!request.released) await request.release()
          return
        }
        if (request.released) {
          setStatus('The browser or device declined the screen wake lock.')
          return
        }
        sentinel = request
        request.addEventListener('release', () => {
          if (sentinel !== request) return
          sentinel = null
          if (!disposed) setStatus('Screen wake lock released. It can renew when this tab becomes visible again.')
        }, { once: true })
        setStatus('Keeping the screen on while this tab is visible.')
      } catch {
        if (!disposed && visible && version === visibilityVersion) {
          setStatus('The browser or device declined the screen wake lock.')
        }
      } finally {
        pending = false
        if (!disposed && version !== visibilityVersion) void reconcile()
      }
    }

    function visibilityChanged() {
      const next = document.visibilityState === 'visible'
      if (next === visible) return
      visible = next
      visibilityVersion++
      if (!visible) setStatus('Screen wake lock is paused while this tab is hidden.')
      void reconcile()
    }

    document.addEventListener('visibilitychange', visibilityChanged)
    void reconcile()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibilityChanged)
      if (sentinel) void sentinel.release().catch(() => {})
    }
  }, [enabled, supported])

  return { supported, status: enabled ? status : '' }
}
