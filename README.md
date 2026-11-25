# Packet Pigeon

Open source MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The current app is a client-only shell with keyboard-accessible navigation and
user-initiated USB companion connection. It syncs contacts and channels into a
per-radio local cache. The map can show synced contacts from the current
session. Chats can manually sync and display received queue entries. The app
does not yet send mesh packets.

## Getting started

Use Node.js 24 LTS and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To check and build the app:

```sh
npm run lint
npm run build
npm run preview
```

`lint` runs the standard scaffold's Oxlint configuration. `build` runs the
TypeScript project build and produces the static site in `dist`. `preview`
serves that build locally; it is not a production server. Run browser storage
tests with `npm run test:storage` and USB companion fixtures with
`node --test src/radio/companion-session.test.mjs`. Run the session/cache
integration fixture with `node --test src/integration/session-cache.test.js`.
Run message sync fixtures with `node --test src/integration/message-sync.test.js`.
These checks use mocks and do not need a radio.

## USB companion session

In a secure context with Web Serial available, use **Connect USB** to choose a
port and **Disconnect** to release it. The shell reports connection, sync and
cache errors. After an unexpected disconnect, the same tab retries the
previously authorized port with delays of 1, 2, 4, 8 and 16 seconds. The
radio's full public key is checked before syncing. If multiple authorized ports
match the original USB vendor and product, recovery stops rather than guessing;
use **Connect USB** to select a port. A missing port, revoked permission, a
failed identity check, or exhausted retries also requires manual recovery.
**Disconnect** cancels recovery. Recovery is not persisted across a reload and
requires the browser to expose the replugged port and USB identifiers. The
public-key handshake is not cryptographic authentication.

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
Use **Sync messages** in Chats to request queued receipts. Each receipt,
including an unsupported or malformed response's raw bytes, is saved before
requesting another; receipts are shown individually and are not deduplicated
by their contents. Unrecognized or malformed responses are saved as raw bytes
and stop the sync for inspection; they can also be device errors rather than
receipts. If saving fails, syncing stops and the receipt stays in memory
for retry. Keep the tab open until it has been saved. Failed contact or channel
writes remain queued in memory for **Retry saving**; closing or reloading the
page loses unsaved updates.

Earlier development builds may already have dequeued messages: those saved in
the local cache are browsable, while unsaved receipts lost on page close cannot
be recovered from the radio.

Message sync and recovery have been tested with mocked ports and storage, not
physical hardware. The firmware dequeues before replying, so interruption
between dequeue and durable save can lose a receipt; exactly-once delivery is
not possible. Browser storage eviction can also remove saved receipts.

The implementation targets MeshCore USB companion firmware with protocol v3 or
newer. It uses the firmware's framed serial protocol directly: MeshCore.js was
used as a reference, but its package entrypoint includes native transports and
its browser adapter does not provide the request deadlines and error handling
needed here. The session does not expose channel secrets or transmit over the mesh.

## Static hosting and offline browsing

Run `npm ci` and `npm run build`, then upload the complete contents of `dist`
to an HTTPS static host. The same build works at the origin root or under a
folder such as `/packet-pigeon/`. Serve `index.html` for that directory, redirect
directory URLs to the trailing slash form, and serve files with their usual
content types. Share the directory URL or direct links such as
`/packet-pigeon/#chats`. Fragment links work on reload without server rewrites.
For USB radio connections, use desktop Chrome or Edge over HTTPS or
localhost.

Open the production build online and wait for **App available offline** in the
header. The service worker caches the built HTML and assets for its deployment
directory.
Keep `sw.js` revalidatable (for example, `Cache-Control: no-cache`). An update
waits until all tabs using the previous version are closed. If a new cache fails
to install, the previous version stays active. Cache cleanup is limited to old
shell builds in the same directory. This leaves local history and other
browser storage available to the app. Use the same origin and subfolder when
opening the app offline. Deployments on different origins each have their own
browser storage.

