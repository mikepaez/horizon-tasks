# Horizon LifeOS — Obsidian GTD + PARA Plugin

A calm, Markdown-native Obsidian plugin (`isDesktopOnly: false`) that brings **Horizon's visual deadline stripe, Today-3 focus cap, `◐` next-step bookmark, `◷` waiting-on tracking, and 7–14d Fading Ink** into a clean **GTD + PARA** vault for **Windows + iPhone/iPad**.

---

## What Lives in `obsidian-plugin/horizon-lifeos/`
The built plugin files (`manifest.json`, `main.js`, `styles.css`) are committed directly in Git so you can install on a work PC with **zero build tools**:
- `obsidian-plugin/horizon-lifeos/manifest.json`
- `obsidian-plugin/horizon-lifeos/main.js`
- `obsidian-plugin/horizon-lifeos/styles.css`

---

## Setup Guide

### 1. Home PC (Already Ready)
1. Open Obsidian -> **Open folder as vault** -> select `C:\Obsidian\LifeOS`.
2. Go to **Settings -> Community plugins** -> turn on Community plugins -> verify **Horizon LifeOS (GTD + PARA)** is enabled.
3. Click the calendar icon on the left ribbon (or run `Ctrl+P` -> `Open Horizon Desk`).

### 2. Work PC (Zero Build Required)
1. Create a local vault folder **outside** Windows OneDrive sync (e.g. `C:\Obsidian\LifeOS`).
2. Install **Remotely Save**, connect to OneDrive Personal, and **run your first pull before creating any folders**.
3. Copy `obsidian-plugin/horizon-lifeos/` from this repo into `C:\Obsidian\LifeOS\.obsidian\plugins\horizon-lifeos\`.
4. Enable **Horizon LifeOS** in Settings -> Community plugins.

### 3. iPhone / iPad
- **Sync:** Install **Remotely Save** on iOS connected to the same OneDrive Personal vault (`LifeOS`, Auto Run every 5 min).
- **Install the plugin on iOS:**
  - *Option A:* Turn on **Sync Config Dir** in Remotely Save settings on all devices so `.obsidian/plugins/horizon-lifeos/` syncs automatically.
  - *Option B:* Use the **BRAT** community plugin pointing at GitHub Releases for `mikepaez/horizon-tasks`.
- **Voice Capture Apple Shortcut (Conflict-Free Per-Capture File):**
  1. **Dictate Text**
  2. **URL Encode** `[Dictated Text]`
  3. **Format Date** (`yyyyMMdd-HHmmss`)
  4. **Open URL**: `obsidian://new?vault=LifeOS&file=00_Inbox/Capture%20[Formatted%20Date]&content=[URL%20Encoded%20Text]&silent=true`

### 4. Migrating Today's Tasks & Exporting Anonymized Trends
- **Import from standalone Horizon:** Run `Ctrl+P` -> `Import Standalone Horizon tasks.json`, paste your JSON, click **Preview**, and import.
- **Anonymized long-term audit:** Run `Ctrl+P` -> `Export Anonymized GTD + PARA Audit` (or click **Audit** in the top bar). Generates title-free, name-free `.md`, `.json`, and `.csv` trend files in `90_System/Exports/`, enriched by per-device monthly anonymized event shards (`90_System/Exports/Events/events-<device>-<YYYY-MM>.jsonl`) that safely track rescheduling, Today-3 follow-through, Inbox lag, and review cadence across devices without conflicts.

---

## Rebuild & Test (Dev Machine)
```powershell
py obsidian-plugin/build_plugin.py
node obsidian-plugin/test/plugin.test.js
```
