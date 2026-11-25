import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const worker = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8')
const scope = 'https://example.test/packet-pigeon/'

function loadWorker({ cacheNames = [], cacheFailure = false } = {}) {
  const listeners = new Map()
  const precached = new Map()
  const deleted = []
  const cache = {
    async addAll(requests) {
      for (const request of requests) precached.set(request.url, request)
    },
    async match(url) {
      return precached.has(url) ? new Response(url) : undefined
    },
  }
  runInNewContext(worker, {
    self: {
      registration: { scope },
      clients: { async claim() {} },
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    caches: {
      async open() {
        if (cacheFailure) throw new Error('Cache unavailable')
        return cache
      },
      async keys() { return cacheNames },
      async delete(name) { deleted.push(name) },
    },
    URL,
    Request,
    fetch: async () => new Response('network'),
  })
  return {
    precached,
    deleted,
    dispatch(name, request) {
      let completion
      listeners.get(name)({
        request,
        waitUntil: (result) => { completion = result },
        respondWith: (response) => { completion = response },
      })
      return completion
    },
  }
}

function request(url, mode = 'cors', method = 'GET') {
  return { url, mode, method, headers: new Headers() }
}

test('caches release files under the deployment directory and serves its shell offline', async () => {
  const { dispatch, precached } = loadWorker()
  await dispatch('install')
  const files = [...precached.keys()]
  assert(files.includes(scope + 'index.html'))
  assert(files.some((url) => url.endsWith('.js')))
  assert(files.some((url) => url.endsWith('.css')))
  assert(files.every((url) => url.startsWith(scope) && !url.endsWith('sw.js')))

  const response = await dispatch('fetch', request(scope + '?example=private', 'navigate'))
  assert.equal(await response.text(), scope + 'index.html')
  assert.equal(dispatch('fetch', request('https://tiles.example.test/image.png')), undefined)
  assert.equal(dispatch('fetch', request(scope + 'api/messages')), undefined)
  assert.equal(dispatch('fetch', request(scope, 'navigate', 'POST')), undefined)
  assert.equal(dispatch('fetch', request('https://example.test/other/', 'navigate')), undefined)
})

test('removes only previous shell caches for the same deployment', async () => {
  const oldCache = `packet-pigeon-shell:${scope}:previous`
  const cacheNames = ['radio-records', 'packet-pigeon-shell:https://example.test/other/:old', oldCache]
  const { dispatch, deleted } = loadWorker({ cacheNames })
  await dispatch('activate')
  assert.deepEqual(deleted, [oldCache])
})

test('falls back to the network when reading the shell cache fails', async () => {
  const { dispatch } = loadWorker({ cacheFailure: true })
  await assert.rejects(dispatch('install'), /Cache unavailable/)
  const response = await dispatch('fetch', request(scope, 'navigate'))
  assert.equal(await response.text(), 'network')
})
