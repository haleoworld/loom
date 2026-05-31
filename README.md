# Loom

A single-file, mobile-first thinking-continuity system that weaves your fragments, threads, projects, and life goals into one coherent fabric. No build step, no dependencies, no server. Open `index.html` in a browser, "Add to Home Screen" on your phone, and it runs offline with data stored on-device.

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
5. **Coherence check** (Threads tab, when you have ≥2 projects) exports all projects + active threads for a cross-project conflict + drift audit.

## Data & backup
- Stored in this browser's `localStorage` only — private, on-device.
- **Back up regularly** via Global → Backup (downloads JSON). Restore re-imports it.
- Installing to the home screen protects the data from Safari's auto-cleanup.

## Phase 1 scope (deliberately minimal)
Capture · threads · sorted-criteria enforcement · Claude prompt export · coherence check · backup.
Not built yet (and shouldn't be until this has been lived in for a few weeks): automated weekly synthesis, the dashboard, voice capture, cross-thread pattern detection. See the proposal for the full roadmap.

## Stack
Vanilla HTML/CSS/JS in one file. Chosen for near-zero cost and near-zero maintenance — nothing to update, nothing to host beyond a static file.
