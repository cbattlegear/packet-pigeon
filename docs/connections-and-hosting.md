# Connections and hosting

Connect a MeshCore companion radio over USB, Bluetooth, Wi-Fi, or Ethernet. These notes cover reconnect behavior, the LAN bridge, and static hosting.

## USB companion session

In a secure context with Web Serial available, open the radio menu in the header.
Use **Connect USB** to choose a port and **Disconnect** to release it. The shell reports connection, sync and
cache errors. After an unexpected disconnect, the same tab retries the
previously authorized port with delays of 1, 2, 4, 8 and 16 seconds. The
radio's full public key is checked before syncing. A successful identifiable
USB connection also saves its radio public key and USB vendor/product IDs in
browser storage. On a later page load, Packet Pigeon asks the browser for
previously authorized ports with `getPorts()` and restores only one exact
descriptor match, then checks the radio key before reading contacts or other
state. It does not invoke the device chooser during refresh restoration.
Choosing a different transport or device replaces that saved target; choosing a
device without stable browser identifiers disables refresh restoration for it.
If multiple authorized ports
match the original USB vendor and product, recovery stops rather than guessing;
use **Connect USB** to select a port. A missing port, revoked permission, a
failed identity check, or exhausted retries also requires manual recovery.
**Disconnect** cancels recovery and clears the saved refresh target. Refresh
restoration still depends on the browser exposing the authorized port and USB
identifiers; when it cannot, the shell remains disconnected and explains which
connection action to use. The public-key handshake is not cryptographic
authentication.

Web Locks reserve one USB session per origin across cooperating Packet Pigeon
tabs, including during retries; a second tab must wait for the owner to release
it. Browsers without Web Locks cannot connect safely. Other applications and
older versions of Packet Pigeon do not participate in this coordination.
If the port cannot be released, the owning tab keeps the lock and disables
reconnection until it is reloaded. If the browser or OS still holds the port,
close the tab or unplug the device before trying again.
Automatic USB recovery has been exercised with mocked ports, not a physical
unplug/replug on every supported browser.

`src/radio` exports `CompanionSession` and `getWebSerialSupport()`;
`connect()` must be called directly from a user action for the port chooser.

The implementation targets MeshCore USB companion firmware with protocol v3 or
newer. It uses the firmware's framed serial protocol directly: MeshCore.js was
used as a reference, but its package entrypoint includes native transports and
its browser adapter does not provide the request deadlines and error handling
needed here. The session does not cache channel secrets.

## Bluetooth companion session

On HTTPS or localhost in a browser with Web Bluetooth, use **Connect Bluetooth** in
the radio menu to choose a radio advertising the MeshCore companion service. Browser support,
Bluetooth adapter availability, and pairing permissions depend on the browser
and operating system.

Bluetooth uses the same companion handshake, sync, ownership lock, and bounded
reconnect schedule as USB. Reconnection reuses the authorized Bluetooth device
and checks its radio public key before syncing. A successful connection saves
the browser-assigned Bluetooth device ID and radio public key. Where the
browser exposes `getDevices()`, refresh restoration reuses that one permitted
device without opening the chooser; otherwise the shell asks for **Connect
Bluetooth**. **Disconnect** cancels recovery, clears the saved refresh target
and releases the connection. Pairing, GATT data exchange, refresh restoration
and disconnect recovery are covered by simulated transport tests. Physical BLE
hardware has not been tested.

Bluetooth syncs queued messages automatically, using the same message-waiting
notification as USB. **Sync messages** is available for a recheck or retry.
As with USB, each received response is saved before requesting the next. Each
Bluetooth notification is treated as a complete companion frame. BLE firmware
can split or drop responses that exceed the negotiated MTU, which Web Bluetooth
does not expose. Queued text responses have no total length, so incomplete text
can appear complete and cannot be reliably detected; fragments can also be
mistaken for other frames. Responses recognized as malformed or unsupported are
saved as raw bytes and stop sync; a dropped response can time out. The radio has
already dequeued the receipt, so missing bytes cannot be recovered. USB and
local network connections use frames with explicit lengths. Interruptions can
still lose a receipt.

## Wi-Fi and Ethernet companion session

Use a companion radio running MeshCore Wi-Fi or Ethernet firmware with its
network connection configured. Obtain the radio's IPv4 address from its display
or your router's DHCP list.

### Docker

For a Wi-Fi or Ethernet companion, create a `.env` file beside
`compose.yaml` with the radio's private IPv4 address.

```dotenv
MESHCORE_RADIO_IP=192.168.1.40
```

Start or restart the container with `docker compose up -d`. In the app, choose
**Connect local network** from the radio menu. The container must be able to
reach the radio on your LAN. The radio
uses TCP port `5000` by default. Set `MESHCORE_RADIO_PORT` if it uses a different
port. If the browser port is taken, set `PACKET_PIGEON_PORT` and open
`http://127.0.0.1` on that port. The web app is published on the host's
loopback interface. Run `docker compose down` to stop it.

### Run the bridge from source

From the project directory on the computer that will run Packet Pigeon, start
the local bridge using the radio's address.

```sh
npm ci
npm run build
npm run companion:lan -- 192.168.1.40
```

Open the printed URL in Chrome or Edge and choose **Connect local network** in the radio menu.
The defaults are TCP port `5000` on the radio and `http://127.0.0.1:4175` in
the browser. Supply the radio port and then the browser port after the address
to change them. The bridge accepts a private, link-local, or loopback IPv4
address and serves the built app on the same computer. The loopback origin has
its own browser cache, separate from your hosted installation.

The bridge relays MeshCore's framed protocol between the browser and the
configured radio. It accepts the local app's WebSocket origin and one radio
session at a time. After an unexpected disconnect, the app retries the same
bridge and checks the radio's full public key before syncing. Use the radio
on a trusted LAN because MeshCore's TCP link is unencrypted.
[MeshCore Wi-Fi transport](https://github.com/meshcore-dev/MeshCore/blob/main/src/helpers/wifi/SerialWifiInterface.cpp) ·
[MeshCore Ethernet transport](https://github.com/meshcore-dev/MeshCore/blob/main/src/helpers/ethernet/SerialEthernetInterface.cpp)

## Static hosting and offline browsing

Run `npm ci` and `npm run build`, then upload the complete contents of `dist`
to an HTTPS static host. The same build works at the origin root or under a
folder such as `/packet-pigeon/`. Serve `index.html` for that directory, redirect
directory URLs to the trailing slash form, and serve files with their usual
content types. Share the directory URL or direct links such as
`/packet-pigeon/#chats`. Fragment links work on reload without server rewrites.
For USB radio connections, use desktop Chrome or Edge over HTTPS or
localhost.

The [Azure Static Web Apps workflow](../.github/workflows/azure-static-web-apps-ambitious-stone-004cee510.yml)
builds and deploys `dist` on pushes to `main` and creates previews for pull requests.

Open the production build online to let its service worker cache the built HTML
and assets for its deployment directory.
Keep `sw.js` revalidatable (for example, `Cache-Control: no-cache`). An update
waits until all tabs using the previous version are closed. If a new cache fails
to install, the previous version stays active. Cache cleanup is limited to old
shell builds in the same directory. This leaves local history and other
browser storage available to the app. Use the same origin and subfolder when
opening the app offline. Deployments on different origins each have their own
browser storage.

To smoke-test the production cache locally, open the URL from `npm run preview`.
Once the service worker is active in browser developer tools, switch the browser
offline and open the same URL in another tab. After building, run
`node --test tests/offline-worker.test.mjs` to check cache scope and fallback.
