# Horizon — 3-Month Task Organizer

A compact Paper Desk task organizer with a 3-month horizontal deadline stripe where tasks fade from near-transparent to a solid color block as they approach.

## Two Ways to Run

### 1. Home PC (with Python)
Double-click `start.bat` (or run `py server.py` in PowerShell). Saves automatically to `tasks.json` in this folder.

### 2. Work Laptop (NO Python needed)
Copy the single file **`horizon-portable.html`** (~40 KB) to your work laptop and double-click it in Edge or Chrome.
- Works offline with zero installs or IT permissions.
- Click **Open file** or **New file** in the top bar (Edge/Chrome) to link a real `tasks.json` file (for example inside OneDrive or Documents) for automatic saving — or just use **Export / Import** anytime.

## Rebuilding the Single-File Version
Whenever you edit the app files, run:
```powershell
py build_portable.py
```
That regenerates `horizon-portable.html` automatically.

## Running Tests
- Python & portable bundle tests: `py test_server.py`
- Timeline & gradient logic tests: `node logic.test.js`
