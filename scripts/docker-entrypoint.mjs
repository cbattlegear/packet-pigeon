import { startLanBridge } from './lan-companion.mjs'

const radioHost = process.env.MESHCORE_RADIO_IP || undefined
const radioPort = process.env.MESHCORE_RADIO_PORT
const publicPort = process.env.PACKET_PIGEON_PORT

try {
  const server = await startLanBridge({
    radioHost,
    radioPort: radioPort ? Number(radioPort) : undefined,
    publicPort: publicPort ? Number(publicPort) : undefined,
    // Docker publishes this listener only on the host's IPv4 loopback address.
    bindHost: '0.0.0.0',
  })
  console.log(`Open ${server.url}${radioHost ? ' and select Connect local network' : ''}.`)
  process.once('SIGTERM', () => void server.close())
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
