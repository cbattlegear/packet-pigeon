/* global appFiles, buildId */

const scope = new URL(self.registration.scope)
const index = new URL('index.html', scope)
const assets = new Set(appFiles.map((file) => new URL(file, scope).href))
const cachePrefix = `packet-pigeon-shell:${scope.href}:`
const cacheName = cachePrefix + buildId

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    try {
      await cache.addAll([...assets].map((url) => new Request(url, {
        cache: 'reload',
        mode: 'same-origin',
        redirect: 'error',
      })))
    } catch (error) {
      await caches.delete(cacheName).catch(() => {})
      throw error
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys()
      const oldBuilds = names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
      await Promise.all(oldBuilds.map((name) => caches.delete(name)))
    } catch {
      // The new cache is ready even if the browser cannot clear an old cache.
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.headers.has('Range')) return

  const url = new URL(request.url)
  const shellNavigation = request.mode === 'navigate' && url.origin === scope.origin
    && (url.pathname === scope.pathname || url.pathname === index.pathname)
  if (!shellNavigation && !assets.has(url.href)) return

  event.respondWith((async () => {
    const key = shellNavigation ? index.href : url.href
    try {
      const cache = await caches.open(cacheName)
      const response = await cache.match(key)
      if (response) return response
    } catch {
      // The deployed app still loads online if the browser denies cache access.
    }
    return fetch(request)
  })())
})
