import { useEffect, useState } from 'react'

const offlineMessage = {
  preparing: 'Preparing offline access…',
  ready: 'App available offline',
  unavailable: 'Offline access unavailable. Open the app online to try again.',
  unsupported: 'Offline access requires a supported browser on HTTPS or localhost.',
  updateReady: 'Update ready. Close all Packet Pigeon tabs, then reopen the app.',
  updateFailed: 'Offline update failed. The previous version is still available offline.',
}

type OfflineState = keyof typeof offlineMessage

export function OfflineStatus() {
  const supported = window.isSecureContext && 'serviceWorker' in navigator
  const [state, setState] = useState<OfflineState>('preparing')

  useEffect(() => {
    if (!import.meta.env.PROD || !supported) return

    const serviceWorker = navigator.serviceWorker
    let registration: ServiceWorkerRegistration | undefined
    let installing: ServiceWorker | null = null
    let disposed = false

    function reportStatus() {
      if (!registration) return

      const active = registration.active?.state === 'activated'
      if (registration.waiting && active) {
        setState('updateReady')
      } else if (installing?.state === 'redundant') {
        setState(active ? 'updateFailed' : 'unavailable')
      } else if (active) {
        setState('ready')
      } else {
        setState('preparing')
      }
    }

    function watchInstallation() {
      installing?.removeEventListener('statechange', reportStatus)
      installing = registration?.installing ?? null
      installing?.addEventListener('statechange', reportStatus)
      reportStatus()
    }

    const workerUrl = new URL('sw.js', document.baseURI)
    serviceWorker.register(workerUrl).then((current) => {
      if (disposed) return
      registration = current
      registration.addEventListener('updatefound', watchInstallation)
      serviceWorker.addEventListener('controllerchange', reportStatus)
      watchInstallation()
    }).catch(() => {
      if (!disposed) setState('unavailable')
    })

    return () => {
      disposed = true
      registration?.removeEventListener('updatefound', watchInstallation)
      serviceWorker.removeEventListener('controllerchange', reportStatus)
      installing?.removeEventListener('statechange', reportStatus)
    }
  }, [supported])

  if (!import.meta.env.PROD) return null

  return (
    <p className="connection-status" role="status">{offlineMessage[supported ? state : 'unsupported']}</p>
  )
}
