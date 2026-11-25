# Packet Pigeon

Open source MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The current app is a client-only shell with keyboard-accessible navigation and
user-initiated USB companion connection. It syncs contacts, channels and queued
receipts into a per-radio local cache; browsing that cache is not yet available.
The app does not send mesh packets.

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
These checks use mocks and do not need a radio.

## USB companion session

In a secure context with Web Serial available, use **Connect USB** to choose a
port and **Disconnect** to release it. The shell reports connection, sync and
cache errors. `src/radio` exports `CompanionSession` and `getWebSerialSupport()`;
`connect()` must be called directly from a user action for the port chooser.
The session reads contact and channel records and drains the companion's message
queue. Draining removes messages from the radio; the protocol does not provide
stable message IDs or replay for an interrupted read. Each received message has
a local `receiptId` UUID that can be reused on storage retries. Identical
content from separate receipts is not suppressed.

This is not exactly-once sync: the firmware dequeues a message before replying,
so interruption can lose a receipt. Cache writes that fail remain queued in
memory with their original IDs for **Retry saving**; closing or reloading the
page loses unsaved updates. The cache is browser-local and can be evicted.

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
  and received messages synchronously from session snapshots and queues writes
  under the session's full public key. The UI subscribes to session and cache
  state; coordinate future changes to that boundary between workstreams.

Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests. CI and license selection are outside this starter's scope.
