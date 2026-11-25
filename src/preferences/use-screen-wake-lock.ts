import { useEffect, useState } from 'react'

export function useScreenWakeLock(enabled: boolean) {
  const supported = Boolean(navigator.wakeLock?.request)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!enabled || !supported) return
    let disposed = false
    let pending = false
    let sentinel: WakeLockSentinel | null = null

    async function acquire() {
      if (disposed || pending || sentinel || document.visibilityState !== 'visible') return
      pending = true
      try {
        const request = await navigator.wakeLock.request('screen')
        if (disposed || document.visibilityState !== 'visible') {
          await request.release()
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
        if (!disposed) setStatus('The browser or device declined the screen wake lock.')
      } finally {
        pending = false
      }
    }

    function visibilityChanged() {
      if (document.visibilityState === 'visible') void acquire()
      else if (sentinel) {
        const previous = sentinel
        sentinel = null
        void previous.release().catch(() => {})
        setStatus('Screen wake lock is paused while this tab is hidden.')
      }
    }

    document.addEventListener('visibilitychange', visibilityChanged)
    void acquire()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibilityChanged)
      if (sentinel) void sentinel.release().catch(() => {})
    }
  }, [enabled, supported])

  return { supported, status: enabled ? status : '' }
}
