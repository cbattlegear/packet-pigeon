# Packet Pigeon

Open source MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The current app is a static, client-only shell with keyboard-accessible navigation
and an explicit empty workspace. It does not connect to radios, manage sessions,
or send packets. No backend, router, or radio library is included yet.

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
serves that build locally; use a static web host for production.

## Static hosting and offline browsing

Run `npm ci` and `npm run build`, then upload the complete contents of `dist`
to an HTTPS static host. The same build works at the origin root or under a
folder such as `/packet-pigeon/`. Serve `index.html` for that directory, redirect
directory URLs to the trailing slash form, and serve files with their usual
content types. Share the directory URL or direct links such as
`/packet-pigeon/#about`. Fragment links work on reload without server rewrites.
For future USB radio connections, use desktop Chrome or Edge over HTTPS or
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
  usable narrow-window behavior. Do not present placeholders as working controls.
- **Radio and sessions:** add plain TypeScript modules under `src/radio` when
  implementing the first real radio behavior. Keep protocol, transport, and
  session logic independent of React: no React imports or UI state in those
  modules. Introduce only the contracts needed by that behavior and test it
  independently.
- **Integration:** once radio behavior exists, connect it to the UI through a
  small React adapter or hook with explicit loading and error states. Coordinate
  that boundary between workstreams before both sides depend on it.

The radio directory and integration layer are intentionally not scaffolded.
Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests. CI and license selection are outside this starter's scope.
