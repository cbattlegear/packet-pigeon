# Packet Pigeon

Open source MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The current app is a static, client-only shell with keyboard-accessible navigation,
an empty conversation workspace, and unavailable device and sync status. It
does not connect to radios, manage sessions, or send packets. No backend, router,
or radio library is included yet.

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
serves that build locally; it is not a production server. Run the focused
browser storage tests with `npm run test:storage`; they use a test-only
IndexedDB implementation without connecting to a radio.

## Workstream boundaries

Keep work small and split by behavior, rather than creating empty layers up front:

- **UI:** `src/App.tsx` owns the shell and page content. `src/App.css` owns shell
  layout; `src/index.css` owns global styles and shared color tokens.
  `src/main.tsx` is the React entry point. Extract components as the UI grows.
  Preserve desktop-first layouts, semantic HTML, visible keyboard focus, and
  usable narrow-window behavior. Navigation uses native fragment links, including
  their standard right-click and keyboard alternatives. Do not present placeholders
  as working controls.
- **Radio and sessions:** add plain TypeScript modules under `src/radio` when
  implementing the first real radio behavior. Keep protocol, transport, and
  session logic independent of React: no React imports or UI state in those
  modules. Introduce only the contracts needed by that behavior and test it
  independently.
- **Storage:** `src/storage` keeps a separate IndexedDB cache for each radio.
  Use the full public key verified by the radio session, never its display
  name or port, and capture that key when starting a sync. While offline,
  explicitly select a cached key using `listRadioKeys`, then `read` it. Map
  radio data into the storage records; do not include channel secrets or
  credentials. Assign each received message a per-radio ID and reuse it when
  retrying that storage write. The radio does not supply a message ID, so
  separate receipts are not deduplicated by timestamp or text. An `update`
  atomically replaces supplied contact/channel lists, appends unseen messages,
  and applies any supplied local edits. Failed writes reject without replacing
  the previous cache. Browser data clearing or eviction can remove the cache.
- **Integration:** once radio behavior exists, connect it to the UI through a
  small React adapter or hook with explicit loading and error states. Coordinate
  that boundary between workstreams before both sides depend on it.

The radio directory and integration layer are intentionally not scaffolded.
Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests. CI, deployment, and license selection are outside this
starter's scope.
