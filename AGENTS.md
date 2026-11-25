# Agent instructions

Packet Pigeon is a client-only React, TypeScript, and Vite application for
MeshCore. See the README for setup and current scope.

- Keep changes small and focused. Add dependencies, routing, and abstractions
  only when a concrete feature needs them; do not imply unfinished features work.
- Keep radio, transport, and session logic in plain TypeScript independent of
  React. Connect it to the UI only when real behavior is ready.
- Design desktop-first, while keeping narrow windows usable. Use semantic HTML,
  visible keyboard focus, and accessible names. If adding right-click actions,
  provide equivalent discoverable keyboard and non-context-menu access.
- Never commit secrets or credentials. Do not send live radio transmissions
  without explicit authorization; use fixtures or mocks for ordinary checks.
- Use `npm ci` to install dependencies, `npm run dev` for local development,
  `npm run lint` for linting, and `npm run build` for type-checking and the
  production build. Run the smallest relevant checks and add focused tests for
  new behavior. Do not add parity-evidence gates or dedicated evidence tooling.
