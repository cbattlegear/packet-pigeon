import { createServer } from 'node:http'
import { connect, isIPv4 } from 'node:net'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { lanProtocolHeader, lanSocketPath, lanSocketProtocol, lanStatusPath } from '../src/radio/lan-bridge.ts'
import { maxCompanionFrameSize } from '../src/radio/transport.ts'

const browserHost = '127.0.0.1'
const defaultRadioPort = 5000
const defaultBrowserPort = 4175
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
}

function localAddress(host) {
  if (!isIPv4(host)) return false
  const [a, b] = host.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254)
}

function below(root, path) {
  const name = relative(root, path)
  return name && !isAbsolute(name) && name.split(/[\\/]/)[0] !== '..'
}

async function staticFile(root, pathname) {
  const name = decodeURIComponent(pathname)
  if (/[\\\0]/.test(name)) return null
  const requested = resolve(root, `.${name}`)
  if (!below(root, requested)) return null
  const path = await realpath(requested)
  if (!below(root, path) || !(await stat(path)).isFile()) return null
  return { body: await readFile(path), mime: mimeTypes[extname(path)] ?? 'text/plain; charset=utf-8' }
}

function tunnel(browser, radio) {
  const deadline = setTimeout(() => radio.destroy(new Error('Radio TCP connection timed out')), 5_000)
  radio.setNoDelay(true)
  radio.once('connect', () => clearTimeout(deadline))
  radio.once('close', () => {
    clearTimeout(deadline)
    if (browser.readyState === WebSocket.OPEN) browser.close(1000, 'Radio disconnected')
  })
  radio.on('error', () => {
    if (browser.readyState === WebSocket.OPEN) browser.close(1011, 'Radio TCP connection failed')
  })
  browser.once('close', (code) => {
    if (code !== 1000 || radio.destroyed) return radio.destroy()
    // A normal browser close can immediately follow a reboot or reset command.
    radio.end()
    const finish = setTimeout(() => radio.destroy(), 1_000)
    radio.once('close', () => clearTimeout(finish))
  })
  browser.once('error', () => radio.destroy())

  browser.on('message', (frame, binary) => {
    if (!binary || !Buffer.isBuffer(frame) || frame.length < 4 || frame[0] !== 0x3c ||
      frame.readUInt16LE(1) !== frame.length - 3) {
      browser.close(1003, 'Expected one binary companion command')
      radio.destroy()
      return
    }
    if (radio.destroyed) return
    if (!radio.write(frame)) {
      browser.pause()
      radio.once('drain', () => browser.resume())
    }
  })
  radio.on('data', (chunk) => {
    if (browser.readyState !== WebSocket.OPEN) return radio.destroy()
    radio.pause()
    browser.send(chunk, { binary: true }, (error) => {
      if (error) radio.destroy()
      else radio.resume()
    })
  })
}

export async function startLanBridge({ radioHost, radioPort = defaultRadioPort, browserPort = defaultBrowserPort,
  distDir = fileURLToPath(new URL('../dist/', import.meta.url)) }) {
  if (!localAddress(radioHost)) throw new Error('Enter a private, link-local, or loopback IPv4 address for the companion.')
  if (!Number.isInteger(radioPort) || radioPort < 1 || radioPort > 65535 ||
    !Number.isInteger(browserPort) || browserPort < 0 || browserPort > 65535) throw new Error('Enter valid TCP port numbers.')

  const root = await realpath(distDir).catch(() => { throw new Error('Run npm run build before starting the local bridge.') })
  const html = await readFile(resolve(root, 'index.html'), 'utf8')
    .catch(() => { throw new Error('Run npm run build before starting the local bridge.') })
  const index = { body: html, mime: mimeTypes['.html'] }
  const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: maxCompanionFrameSize + 3,
    handleProtocols: (offered) => offered.has(lanSocketProtocol) && lanSocketProtocol })
  let active
  let host
  let origin
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host) return response.writeHead(403).end()
    if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405).end()
    let path
    try { path = new URL(request.url, origin) }
    catch { return response.writeHead(400).end() }
    if (path.origin !== origin) return response.writeHead(403).end()
    if (path.pathname === lanStatusPath) {
      return response.writeHead(204, { [lanProtocolHeader]: lanSocketProtocol, 'Cache-Control': 'no-store' }).end()
    }
    let file
    try { file = path.pathname === '/' || path.pathname === '/index.html' ? index : await staticFile(root, path.pathname) }
    catch { return response.writeHead(404).end() }
    if (!file) return response.writeHead(404).end()
    response.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    response.end(request.method === 'HEAD' ? undefined : file.body)
  })
  server.on('upgrade', (request, socket, head) => {
    const offered = request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim())
    if (request.headers.host !== host || request.headers.origin !== origin || request.url !== lanSocketPath ||
      !offered?.includes(lanSocketProtocol)) {
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
    if (active) return socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    sockets.handleUpgrade(request, socket, head, (browser) => {
      const radio = connect(radioPort, radioHost)
      active = { browser, radio }
      radio.once('close', () => { active = undefined })
      tunnel(browser, radio)
    })
  })
  await new Promise((ready, reject) => {
    server.once('error', reject)
    server.listen(browserPort, browserHost, () => {
      server.removeListener('error', reject)
      host = `${browserHost}:${server.address().port}`
      origin = `http://${host}`
      ready()
    })
  })
  return { url: origin, close: () => new Promise((done, reject) => {
    active?.radio.destroy()
    active?.browser.terminate()
    server.close((error) => { if (error) reject(error); else done() })
    server.closeAllConnections()
    sockets.close()
  }) }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [radioHost, radioPort = String(defaultRadioPort), browserPort = String(defaultBrowserPort)] = process.argv.slice(2)
  try {
    if (!radioHost || process.argv.length > 5) throw new Error('Usage: npm run companion:lan -- <radio-ip> [radio-port] [browser-port]')
    const bridge = await startLanBridge({ radioHost, radioPort: Number(radioPort), browserPort: Number(browserPort) })
    console.log(`Open ${bridge.url} and select Connect local network.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