To smoke-test the production cache locally, open the URL from `npm run preview`,
wait for **App available offline**, switch the browser offline, and open
the same URL in another tab. After building, run
`node --test tests/offline-worker.test.mjs` to check cache scope and fallback.

## Workstream boundaries

Keep work small and split by behavior, rather than creating empty layers up front:

- **UI:** `src/App.tsx` owns the shell and page content. `src/App.css` owns shell
  layout; `src/index.css` owns global styles and shared color tokens.
  `src/main.tsx` is the React entry point. Extract components as the UI grows.
  Preserve desktop-first layouts, semantic HTML, visible keyboard focus, and
  usable narrow-window behavior. Navigation uses native fragment links, including
  their standard right-click and keyboard alternatives. Do not present placeholders
  as working controls.
- **Radio and sessions:** keep `src/radio` protocol, transport, and
  session logic independent of React: no React imports or UI state in those
  modules. Introduce only the contracts needed by that behavior and test it
  independently.
- **Storage:** `src/storage` keeps a separate IndexedDB cache for each radio.
  Use the full public key returned by the radio session's handshake, never its
  display name or port, and capture that key when starting a sync. The handshake
  does not cryptographically authenticate the device. While offline,
  explicitly select a cached key using `listRadioKeys`, then `read` it. Map
  radio data into the storage records; do not include channel secrets or
  credentials. Assign each received message a per-radio ID and reuse it when
  retrying that storage write. The radio does not supply a message ID, so
  separate receipts are not deduplicated by timestamp or text. An `update`
  atomically replaces supplied contact/channel lists, appends unseen messages,
  and applies any supplied local edits. Failed writes reject without replacing
  the previous cache. Browser data clearing or eviction can remove the cache.
- **Integration:** `src/integration/session-cache.ts` captures completed lists
  and messages from session snapshots and queues writes under the session's
  full public key. `src/integration/message-sync.ts` saves each manually fetched
  receipt before requesting the next. The UI subscribes to session and cache
  state; coordinate future changes to that boundary between workstreams.

Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests. CI and license selection are outside this starter's scope.

## Map and terrain planning

Use **Map** to pan, zoom, and search nodes by name or public key. The base map
starts with public-domain [Natural Earth land data](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/).
Selecting OpenStreetMap requests tiles for the viewed area.
**Show my location** requests browser permission and keeps that position in
the current visit. The Local contacts view includes the current USB session's
synced contacts. Imported local contacts and discovered nodes stay on this
browser. A local JSON import replaces the previous imported list.

Local JSON can contain an array of nodes or an object with a `nodes` array. Each
node uses a 64-character hex `publicKey`, a `name`, and a numeric `role`
(1 companion, 2 repeater, 3 room server, 4 sensor). Optional fields include
`position` with numeric `lat` and `lon`, `favorite`, and `source` set to
`"discovery"`. MeshCore's `public_key`, `adv_name`, `type`, `adv_lat`, and
`adv_lon` fields also work.

The official MeshCore node API restricts cross-origin reads. Open the official
live map for current data, or save its linked JSON snapshot and import it for
in-app search. Node publishing and removal use the official MeshCore workflows.
Imported snapshots stay in the current visit and can be reopened offline from
the saved file.

Use **Tools** to enter coordinates, pick points on the map, or use a
repeater from the node list. Calculating sends sample coordinates to Open-Meteo,
which serves Copernicus DEM elevation data. Coverage classifies sampled points
in twelve directions and is a geometric estimate. It includes Earth curvature
and omits buildings, vegetation, interference, and Fresnel clearance. Consult
[Open-Meteo's usage terms](https://open-meteo.com/en/docs/elevation-api) for
commercial deployments. Use the coverage export
to keep layers between visits. Coverage files include site coordinates.

Run the map and terrain checks with
`node --test tests/node-map.test.mjs tests/terrain.test.mjs`.
