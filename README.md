# Loom

A mobile-first thinking-continuity system that weaves your fragments, threads, projects, and life goals into one coherent fabric. The UI is a single `index.html`; a tiny dependency-free Node server self-hosts it on an always-on Mac Mini and syncs your data across devices over Tailscale. "Add to Home Screen" on your phone and it runs as an offline-capable app.

## Why it exists
To let you **think in fragments, have AI carry the thread, and stay coherent across projects** when sustained focus is rare. The job it does that you can't hold in your head while interrupted: a two-axis coherence check —

- **Vertical:** does each decision still serve your ultimate life goals?
- **Horizontal:** do your projects coexist without pulling against each other?

## Three layers
1. **Global** — your ultimate life goals + thinking models (the fixed reference frame).
2. **Projects** — a goal and *your role* for each domain (work, parenting, finance, skill, personal).
3. **Threads** — live lines of thinking. Fragments feed in; Q&A turns advance them; they close only with a recorded outcome.

## How a session works
1. **Capture** a fragment (Just-log when tired; Engage-AI when focused).
2. Engage-AI builds a **one-question prompt** — paste it into the Claude app, get exactly one hard question back.
3. **Record** the question + your answer onto the thread.
4. **Sort** the thread when it's truly resolved: `decision` / `action` / `kill` / `park` — each requires its own field (a date, a reason, or a wake trigger). It can't close on a feeling.
5. **Coherence check** (Threads tab, with ≥1 project) exports all projects + active threads for a vertical-alignment + cross-project conflict + drift audit.

## Data & sync
- Self-hosted on the always-on **Mac Mini**, served over **Tailscale** (tailnet-only) at
  `https://jerrys-mac-mini.tailac0a52.ts.net/loom`.
- `server.js` stores everything in **`~/.loom/data.json` on the Mini** — nothing touches any third party.
- **Sync is automatic and cross-device:** each device pulls on open/focus and pushes (debounced) on every change.
  Whole-document last-write-wins by `meta.updatedAt`, with a server-side stale-write guard (409 → re-pull).
- Each device also keeps a local `localStorage` copy, so the app works offline and syncs when the tailnet is back.
- Auth: a bearer token in `~/.loom/token`, auto-generated and injected into the page by the server — only your
  tailnet devices can load it or read/write data. No token typing.
- **Backups:** Global → Backup downloads a JSON snapshot anytime; `~/.loom/data.json` is also trivially copyable.

### Operations (on the Mini)
- Service: `com.loom.sync` LaunchAgent (`~/Library/LaunchAgents/com.loom.sync.plist`) — `RunAtLoad` + `KeepAlive`,
  starts on boot and restarts if it dies. Logs: `~/.loom/server.log`.
- Restart after editing `server.js`: `launchctl kickstart -k gui/$(id -u)/com.loom.sync`
- Tailscale mount: `tailscale serve --bg --set-path /loom http://localhost:8743` (alongside `/job-agent`).
- Update the app: edit `index.html` here — it's live immediately (no build, no deploy).

## Phase 1 scope (deliberately minimal)
Capture · threads · sorted-criteria enforcement · Claude prompt export · coherence check · backup.
Not built yet (and shouldn't be until this has been lived in for a few weeks): automated weekly synthesis, the dashboard, voice capture, cross-thread pattern detection. See the proposal for the full roadmap.

## Stack
Vanilla HTML/CSS/JS (`index.html`) + a ~120-line dependency-free Node server (`server.js`) + a small service worker (`sw.js`). No frameworks, no build, no third-party services. Chosen for near-zero cost and near-zero maintenance — it reuses the Mac Mini + Tailscale setup already in place.
