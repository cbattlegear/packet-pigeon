# Development

Use Node.js 24 and run the commands from the repository root.

## Local setup

```sh
npm ci
npm run dev
```

## Build and test

`npm run lint` runs Oxlint. `npm run build` type-checks and writes the static
site to `dist`. `npm run preview` serves that build locally. Run browser storage
tests with `npm run test:storage` and USB companion fixtures with
`node --test src/radio/companion-session.test.mjs`. Run the session/cache
integration fixture with `node --test src/integration/session-cache.test.js`.
Run message sync fixtures with `node --test src/integration/message-sync.test.js`.
Run direct-message fixtures with
`node --test src/radio/direct-message.test.mjs src/integration/direct-messages.test.js src/chats/model.test.js`.
Run channel-message framing fixtures with `node --test src/radio/channel-message.test.mjs`.
Run reaction protocol and persistence fixtures with
`node --test src/radio/reactions.test.mjs src/chats/reactions.test.mjs src/integration/direct-messages.test.js`.
Run the reaction picker regression with `node --test tests/browser/reactions.browser.mjs`.
These checks use mocks and do not need a radio.

With Google Chrome installed, run `npm run test:browser` for the browser
regressions. The tests use cached fixtures and simulated radios.

## Workstream boundaries

Keep work small and split by behavior, rather than creating empty layers up front:

- **UI:** `src/App.tsx` composes the workspaces and `src/WorkspaceHeader.tsx`
  provides global navigation. `src/App.css` owns shell layout. `src/index.css`
  owns global styles and shared color tokens.
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
  and applies any supplied local edits. Direct-message transitions allocate
  wire timestamps and update acknowledgement state atomically within the same
  per-radio cache. Failed writes reject without replacing the previous cache.
  Browser data clearing or eviction can remove the cache.
- **Integration:** `src/integration/session-cache.ts` captures completed lists
  and messages from session snapshots and queues writes under the session's
  full public key. `src/integration/message-sync.ts` automatically drains queued
  messages, saving each receipt before requesting the next. `src/integration/direct-messages.ts`
  manages user-initiated sends, acknowledgement tracking, and durable drafts.
  The UI subscribes to session and cache state; coordinate future changes to
  that boundary between workstreams.

Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests.

## Dependency licenses

Packet Pigeon is available under the [MIT License](../LICENSE). The production
build includes `LICENSE` and Vite's generated `third-party-licenses.md` for
bundled dependencies. The local bridge uses `ws` under its own MIT license,
included at `node_modules/ws/LICENSE` after installation.
