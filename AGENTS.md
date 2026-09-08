# Kernel Deck project guidance

<!-- personal-context:auto-project -->

Kernel Deck is a Windows local workbench for parallel AI CLI terminals. The repository is `Puro-33/ai-kernel-manager`; the user's current default is public GitHub code publication.

- `server/manager.mjs` owns real PTYs, queueing, persisted state/logs and exclusive data-folder ownership. `server/index.mjs` serves loopback-only HTTP/WebSocket APIs. `server/environment.mjs` detects installed CLIs and observes external processes without controlling them.
- `web/` contains the Korean xterm.js UI. `scripts/build.mjs` bundles it to `dist/`; preserve the API contract in `CONTRACT.md` when changing either side.
- Install dependencies with `npm ci`; run `npm run build` and `npm test` for relevant changes. Browser lifecycle validation is `npm run test:e2e`. `npm run test:cli` checks locally installed AI CLIs without sending user prompts or login/permission responses.
- Windows release commands: `npm run package:windows`, then `npm run test:package`. `start.cmd` launches the application; `stop.cmd` shuts down its own sessions and server.
- Keep `node-pty` pinned while its Windows native lifecycle fields are used. Confirm actual exit before releasing concurrency slots; do not send delayed kills to saved PIDs. Existing external AI processes remain observation-only.
- Preserve `.data/`, unrelated work and active user sessions. Do not commit runtime logs, session metadata, credentials, environment files, generated ZIPs or test artifacts. Release scripts must select application files explicitly and include dependency licenses.
- Use scoped commits and pushes, verify the remote ref and any published release assets. Do not force-push or change other repositories as part of routine project work.
