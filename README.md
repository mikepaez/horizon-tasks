# Horizon — Task Organizer & Visual Horizon

A compact **Paper Desk** task organizer with a customizable horizontal deadline stripe (any range from `1` to `730` days, with quick presets from 1 week to 1 year) where tasks fade from near-transparent watercolor to a solid color block as they approach.

## Key Features (Horizon v2)
- **Customizable Visual Horizon (`1`–`730` days):** Enter any day count or choose a preset (`7d`, `14d`, `30d`, `90d`, `180d`, `365d`), with adaptive day/month axis landmarks, watercolor urgency gradient, clickable `Beyond Xd` chips, and an overdue strip with 1-click `+1w` snooze.
- **End Half-Finished Limbo:** Mark tasks **Started (`◐`)** with a visible 1-line `→ Next step` bookmark (plus an **End day** check chaining across started items), or **Waiting (`◷`)** with who you're waiting on tucked at the bottom of Later.
- **Expandable Steps, Notes & Recurrence:** Click `▸` (or press `E`) on any row to add up to 7 flat checklist steps (auto-starting the task and filling its Horizon bar proportionally), freeform notes with safe clickable `http(s)` links, and repeating schedules (`weekly`, `monthly`, `quarterly`, `yearly`) that automatically spawn the next occurrence when completed.
- **Fight Wallpaper Blindness (Fading Ink):** Active tasks untouched for 7–14 days gently fade, showing inline **Keep · Snooze 2w · Drop** controls at 14+ days (long-range milestones >21d out stay crisp until they enter the 21-day window).
- **20-Second Morning Check-in & Weekly Momentum:** Once-per-day inline banner (`Started · Waiting · Due soon · Fading`) with a 1-click card walk-through, a **Monday** last-week wins summary counting both tasks and milestone steps, and an unlinked export reminder when running offline on a work laptop.
- **Zero-Friction Capture, `#tags` & Work/Personal Split:** Quick-date chips (`Tomorrow`, `+1w`, `Next Mon`, `+1m`), inline tokens (`!today`, `#personal`, `#tag`, `@tom`, `@+3d`, `@+1w`, `@mon`; explicit date picker/chip overrides `@` tokens), clickable `#tag` filter chips, shortcuts (`N` add, `S` start, `E` details, `/` filter, `Ctrl+Z` undo), and cool slate tint / thinner bars for Personal items.
- **Two-PC OneDrive Sync:** Conflict-safe merging by task `id` + `updatedAt` with 30-day deletion tombstones, honest sync status pill, 1-click file reconnect, and targeted 5.5-second Undo.

---

## Two Ways to Run

### 1. Home PC (with Python)
Double-click `start.bat` or run:
```powershell
py server.py
```
To sync directly with a OneDrive `tasks.json`:
```powershell
py server.py --data-file "C:\Users\YOU\OneDrive\tasks.json"
```
*(Or set the `HORIZON_DATA` environment variable.)*

### 2. Work Laptop (Zero Installs)
Copy **`horizon-portable.html`** to your work laptop and double-click it in Edge or Chrome:
- Click **Open file** or **New file** to link directly to your OneDrive `tasks.json` (auto-saves + merges changes when switching PCs).
- On reload, click **Reconnect** (1 click) when remembered by the browser.
- If IT policy blocks direct file linking (check `edge://policy` for `FileSystem`), use **Export** / **Import** — Import merges by default instead of overwriting.
- If OneDrive creates a conflict copy like `tasks-LAPTOP.json`, just **Import** it to merge both files cleanly.

---

## Developer & AI Agent Guide

### File Map
| File | Role |
|---|---|
| `logic.js` | **Single source of truth** for schema v2, `normalizeTask()`, v1→v2 migration, `mergeTaskLists()`, DST-safe date math, and timeline/gradient calculations. Pure JS (no DOM/I/O). |
| `app.js` | UI controller + storage adapter. Runs the same `logic.js` transitions in both Server mode (`GET/PUT /api/data` with `ETag`/`If-Match`) and Portable mode (File System Access API + IndexedDB handle + `localStorage` rolling backup). |
| `server.py` | Compact stdlib-only localhost JSON store (`GET/PUT /api/data` with required `If-Match` ETag), atomic writes (unique temp→`fsync`→Windows-retried `os.replace` + `.bak`), UTF-8 BOM tolerance, and Host/Origin/CSRF/CSP guards. |
| `index.html` / `styles.css` | Paper Desk markup and CSS custom properties. All user text renders via `textContent` (no `innerHTML` with user data). |
| `build_portable.py` | Inlines CSS + JS into `horizon-portable.html` (guards against stray `</script>`/`</style>`). |
| `logic.test.js` / `test_server.py` | Automated test suites (including portable-bundle sync verification). |

### Data Contract (`tasks.json` schema v2)
Envelope: `{ "schema": 2, "savedAt": ISO-8601, "savedBy": deviceId, "tasks": [...] }`.
- Legacy v1 bare arrays auto-migrate on load (`inbox` → `later`) with a one-time `tasks.v1-backup-YYYYMMDD.json` backup.
- Task invariants enforced by `normalizeTask()`: `list ∈ {"today","later","done"}`, `stage ∈ {"todo","started","waiting"}`, `done` clears `stage`/`waitingOn`, `waiting` requires non-empty `waitingOn` and stays out of `today`.
- Deletion tombstones (`deleted: true`) are retained for 30 days so deletes sync across PCs (a machine offline >30 days may resurrect a task deleted elsewhere).

### Build & Verify Commands
Whenever you edit `index.html`, `styles.css`, `logic.js`, or `app.js`, rebuild the portable file and run both test suites:
```powershell
py build_portable.py
node logic.test.js
py test_server.py
```
