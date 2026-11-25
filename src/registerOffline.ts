if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  const workerUrl = new URL('sw.js', document.baseURI)
  navigator.serviceWorker.register(workerUrl).catch(() => {
    console.warn('Packet Pigeon could not enable offline loading.')
  })
}
