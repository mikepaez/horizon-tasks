# Horizon — Task Organizer & Visual Horizon

A calm, local-first Paper Desk task organizer with a customizable horizontal deadline stripe (any range from `1` to `730` days, with quick presets from 1 week to 1 year) where tasks fade from near-transparent to a solid color block as they approach.

## Features
- **Customizable Visual Horizon (`1`–`730` days):** Type any day count or pick a quick preset (`7d`, `14d`, `30d`, `90d`, `180d`, `365d`), with adaptive day/month axis landmarks, watercolor urgency gradient, overdue strip, and Do-Date (`Today`) vs. Due-Date separation.
- **Quick Capture & Shortcuts:** Inline `@today`, `@tom` / `@tomorrow`, `@+3d` / `@+2w` / `@+1m`, `#tags`, quick-date pills, plus keyboard shortcuts (`n` add, `/` search, `Ctrl+Z` undo, `Esc` close/blur).
- **Rich Task Details:** Double-click inline title editing, collapsible paper drawer with notes (auto-linked `http(s)` URLs), mini-checklist subtasks, and recurring tasks (`weekly`, `monthly`, `quarterly`, `yearly`).
- **Safe Local-First Sync:** Atomic writes + corrupt-file backups in Python mode, IndexedDB file-handle persistence with 1-click Reconnect in portable mode, external-change conflict detection, Merge/Replace import, and multi-step Undo.

## Two Ways to Run

### 1. Home PC (with Python)
Double-click `start.bat` (or run `py server.py` in PowerShell). Saves automatically and atomically to `tasks.json` in this folder.

### 2. Work Laptop (NO Python needed)
Copy the single file **`horizon-portable.html`** (~120 KB) to your work laptop and double-click it in Edge or Chrome.
- Works offline with zero installs or IT permissions.
- Click **Open file** or **New file** in the top bar (Edge/Chrome) to link a real `tasks.json` file (for example inside OneDrive or Documents) for automatic saving with conflict detection — or use **Export / Import** anytime.

## Rebuilding the Single-File Version
Whenever you edit the app files, run:
```powershell
py build_portable.py
```
That regenerates `horizon-portable.html` automatically.

## Running Tests
- Python & portable bundle tests: `py test_server.py`
- Timeline, recurrence, tags & gradient logic tests: `node logic.test.js`
