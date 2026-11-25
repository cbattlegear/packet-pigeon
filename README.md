# Packet Pigeon

Open source MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The current UI is a static, client-only shell with keyboard-accessible navigation
and an explicit empty workspace. The USB companion session exists as a standalone
module but is not yet wired to the shell. The app does not send mesh packets.

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
serves that build locally; it is not a production server. Run the USB companion
fixtures with `node --test src/radio/companion-session.test.mjs`.

## USB companion session

`src/radio` exports `CompanionSession` and `getWebSerialSupport()`. In a secure
context with Web Serial available, call `connect()` directly from a user action
to open the browser's port chooser. Use `subscribe()` and `getSnapshot()` for
connection state and sync progress, and call `disconnect()` to release the port.
The session reads contact and channel records and drains the companion's message
queue. Draining removes messages from the radio; the protocol does not provide
stable message IDs or replay for an interrupted read. Each received message has
a local `receiptId` UUID that can be reused on storage retries. Identical
content from separate receipts is not suppressed.

The implementation targets MeshCore USB companion firmware with protocol v3 or
newer. It uses the firmware's framed serial protocol directly: MeshCore.js was
used as a reference, but its package entrypoint includes native transports and
its browser adapter does not provide the request deadlines and error handling
needed here. The session does not expose channel secrets or transmit over the mesh.

## Workstream boundaries

Keep work small and split by behavior, rather than creating empty layers up front:

- **UI:** `src/App.tsx` owns the shell and page content. `src/App.css` owns shell
  layout; `src/index.css` owns global styles and shared color tokens.
  `src/main.tsx` is the React entry point. Extract components as the UI grows.
  Preserve desktop-first layouts, semantic HTML, visible keyboard focus, and
  usable narrow-window behavior. Do not present placeholders as working controls.
- **Radio and sessions:** add plain TypeScript modules under `src/radio` when
  implementing the first real radio behavior. Keep protocol, transport, and
  session logic independent of React: no React imports or UI state in those
  modules. Introduce only the contracts needed by that behavior and test it
  independently.
- **Integration:** once radio behavior exists, connect it to the UI through a
  small React adapter or hook with explicit loading and error states. Coordinate
  that boundary between workstreams before both sides depend on it.

Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests. CI, deployment, and license selection are outside this
starter's scope.
