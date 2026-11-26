/**
 * vault-adapter.js — Cross-Platform Obsidian Vault Adapter (Desktop + iOS)
 *
 * Uses strictly Obsidian's Vault, MetadataCache, FileManager, MarkdownView,
 * and Plugin data APIs (zero Node fs/path/Buffer, zero browser storage).
 *
 * Key safety rules:
 *   - Never writes to Markdown files during startup or background scans.
 *   - Every line mutation uses atomic vault.process (or live MarkdownView editor)
 *     and verifies the exact line before patching; aborts cleanly on mismatch.
 *   - Project frontmatter mutations go strictly through fileManager.processFrontMatter.
 */

const obsidian = require("obsidian");
const logic = require("./logic-core");
const codec = require("./markdown-codec");

const DEFAULT_SETTINGS = {
  inboxFolder: "00_Inbox",
  projectsFolder: "10_Projects",
  areasFolder: "20_Areas",
  resourcesFolder: "30_Resources",
  archivesFolder: "40_Archives",
  systemFolder: "90_System",
  todayCap: 3,
  horizonDays: 90,
  openOnStartup: false,
  inboxCaptureMode: "per-file", // "per-file" | "quick-inbox"
  lastUsedArea: "Work",
  areaRampOverrides: {},
};

const DEFAULT_PREFS = {
  waitingExpanded: false,
  laterFilter: "active", // "active" | "projects" | "someday"
  selectedArea: "all",
  lastCheckinDate: "",
  lastCheckinUpdatedAt: 0,
};

const DEFAULT_AREAS = ["Work", "Personal", "Health", "Finance"];

class ExternalConflictError extends Error {
  constructor(message = "File changed externally — view refreshed") {
    super(message);
    this.name = "ExternalConflictError";
  }
}

function escapeYamlQuoted(val) {
  const s = String(val || "").replace(/\r?\n/g, " ").trim();
  if (!s) return '""';
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseFrontmatterFallback(content) {
  const lines = String(content || "").split(/\r?\n/);
  const fmEnd = codec.getFrontmatterEndIndex(lines);
  if (fmEnd <= 0) return {};
  const fm = {};
  for (let i = 1; i < fmEnd; i++) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === "true") fm[key] = true;
    else if (val === "false") fm[key] = false;
    else fm[key] = val;
  }
  return fm;
}

class VaultAdapter {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.sidecar = {
      settings: { ...DEFAULT_SETTINGS },
      prefs: { ...DEFAULT_PREFS },
      touchedMap: {},
    };
    this.lastLineHashes = new Map();
    this.ephemeralTouched = new Map();
    this.sessionDeviceTag = Math.random().toString(36).slice(2, 8);
    this.onRefreshNeeded = null;
  }

  getDeviceTag() {
    const plat = obsidian.Platform?.isMobile ? "mob" : "desk";
    const appId = typeof this.app?.appId === "string" && this.app.appId.trim() ? this.app.appId.trim() : this.sessionDeviceTag;
    const shortHash = logic.hashString32(appId).toString(36).slice(0, 6);
    return `${plat}-${shortHash}`;
  }

  async logBehaviorEvent({ item = null, hashId = "", kind = "task", area = "", event, meta = null, now = new Date() }) {
    try {
      const f = this.getFolders();
      const eventsDir = obsidian.normalizePath(`${f.system}/Exports/Events`);
      await this.ensureFolder(eventsDir);
      const dt = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
      const monthKey = logic.toDateKey(dt).slice(0, 7);
      const shardPath = obsidian.normalizePath(`${eventsDir}/events-${this.getDeviceTag()}-${monthKey}.jsonl`);
      const entry = logic.createBehaviorEvent({ item, hashId, kind, area, event, meta, now: dt });
      const jsonLine = JSON.stringify(entry);

      let file = this.app.vault.getAbstractFileByPath(shardPath);
      if (!file) {
        await this.app.vault.create(shardPath, `${jsonLine}\n`);
        return;
      }
      await this.app.vault.process(file, (content) => {
        const trimmed = content.replace(/\s+$/, "");
        return trimmed ? `${trimmed}\n${jsonLine}\n` : `${jsonLine}\n`;
      });
    } catch {
      // Never let analytics logging block or fail a user task action
    }
  }

  async recordReviewCompleted(eventKind) {
    if (eventKind !== "checkin_complete" && eventKind !== "weekly_review_complete") return;
    await this.logBehaviorEvent({
      hashId: "hz_system",
      kind: "system",
      area: "System",
      event: eventKind,
    });
  }

  async readAllBehaviorEvents() {
    const f = this.getFolders();
    const eventsPrefix = `${obsidian.normalizePath(`${f.system}/Exports/Events`)}/`;
    const allFiles = typeof this.app.vault.getFiles === "function"
      ? this.app.vault.getFiles()
      : this.app.vault.getAllLoadedFiles().filter((item) => item && !item.children && item.name);

    const shardFiles = allFiles
      .filter((file) => file.path.startsWith(eventsPrefix) && /^events-.*\.jsonl$/i.test(file.name || ""))
      .sort((a, b) => a.path.localeCompare(b.path));

    const events = [];
    for (const file of shardFiles) {
      const content = await this.app.vault.cachedRead(file);
      for (const line of String(content || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") events.push(parsed);
        } catch {
          // Ignore partial/malformed trailing lines safely
        }
      }
    }
    return events;
  }

  getSettings() {
    return this.sidecar.settings;
  }

  getPrefs() {
    return this.sidecar.prefs;
  }

  normalizeFolder(p, fallback) {
    const clean = String(p || fallback || "").trim().replace(/^\/+|\/+$/g, "");
    return obsidian.normalizePath(clean || fallback);
  }

  getFolders() {
    const s = this.sidecar.settings;
    return {
      inbox: this.normalizeFolder(s.inboxFolder, "00_Inbox"),
      projects: this.normalizeFolder(s.projectsFolder, "10_Projects"),
      areas: this.normalizeFolder(s.areasFolder, "20_Areas"),
      resources: this.normalizeFolder(s.resourcesFolder, "30_Resources"),
      archives: this.normalizeFolder(s.archivesFolder, "40_Archives"),
      system: this.normalizeFolder(s.systemFolder, "90_System"),
    };
  }

  mergeSidecarData(rawDisk) {
    const d = rawDisk && typeof rawDisk === "object" ? rawDisk : {};
    // Disk was updated externally (e.g. synced from another device), so disk wins over stale in-memory keys
    const mergedSettings = {
      ...DEFAULT_SETTINGS,
      ...(this.sidecar.settings || {}),
      ...(d.settings && typeof d.settings === "object" ? d.settings : {}),
    };

    const diskPrefs = d.prefs && typeof d.prefs === "object" ? d.prefs : {};
    const localPrefs = this.sidecar.prefs || {};
    const mergedPrefs = { ...DEFAULT_PREFS, ...localPrefs, ...diskPrefs };
    if ((localPrefs.lastCheckinUpdatedAt || 0) > (diskPrefs.lastCheckinUpdatedAt || 0)) {
      mergedPrefs.lastCheckinDate = localPrefs.lastCheckinDate || "";
      mergedPrefs.lastCheckinUpdatedAt = localPrefs.lastCheckinUpdatedAt || 0;
    }

    const mergedTouched = {};
    const applyMap = (src) => {
      if (!src || typeof src !== "object") return;
      for (const [k, v] of Object.entries(src)) {
        if (!v || typeof v !== "object") continue;
        const ts = Number(v.touchedAt) || 0;
        const prev = mergedTouched[k];
        if (!prev || ts >= (prev.touchedAt || 0)) {
          mergedTouched[k] = { touchedAt: ts, lineHash: v.lineHash || prev?.lineHash || "" };
        }
      }
    };
    applyMap(d.touchedMap);
    applyMap(this.sidecar.touchedMap);

    // Prune stale touched entries older than 180 days only if map gets large
    const keys = Object.keys(mergedTouched);
    if (keys.length > 1500) {
      const cutoff = Date.now() - 180 * 86400000;
      for (const k of keys) {
        if ((mergedTouched[k].touchedAt || 0) < cutoff) delete mergedTouched[k];
      }
    }

    return { settings: mergedSettings, prefs: mergedPrefs, touchedMap: mergedTouched };
  }

  async loadSidecar() {
    const raw = (await this.plugin.loadData()) || {};
    this.sidecar = {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      prefs: { ...DEFAULT_PREFS, ...(raw.prefs || {}) },
      touchedMap: { ...(raw.touchedMap || {}) },
    };
  }

  async saveSidecar() {
    await this.plugin.saveData(this.sidecar);
  }

  async onExternalSettingsChange() {
    const raw = (await this.plugin.loadData()) || {};
    this.sidecar = this.mergeSidecarData(raw);
  }

  async updateSettings(patch) {
    this.sidecar.settings = { ...this.sidecar.settings, ...patch };
    await this.saveSidecar();
  }

  async updatePrefs(patch) {
    const next = { ...this.sidecar.prefs, ...patch };
    if (patch.lastCheckinDate !== undefined) {
      next.lastCheckinUpdatedAt = Date.now();
    }
    this.sidecar.prefs = next;
    await this.saveSidecar();
  }

  isVaultInitialized() {
    const f = this.getFolders();
    return Boolean(
      this.app.vault.getAbstractFileByPath(f.inbox) &&
        this.app.vault.getAbstractFileByPath(f.projects) &&
        this.app.vault.getAbstractFileByPath(f.areas)
    );
  }

  async ensureFolder(folderPath) {
    const norm = obsidian.normalizePath(folderPath);
    if (!norm) return;
    const parts = norm.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          // Ignore folder-already-exists races
        }
      }
    }
  }

  getAllExistingPathsLower() {
    const set = new Set();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f && f.path) set.add(f.path.toLowerCase());
    }
    return set;
  }

  getMarkdownFilesInFolder(folderPath) {
    const prefix = `${obsidian.normalizePath(folderPath)}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getFrontmatterForFile(file, content) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache && cache.frontmatter) return cache.frontmatter;
    return parseFrontmatterFallback(content);
  }

  resolveAreasFromFiles(areaFiles) {
    const seen = new Set();
    const discovered = [];
    for (const f of areaFiles) {
      const name = f.basename.trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        discovered.push(name);
      }
    }
    const ordered = [];
    for (const def of DEFAULT_AREAS) {
      const match = discovered.find((d) => d.toLowerCase() === def.toLowerCase());
      if (match) ordered.push(match);
    }
    for (const d of discovered) {
      if (!ordered.some((o) => o.toLowerCase() === d.toLowerCase())) {
        ordered.push(d);
      }
    }
    return ordered.length > 0 ? ordered : [...DEFAULT_AREAS];
  }

  async scanVault() {
    const f = this.getFolders();
    const vaultReady = this.isVaultInitialized();
    const inboxFiles = this.getMarkdownFilesInFolder(f.inbox);
    const projectFiles = this.getMarkdownFilesInFolder(f.projects);
    const areaFiles = this.getMarkdownFilesInFolder(f.areas);
    const archiveFiles = this.getMarkdownFilesInFolder(f.archives);

    const areas = this.resolveAreasFromFiles(areaFiles);
    const items = [];
    const inboxItems = [];
    const archivedItems = [];

    for (const file of inboxFiles) {
      const content = await this.app.vault.cachedRead(file);
      const fm = this.getFrontmatterForFile(file, content);
      inboxItems.push(...codec.parseInboxMarkdown(content, file.path, fm, file.stat?.mtime || Date.now()));
    }

    for (const file of projectFiles) {
      const content = await this.app.vault.cachedRead(file);
      const fm = this.getFrontmatterForFile(file, content);
      const proj = codec.parseProjectMarkdown(content, file.path, fm, file.stat?.mtime || Date.now());
      const sideProj = this.sidecar.touchedMap[proj.id];
      if (sideProj && sideProj.touchedAt) {
        proj.touchedAt = Math.max(proj.touchedAt || 0, sideProj.touchedAt);
      }
      items.push(proj);
    }

    for (const file of areaFiles) {
      const content = await this.app.vault.cachedRead(file);
      const defaultArea = file.basename.trim() || "Work";
      const parsed = codec.parseAreaTasksMarkdown(content, file.path, defaultArea, file.stat?.mtime || Date.now());
      for (const task of parsed) {
        const lineHash = logic.hashString32(task.rawLine).toString(36);
        const prevHash = this.lastLineHashes.get(task.id);
        const sideEntry = task.blockId ? this.sidecar.touchedMap[task.blockId] : null;

        if (prevHash && prevHash !== lineHash) {
          const bumped = Date.now();
          this.ephemeralTouched.set(task.id, bumped);
          if (sideEntry) {
            sideEntry.touchedAt = bumped;
            sideEntry.lineHash = lineHash;
          }
        }
        this.lastLineHashes.set(task.id, lineHash);

        if (sideEntry && sideEntry.touchedAt) {
          task.touchedAt = sideEntry.touchedAt;
        } else if (this.ephemeralTouched.has(task.id)) {
          task.touchedAt = this.ephemeralTouched.get(task.id);
        }
        items.push(task);
      }
    }

    for (const file of archiveFiles) {
      const content = await this.app.vault.cachedRead(file);
      if (/^completed tasks$/i.test(file.basename)) {
        archivedItems.push(...codec.parseAreaTasksMarkdown(content, file.path, "Work", file.stat?.mtime || Date.now()));
      } else {
        const fm = this.getFrontmatterForFile(file, content);
        archivedItems.push(codec.parseProjectMarkdown(content, file.path, fm, file.stat?.mtime || Date.now()));
      }
    }

    return { items, inboxItems, archivedItems, areas, vaultReady };
  }

  recordTouched(blockId, lineText) {
    if (!blockId) return;
    this.sidecar.touchedMap[blockId] = {
      touchedAt: Date.now(),
      lineHash: logic.hashString32(lineText || "").toString(36),
    };
  }

  findActiveEditorForPath(filePath) {
    const active = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (active && active.file && active.file.path === filePath && active.editor) {
      return active.editor;
    }
    return null;
  }

  resolveLineIndex(lines, expectedLineNumber, expectedRawLine, blockId) {
    if (
      typeof expectedLineNumber === "number" &&
      expectedLineNumber >= 0 &&
      expectedLineNumber < lines.length &&
      lines[expectedLineNumber] === expectedRawLine
    ) {
      return expectedLineNumber;
    }
    // Line may have shifted due to edits above; require exact raw text match so external edits are never clobbered
    const exactMatches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === expectedRawLine) exactMatches.push(i);
    }
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1 && blockId) {
      const suffix = `^${blockId}`;
      const byBlock = exactMatches.filter((idx) => lines[idx].trimEnd().endsWith(suffix));
      if (byBlock.length === 1) return byBlock[0];
    }
    throw new ExternalConflictError();
  }

  async mutateTaskBlock(filePath, expectedLineNumber, expectedRawLine, blockId, mutationSpec, todayKey) {
    const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
    if (!abstractFile) throw new ExternalConflictError("Target note no longer exists.");

    let outcome = null;
    const activeEditor = this.findActiveEditorForPath(filePath);

    const transformLines = (lines) => {
      const targetIdx = this.resolveLineIndex(lines, expectedLineNumber, expectedRawLine, blockId);
      const { endIndex, rawChildren } = codec.parseChildMetadataLines(lines, targetIdx);
      const res = codec.applyTaskWithChildrenPatch(lines, targetIdx, mutationSpec, todayKey);
      outcome = {
        targetIdx,
        endIndex,
        prevRawLine: lines[targetIdx],
        prevChildren: rawChildren,
        patchedParent: res.patchedParent,
        nextChildren: res.nextChildren,
        lines: res.lines,
      };
      return res.lines;
    };

    try {
      if (activeEditor) {
        const content = activeEditor.getValue();
        const lines = content.split(/\r?\n/);
        transformLines(lines);
        const replacement = [outcome.patchedParent, ...outcome.nextChildren].join("\n");
        const endLineIdx = outcome.endIndex;
        const endCh = lines[endLineIdx].length;
        activeEditor.replaceRange(replacement, { line: outcome.targetIdx, ch: 0 }, { line: endLineIdx, ch: endCh });
      } else {
        await this.app.vault.process(abstractFile, (content) => {
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          const lines = content.split(/\r?\n/);
          const updated = transformLines(lines);
          return updated.join(eol);
        });
      }
    } catch (err) {
      if (err instanceof ExternalConflictError) {
        new obsidian.Notice(err.message);
        if (this.onRefreshNeeded) this.onRefreshNeeded();
        return { aborted: true };
      }
      throw err;
    }

    const parsedNew = codec.parseTaskLine(outcome.patchedParent, outcome.targetIdx);
    const activeBlockId = parsedNew?.blockId || blockId;
    if (activeBlockId) {
      this.recordTouched(activeBlockId, outcome.patchedParent);
      await this.saveSidecar();
    }

    return {
      aborted: false,
      undoInfo: {
        kind: "line-block",
        filePath,
        lineNumber: outcome.targetIdx,
        expectedRawLine: outcome.patchedParent,
        expectedBlockId: activeBlockId,
        restoreRawLine: outcome.prevRawLine,
        restoreChildren: outcome.prevChildren,
      },
      ...outcome,
    };
  }

  async applyInverseLineUndo(undoInfo) {
    if (!undoInfo || undoInfo.kind !== "line-block") return { aborted: true };
    const abstractFile = this.app.vault.getAbstractFileByPath(undoInfo.filePath);
    if (!abstractFile) return { aborted: true };

    try {
      await this.app.vault.process(abstractFile, (content) => {
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const lines = content.split(/\r?\n/);
        const idx = this.resolveLineIndex(
          lines,
          undoInfo.lineNumber,
          undoInfo.expectedRawLine,
          undoInfo.expectedBlockId
        );
        const { endIndex } = codec.parseChildMetadataLines(lines, idx);
        const restored = [undoInfo.restoreRawLine, ...(undoInfo.restoreChildren || [])];
        return [...lines.slice(0, idx), ...restored, ...lines.slice(endIndex + 1)].join(eol);
      });
      return { aborted: false };
    } catch (err) {
      if (err instanceof ExternalConflictError) {
        new obsidian.Notice("File changed since that edit — could not safely undo.");
        if (this.onRefreshNeeded) this.onRefreshNeeded();
        return { aborted: true };
      }
      throw err;
    }
  }

  async mutateProjectFrontMatter(filePath, mutatorFn) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) throw new ExternalConflictError("Project file no longer exists.");
    await this.app.fileManager.processFrontMatter(file, mutatorFn);
  }

  async getOrCreateAreaFile(areaName) {
    const f = this.getFolders();
    await this.ensureFolder(f.areas);
    const clean = logic.cleanAreaName(areaName, "Work");
    const prefix = `${f.areas}/`;
    const existing = this.app.vault
      .getMarkdownFiles()
      .find((file) => file.path.startsWith(prefix) && file.basename.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;

    const targetPath = obsidian.normalizePath(`${f.areas}/${clean}.md`);
    const initial = [
      "---",
      "type: area",
      `area: ${clean}`,
      "---",
      "",
      `# ${clean}`,
      "",
      "## Next Actions",
      "",
    ].join("\n");
    return await this.app.vault.create(targetPath, initial);
  }

  async appendLinesToFile(file, newLines) {
    await this.app.vault.process(file, (content) => {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const trimmedEnd = content.replace(/\s+$/, "");
      const body = newLines.join(eol);
      return trimmedEnd ? `${trimmedEnd}${eol}${body}${eol}` : `${body}${eol}`;
    });
  }

  async createProjectFile({ title, area = "Work", dueDate = "", today = false, someday = false, waitingOn = "", initialSteps = [], notes = "", isSample = false }) {
    const f = this.getFolders();
    await this.ensureFolder(f.projects);
    const todayKey = logic.toDateKey(new Date());
    const fileName = codec.sanitizeVaultFileName(title, f.projects, this.getAllExistingPathsLower());
    const targetPath = obsidian.normalizePath(`${f.projects}/${fileName}`);
    const cleanArea = logic.cleanAreaName(area, "Work");
    const status = waitingOn ? "waiting" : someday ? "someday" : "active";

    const lines = [
      "---",
      "type: project",
      `status: ${status}`,
      `today: ${Boolean(today && status === "active")}`,
      `area: "[[${cleanArea}]]"`,
      `due: ${logic.normalizeDateValue(dueDate)}`,
      `created: ${todayKey}`,
      `snoozed_until: ""`,
      `waiting_on: ${escapeYamlQuoted(waitingOn)}`,
      `closed: ""`,
      ...(isSample ? ["sample: true"] : []),
      "---",
      "",
      `# ${title.trim()}`,
      "",
    ];

    if (notes && notes.trim()) {
      lines.push(notes.trim(), "");
    }

    lines.push("## Steps");
    if (initialSteps.length > 0) {
      for (const st of initialSteps) {
        const mark = st.done ? "x" : " ";
        const comp = st.done && st.completedDate ? ` ✅ ${st.completedDate}` : "";
        lines.push(`- [${mark}] ${st.title}${comp}`);
      }
    } else {
      lines.push(`- [ ] Define first physical next action #next ➕ ${todayKey}`);
    }
    lines.push("");

    return await this.app.vault.create(targetPath, lines.join("\n"));
  }

  buildTaskLineText({ title, dueDate = "", createdDate, today = false, waiting = false, someday = false, started = false, recurrence = "", isSample = false }) {
    const mark = started ? "/" : " ";
    const parts = [`- [${mark}] ${title.trim()}`];
    if (recurrence) parts.push(`🔁 ${recurrence}`);
    if (dueDate) parts.push(`📅 ${dueDate}`);
    if (createdDate) parts.push(`➕ ${createdDate}`);
    if (today && !waiting && !someday) parts.push("#today");
    if (waiting) parts.push("#waiting");
    if (someday) parts.push("#someday");
    if (isSample) parts.push("#sample");
    return parts.join(" ");
  }

  async captureNewItem({ mode = "task", title, area = "Work", dueDate = "", today = false, someday = false, waitingOn = "" }) {
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) return null;
    const now = new Date();
    const todayKey = logic.toDateKey(now);
    const f = this.getFolders();

    if (mode === "inbox") {
      await this.ensureFolder(f.inbox);
      if (this.sidecar.settings.inboxCaptureMode === "quick-inbox") {
        const qPath = obsidian.normalizePath(`${f.inbox}/Quick Inbox.md`);
        let qFile = this.app.vault.getAbstractFileByPath(qPath);
        if (!qFile) qFile = await this.app.vault.create(qPath, "# Quick Inbox\n\n");
        const line = `- [ ] ${cleanTitle} ➕ ${todayKey}`;
        await this.appendLinesToFile(qFile, [line]);
        await this.logBehaviorEvent({
          hashId: logic.computeAnonHashId(`inbox:${todayKey}:${cleanTitle.length}`),
          kind: "inbox",
          area,
          event: "capture",
          meta: { mode: "inbox" },
          now,
        });
        return qFile;
      }
      const stamp = `${todayKey.replace(/-/g, "")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const capName = codec.sanitizeVaultFileName(`Capture ${stamp}`, f.inbox, this.getAllExistingPathsLower());
      const capPath = obsidian.normalizePath(`${f.inbox}/${capName}`);
      const created = await this.app.vault.create(capPath, `${cleanTitle}\n`);
      await this.logBehaviorEvent({
        hashId: logic.computeAnonHashId(`inbox:${capName}:${todayKey}`),
        kind: "inbox",
        area,
        event: "capture",
        meta: { mode: "inbox" },
        now,
      });
      return created;
    }

    if (mode === "project") {
      const projFile = await this.createProjectFile({
        title: cleanTitle,
        area,
        dueDate,
        today,
        someday,
        waitingOn,
      });
      const projItem = { isProject: true, filePath: projFile.path, area, createdDate: todayKey };
      await this.logBehaviorEvent({ item: projItem, event: "capture", meta: { mode: "project" }, now });
      if (today && !someday && !waitingOn) {
        await this.logBehaviorEvent({ item: projItem, event: "today_pin", now });
      }
      return projFile;
    }

    const areaFile = await this.getOrCreateAreaFile(area);
    const blockId = codec.generateBlockId(cleanTitle);
    const taskLine =
      this.buildTaskLineText({
        title: cleanTitle,
        dueDate: logic.normalizeDateValue(dueDate),
        createdDate: todayKey,
        today,
        waiting: Boolean(waitingOn),
        someday,
      }) + ` ^${blockId}`;

    const lines = [taskLine];
    if (waitingOn && waitingOn.trim()) {
      lines.push(`\t- ◷ ${waitingOn.trim()}`);
    }
    await this.appendLinesToFile(areaFile, lines);
    this.recordTouched(blockId, taskLine);
    await this.updateSettings({ lastUsedArea: logic.cleanAreaName(area, "Work") });

    const taskItemRef = { isProject: false, id: `blk:${blockId}`, blockId, area, createdDate: todayKey };
    await this.logBehaviorEvent({ item: taskItemRef, event: "capture", meta: { mode: "task" }, now });
    if (today && !someday && !waitingOn) {
      await this.logBehaviorEvent({ item: taskItemRef, event: "today_pin", now });
    }
    return areaFile;
  }

  async runSafeVaultProcess(file, mutatorFn) {
    try {
      await this.app.vault.process(file, mutatorFn);
      return { aborted: false };
    } catch (err) {
      if (err instanceof ExternalConflictError) {
        new obsidian.Notice(err.message);
        if (this.onRefreshNeeded) this.onRefreshNeeded();
        return { aborted: true };
      }
      throw err;
    }
  }

  async verifySourceLineIntact(filePath, expectedLineNumber, expectedRawLine, blockId = null) {
    const srcFile = this.app.vault.getAbstractFileByPath(filePath);
    if (!srcFile) throw new ExternalConflictError("Source note was moved or deleted — view refreshed");
    const content = await this.app.vault.cachedRead(srcFile);
    const lines = content.split(/\r?\n/);
    this.resolveLineIndex(lines, expectedLineNumber, expectedRawLine, blockId);
    return srcFile;
  }

  async clarifyInboxItem(inboxItem, { action, area = "Work", dueDate = "", today = false }) {
    const f = this.getFolders();
    const todayKey = logic.toDateKey(new Date());
    const cleanArea = logic.cleanAreaName(area, "Work");

    // Pre-validate source before writing any destination so sync conflicts never create duplicates
    let srcFile;
    try {
      if (inboxItem.kind === "inbox-line") {
        srcFile = await this.verifySourceLineIntact(inboxItem.filePath, inboxItem.lineNumber, inboxItem.rawLine, null);
      } else {
        srcFile = this.app.vault.getAbstractFileByPath(inboxItem.filePath);
        if (!srcFile) throw new ExternalConflictError("Inbox note already processed — view refreshed");
      }
    } catch (err) {
      if (err instanceof ExternalConflictError) {
        new obsidian.Notice(err.message);
        if (this.onRefreshNeeded) this.onRefreshNeeded();
        return { aborted: true };
      }
      throw err;
    }

    const lagDays =
      inboxItem.createdDate && logic.parseDateKey(inboxItem.createdDate)
        ? Math.max(0, logic.daysBetweenKeys(inboxItem.createdDate, todayKey) ?? 0)
        : 0;
    let targetAnonItem = null;
    let targetHash = logic.computeAnonHashId(inboxItem.id || todayKey);

    if (action === "resource") {
      if (inboxItem.kind === "inbox-note") {
        await this.ensureFolder(f.resources);
        const destName = codec.sanitizeVaultFileName(inboxItem.title, f.resources, this.getAllExistingPathsLower());
        await this.app.fileManager.renameFile(srcFile, obsidian.normalizePath(`${f.resources}/${destName}`));
        await this.logBehaviorEvent({
          hashId: targetHash,
          kind: "inbox",
          area: cleanArea,
          event: "inbox_clarify",
          meta: { action: "resource", lagDays },
        });
        return { aborted: false };
      }
    } else if (action === "task" || action === "someday") {
      // Preserve multi-line capture note body in 30_Resources/ and link it rather than trashing details
      let linkedResourceName = "";
      if (inboxItem.kind === "inbox-note" && inboxItem.hasExtraBody) {
        await this.ensureFolder(f.resources);
        const destName = codec.sanitizeVaultFileName(inboxItem.title, f.resources, this.getAllExistingPathsLower());
        linkedResourceName = destName.replace(/\.md$/i, "");
        await this.app.fileManager.renameFile(srcFile, obsidian.normalizePath(`${f.resources}/${destName}`));
        srcFile = null;
      }

      const areaFile = await this.getOrCreateAreaFile(cleanArea);
      const blockId = codec.generateBlockId(inboxItem.title);
      const taskCreated = inboxItem.createdDate || todayKey;
      const taskTitle = linkedResourceName ? `${inboxItem.title} ([[${linkedResourceName}]])` : inboxItem.title;
      const taskLine =
        this.buildTaskLineText({
          title: taskTitle,
          dueDate: logic.normalizeDateValue(dueDate),
          createdDate: taskCreated,
          today: action === "task" && today,
          someday: action === "someday",
        }) + ` ^${blockId}`;
      await this.appendLinesToFile(areaFile, [taskLine]);
      this.recordTouched(blockId, taskLine);
      await this.updateSettings({ lastUsedArea: cleanArea });
      targetAnonItem = { isProject: false, id: `blk:${blockId}`, blockId, area: cleanArea, createdDate: taskCreated };
      targetHash = logic.getItemAnonHashId(targetAnonItem);
    } else if (action === "project") {
      const projFile = await this.createProjectFile({
        title: inboxItem.title,
        area: cleanArea,
        dueDate,
        today,
        notes: inboxItem.kind === "inbox-note" ? inboxItem.body : "",
      });
      await this.updateSettings({ lastUsedArea: cleanArea });
      targetAnonItem = { isProject: true, filePath: projFile.path, area: cleanArea, createdDate: todayKey };
      targetHash = logic.getItemAnonHashId(targetAnonItem);
    }

    if (srcFile) {
      if (inboxItem.kind === "inbox-note") {
        await this.app.vault.trash(srcFile, true);
      } else if (inboxItem.kind === "inbox-line") {
        const proc = await this.runSafeVaultProcess(srcFile, (content) => {
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          const lines = content.split(/\r?\n/);
          const idx = this.resolveLineIndex(lines, inboxItem.lineNumber, inboxItem.rawLine, null);
          return [...lines.slice(0, idx), ...lines.slice(idx + 1)].join(eol);
        });
        if (proc.aborted) return proc;
      }
    }

    await this.logBehaviorEvent({
      item: targetAnonItem,
      hashId: targetHash,
      kind: targetAnonItem ? (targetAnonItem.isProject ? "project" : "task") : "inbox",
      area: cleanArea,
      event: "inbox_clarify",
      meta: { action, lagDays },
    });
    if (targetAnonItem && today && (action === "task" || action === "project")) {
      await this.logBehaviorEvent({ item: targetAnonItem, event: "today_pin" });
    }
    return { aborted: false };
  }

  async toggleItemDone(item) {
    const now = new Date();
    const todayKey = logic.toDateKey(now);

    if (item.isProject) {
      const nextDone = item.status !== "done";
      await this.mutateProjectFrontMatter(item.filePath, (fm) => {
        fm.status = nextDone ? "done" : "active";
        fm.today = false;
        fm.closed = nextDone ? todayKey : "";
      });
      if (nextDone) {
        await this.logBehaviorEvent({ item, event: "done", meta: { wasToday: Boolean(item.isToday) }, now });
      }
      return { undoInfo: null, message: nextDone ? `Completed project "${item.title}"` : `Reopened "${item.title}"` };
    }

    const nextDone = item.status !== "done";

    // Delegate recurring completion to obsidian-tasks-plugin if installed
    if (nextDone && item.recurrence) {
      const tasksPlugin =
        this.app.plugins?.plugins?.["obsidian-tasks-plugin"] ||
        this.app.plugins?.getPlugin?.("obsidian-tasks-plugin");
      const tasksApi = tasksPlugin?.apiV1;

      if (tasksApi && typeof tasksApi.executeToggleTaskDoneCommand === "function") {
        const toggledText = tasksApi.executeToggleTaskDoneCommand(item.rawLine, item.filePath);
        const replacementLines = String(toggledText || "")
          .split(/\r?\n/)
          .filter((l) => l.length > 0);
        const file = this.app.vault.getAbstractFileByPath(item.filePath);
        if (file && replacementLines.length > 0) {
          const proc = await this.runSafeVaultProcess(file, (content) => {
            const eol = content.includes("\r\n") ? "\r\n" : "\n";
            const lines = content.split(/\r?\n/);
            const idx = this.resolveLineIndex(lines, item.lineNumber, item.rawLine, item.blockId);
            return [...lines.slice(0, idx), ...replacementLines, ...lines.slice(idx + 1)].join(eol);
          });
          if (proc.aborted) return { aborted: true, undoInfo: null, message: "" };
          await this.logBehaviorEvent({ item, event: "done", meta: { wasToday: Boolean(item.isToday) }, now });
          return { undoInfo: null, message: `Completed "${item.title}" (next scheduled by Tasks)` };
        }
      }

      // Built-in fallback for weekly/monthly/quarterly/yearly
      const nextDue = logic.computeSimpleNextDate(item.dueDate || todayKey, item.recurrence, now);
      const file = this.app.vault.getAbstractFileByPath(item.filePath);
      if (file) {
        const proc = await this.runSafeVaultProcess(file, (content) => {
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          const lines = content.split(/\r?\n/);
          const idx = this.resolveLineIndex(lines, item.lineNumber, item.rawLine, item.blockId);
          const completedLine = codec.patchTaskLine(
            lines[idx],
            { statusChar: "x", completedDate: todayKey, today: false, waiting: false },
            todayKey
          );

          const insertList = [];
          if (nextDue) {
            const alreadySpawned = lines.some((l) => {
              const parsed = codec.parseTaskLine(l, 0);
              return parsed && !parsed.done && !parsed.dropped && parsed.title === item.title && parsed.dueDate === nextDue;
            });
            if (!alreadySpawned) {
              const nextRaw = codec
                .patchTaskLine(
                  lines[idx],
                  {
                    statusChar: " ",
                    dueDate: nextDue,
                    createdDate: todayKey,
                    completedDate: "",
                    droppedDate: "",
                    snoozedUntil: "",
                    today: false,
                    waiting: false,
                  },
                  todayKey
                )
                .replace(/\s+\^[A-Za-z0-9-]+\s*$/, "");
              insertList.push(nextRaw);
            }
          }
          return [...lines.slice(0, idx), ...insertList, completedLine, ...lines.slice(idx + 1)].join(eol);
        });
        if (proc.aborted) return { aborted: true, undoInfo: null, message: "" };
        await this.logBehaviorEvent({ item, event: "done", meta: { wasToday: Boolean(item.isToday) }, now });
        return {
          undoInfo: null,
          message: nextDue
            ? `Completed "${item.title}" · Next due ${logic.formatShortDate(nextDue)}`
            : `Completed "${item.title}" (complex recurrence kept unchanged)`,
        };
      }
    }

    const linePatch = nextDone
      ? {
          statusChar: "x",
          completedDate: todayKey,
          droppedDate: "",
          today: false,
          waiting: false,
          ensureBlockId: item.blockId || codec.generateBlockId(item.title),
        }
      : {
          statusChar: " ",
          completedDate: "",
          droppedDate: "",
        };

    const res = await this.mutateTaskBlock(
      item.filePath,
      item.lineNumber,
      item.rawLine,
      item.blockId,
      { linePatch },
      todayKey
    );
    if (!res.aborted && nextDone) {
      const activeBlockId = res.undoInfo?.expectedBlockId || item.blockId;
      const loggedItem = activeBlockId ? { ...item, id: `blk:${activeBlockId}`, blockId: activeBlockId } : item;
      await this.logBehaviorEvent({ item: loggedItem, event: "done", meta: { wasToday: Boolean(item.isToday) }, now });
    }
    return {
      aborted: res.aborted,
      undoInfo: res.undoInfo || null,
      message: nextDone ? `Completed "${item.title}"` : `Reopened "${item.title}"`,
    };
  }

  async dropItem(item) {
    const now = new Date();
    const todayKey = logic.toDateKey(now);
    if (item.isProject) {
      await this.mutateProjectFrontMatter(item.filePath, (fm) => {
        fm.status = "dropped";
        fm.today = false;
        fm.closed = todayKey;
      });
      await this.logBehaviorEvent({ item, event: "dropped", now });
      return { undoInfo: null, message: `Dropped project "${item.title}"` };
    }

    const res = await this.mutateTaskBlock(
      item.filePath,
      item.lineNumber,
      item.rawLine,
      item.blockId,
      {
        linePatch: {
          statusChar: "-",
          droppedDate: todayKey,
          today: false,
          waiting: false,
          ensureBlockId: item.blockId || codec.generateBlockId(item.title),
        },
      },
      todayKey
    );
    if (!res.aborted) {
      const activeBlockId = res.undoInfo?.expectedBlockId || item.blockId;
      const loggedItem = activeBlockId ? { ...item, id: `blk:${activeBlockId}`, blockId: activeBlockId } : item;
      await this.logBehaviorEvent({ item: loggedItem, event: "dropped", now });
    }
    return { aborted: res.aborted, undoInfo: res.undoInfo || null, message: `Dropped "${item.title}"` };
  }

  async recordMetaEvents(loggedItem, prevItem, patch, now) {
    const todayKey = logic.toDateKey(now);
    if (patch.today === true && !prevItem.isToday) {
      await this.logBehaviorEvent({ item: loggedItem, event: "today_pin", now });
    } else if (patch.today === false && prevItem.isToday) {
      await this.logBehaviorEvent({ item: loggedItem, event: "today_bump", now });
    }
    if (patch.stage === "started" && prevItem.stage !== "started") {
      await this.logBehaviorEvent({ item: loggedItem, event: "started", now });
    } else if (patch.stage === "waiting" && prevItem.stage !== "waiting") {
      await this.logBehaviorEvent({ item: loggedItem, event: "waiting", now });
    }
    if (patch.snoozedUntil) {
      const snzDays = logic.daysBetweenKeys(todayKey, logic.normalizeDateValue(patch.snoozedUntil));
      if (snzDays !== null && snzDays >= 0) {
        await this.logBehaviorEvent({ item: loggedItem, event: "snooze_2w", meta: { deltaDays: snzDays }, now });
      }
    }
    if (patch.touch && logic.getItemFreshness(prevItem, now).isFading) {
      await this.logBehaviorEvent({ item: loggedItem, event: "keep_stale", now });
    }
    if (patch.dueDate !== undefined && prevItem.dueDate) {
      const nextDue = logic.normalizeDateValue(patch.dueDate);
      if (nextDue) {
        const deltaDays = logic.daysBetweenKeys(prevItem.dueDate, nextDue);
        if (deltaDays !== null && deltaDays > 0) {
          await this.logBehaviorEvent({ item: loggedItem, event: "due_push", meta: { deltaDays }, now });
        }
      }
    }
  }

  async updateItemMeta(item, patch) {
    const now = new Date();
    const todayKey = logic.toDateKey(now);

    if (item.isProject) {
      await this.mutateProjectFrontMatter(item.filePath, (fm) => {
        if (patch.dueDate !== undefined) fm.due = logic.normalizeDateValue(patch.dueDate);
        if (patch.snoozedUntil !== undefined) fm.snoozed_until = logic.normalizeDateValue(patch.snoozedUntil);
        if (patch.today !== undefined) fm.today = Boolean(patch.today);
        if (patch.someday !== undefined) {
          fm.status = patch.someday ? "someday" : "active";
          if (patch.someday) fm.today = false;
        }
        if (patch.waitingOn !== undefined) {
          const cleanW = String(patch.waitingOn || "").trim();
          fm.waiting_on = cleanW;
          if (cleanW) {
            fm.status = "waiting";
            fm.today = false;
          } else if (fm.status === "waiting") {
            fm.status = "active";
          }
        }
        if (patch.stage === "todo" && fm.status === "waiting") {
          fm.status = "active";
          fm.waiting_on = "";
        }
        if (patch.area !== undefined) {
          fm.area = `[[${logic.cleanAreaName(patch.area, "Work")}]]`;
        }
        if (patch.title !== undefined && patch.title.trim()) {
          fm.title = patch.title.trim();
        }
      });

      if (
        patch.stage === "started" &&
        patch.nextStep &&
        patch.nextStep.trim() &&
        patch.nextStep.trim() !== item.nextStep
      ) {
        await this.addProjectStep(item, `${patch.nextStep.trim()} #next`, true);
      }
      if (patch.touch) {
        this.recordTouched(item.id, item.filePath);
        await this.saveSidecar();
      }
      await this.recordMetaEvents(item, item, patch, now);
      return { undoInfo: null };
    }

    const linePatch = {};
    if (patch.dueDate !== undefined) linePatch.dueDate = patch.dueDate;
    if (patch.snoozedUntil !== undefined) linePatch.snoozedUntil = patch.snoozedUntil;
    if (patch.today !== undefined) linePatch.today = Boolean(patch.today);
    if (patch.someday !== undefined) {
      linePatch.someday = Boolean(patch.someday);
      if (patch.someday) linePatch.today = false;
    }
    if (patch.title !== undefined) linePatch.title = patch.title;
    if (patch.recurrence !== undefined) linePatch.recurrence = patch.recurrence;

    if (patch.stage === "started") {
      linePatch.statusChar = "/";
      linePatch.waiting = false;
    } else if (patch.stage === "waiting") {
      linePatch.statusChar = " ";
      linePatch.waiting = true;
      linePatch.today = false;
    } else if (patch.stage === "todo") {
      linePatch.statusChar = " ";
      linePatch.waiting = false;
    }

    linePatch.ensureBlockId = item.blockId || codec.generateBlockId(item.title);

    const mutationSpec = { linePatch };
    if (patch.nextStep !== undefined) mutationSpec.nextStep = patch.nextStep;
    if (patch.waitingOn !== undefined) mutationSpec.waitingOn = patch.waitingOn;
    if (patch.stage === "todo") {
      mutationSpec.waitingOn = "";
    }

    const res = await this.mutateTaskBlock(
      item.filePath,
      item.lineNumber,
      item.rawLine,
      item.blockId,
      mutationSpec,
      todayKey
    );

    const activeBlockId = res.undoInfo?.expectedBlockId || item.blockId;
    if (!res.aborted && patch.touch && activeBlockId) {
      this.recordTouched(activeBlockId, res.patchedParent);
      await this.saveSidecar();
    }
    if (!res.aborted) {
      const loggedItem = activeBlockId ? { ...item, id: `blk:${activeBlockId}`, blockId: activeBlockId } : item;
      await this.recordMetaEvents(loggedItem, item, patch, now);
    }

    return { aborted: res.aborted, undoInfo: res.undoInfo || null };
  }

  async toggleProjectStep(projectItem, step) {
    const now = new Date();
    const todayKey = logic.toDateKey(now);
    const nextDone = !step.done;
    const res = await this.mutateTaskBlock(
      projectItem.filePath,
      step.lineNumber,
      step.rawLine,
      step.blockId,
      {
        linePatch: {
          statusChar: nextDone ? "x" : " ",
          completedDate: nextDone ? todayKey : "",
        },
      },
      todayKey
    );
    if (!res.aborted && nextDone) {
      await this.logBehaviorEvent({ item: projectItem, event: "step_done", now });
    }
    return res;
  }

  async addProjectStep(projectItem, stepTitle, started = false) {
    const clean = String(stepTitle || "").trim();
    if (!clean) return;
    const todayKey = logic.toDateKey(new Date());
    const file = this.app.vault.getAbstractFileByPath(projectItem.filePath);
    if (!file) return;
    const mark = started ? "/" : " ";
    const newLine = `- [${mark}] ${clean} ➕ ${todayKey}`;

    await this.app.vault.process(file, (content) => {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      let lastTaskIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (codec.TASK_LINE_RE.test(lines[i])) lastTaskIdx = i;
      }
      if (lastTaskIdx !== -1) {
        return [...lines.slice(0, lastTaskIdx + 1), newLine, ...lines.slice(lastTaskIdx + 1)].join(eol);
      }
      const trimmed = content.replace(/\s+$/, "");
      return `${trimmed}${eol}${newLine}${eol}`;
    });
  }

  async removeProjectStep(projectItem, step) {
    const file = this.app.vault.getAbstractFileByPath(projectItem.filePath);
    if (!file) return { aborted: true };
    return await this.runSafeVaultProcess(file, (content) => {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const idx = this.resolveLineIndex(lines, step.lineNumber, step.rawLine, step.blockId);
      return [...lines.slice(0, idx), ...lines.slice(idx + 1)].join(eol);
    });
  }

  async promoteTaskToProject(taskItem) {
    if (!taskItem || taskItem.isProject) return null;

    // Validate source line BEFORE creating the project file to avoid duplicates on sync race
    let srcFile;
    try {
      srcFile = await this.verifySourceLineIntact(
        taskItem.filePath,
        taskItem.lineNumber,
        taskItem.rawLine,
        taskItem.blockId
      );
    } catch (err) {
      if (err instanceof ExternalConflictError) {
        new obsidian.Notice(err.message);
        if (this.onRefreshNeeded) this.onRefreshNeeded();
        return null;
      }
      throw err;
    }

    const initialSteps = [];
    if (taskItem.nextStep) {
      initialSteps.push({ title: `${taskItem.nextStep} #next`, done: false });
    }
    const projFile = await this.createProjectFile({
      title: taskItem.title,
      area: taskItem.area,
      dueDate: taskItem.dueDate,
      today: taskItem.isToday,
      someday: taskItem.isSomeday,
      waitingOn: taskItem.waitingOn,
      initialSteps,
    });

    const proc = await this.runSafeVaultProcess(srcFile, (content) => {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const idx = this.resolveLineIndex(lines, taskItem.lineNumber, taskItem.rawLine, taskItem.blockId);
      const { endIndex } = codec.parseChildMetadataLines(lines, idx);
      return [...lines.slice(0, idx), ...lines.slice(endIndex + 1)].join(eol);
    });
    if (proc.aborted) {
      await this.app.vault.trash(projFile, true);
      return null;
    }
    await this.logBehaviorEvent({ item: taskItem, event: "promote_project" });
    return projFile;
  }

  async archiveCompletedItems() {
    const f = this.getFolders();
    const todayKey = logic.toDateKey(new Date());
    await this.ensureFolder(f.archives);

    let archivedProjects = 0;
    let archivedTasks = 0;

    // 1. Move completed/dropped project notes to 40_Archives/
    const projectFiles = this.getMarkdownFilesInFolder(f.projects);
    for (const file of projectFiles) {
      const content = await this.app.vault.cachedRead(file);
      const fm = this.getFrontmatterForFile(file, content);
      const st = typeof fm.status === "string" ? fm.status.trim().toLowerCase() : "";
      if (st === "done" || st === "dropped") {
        const destName = codec.sanitizeVaultFileName(file.basename, f.archives, this.getAllExistingPathsLower());
        const destPath = obsidian.normalizePath(`${f.archives}/${destName}`);
        await this.app.fileManager.renameFile(file, destPath);
        archivedProjects += 1;
      }
    }

    // 2. Gather lines via cachedRead, append to 40_Archives/Completed Tasks.md FIRST,
    //    and only THEN remove verified blocks from 20_Areas/*.md so failures never lose data.
    const perFileBlocks = [];
    const archiveLinesToAppend = [];
    const areaFiles = this.getMarkdownFilesInFolder(f.areas);

    for (const file of areaFiles) {
      const defaultArea = logic.cleanAreaName(file.basename, "Work");
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split(/\r?\n/);
      const fmEnd = codec.getFrontmatterEndIndex(lines);
      const blocks = [];
      let skipUntil = -1;

      for (let i = fmEnd + 1; i < lines.length; i++) {
        if (i <= skipUntil) continue;
        const parsed = codec.parseTaskLine(lines[i], i);
        const indentCheck = /^(?:\s*>\s*)*(\s*)/.exec(lines[i]);
        const isTopLevel = parsed && (!indentCheck || indentCheck[1].length === 0);
        if (isTopLevel && (parsed.done || parsed.dropped)) {
          const { endIndex, rawChildren } = codec.parseChildMetadataLines(lines, i);
          const areaTag = parsed.inlineArea || defaultArea;
          const annotated = codec.patchTaskLine(
            lines[i],
            {
              areaAnnotation: areaTag,
              ...(parsed.done && !parsed.completedDate ? { completedDate: todayKey } : {}),
              ...(parsed.dropped && !parsed.droppedDate ? { droppedDate: todayKey } : {}),
            },
            todayKey
          );
          archiveLinesToAppend.push(annotated, ...rawChildren);
          blocks.push({ lineNumber: i, rawLine: lines[i], blockId: parsed.blockId });
          skipUntil = endIndex;
        }
      }
      if (blocks.length > 0) perFileBlocks.push({ file, blocks });
    }

    if (archiveLinesToAppend.length > 0) {
      const archivePath = obsidian.normalizePath(`${f.archives}/Completed Tasks.md`);
      let archiveFile = this.app.vault.getAbstractFileByPath(archivePath);
      if (!archiveFile) {
        archiveFile = await this.app.vault.create(archivePath, "# Completed Tasks Archive\n\n");
      }
      await this.app.vault.process(archiveFile, (content) => {
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const trimmed = content.replace(/\s+$/, "");
        const header = `## Archived ${todayKey}`;
        const chunk = [header, ...archiveLinesToAppend].join(eol);
        return trimmed ? `${trimmed}${eol}${eol}${chunk}${eol}` : `${chunk}${eol}`;
      });

      for (const { file, blocks } of perFileBlocks) {
        await this.app.vault.process(file, (content) => {
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          let curLines = content.split(/\r?\n/);
          let removedAny = false;
          for (const blk of blocks) {
            try {
              const idx = this.resolveLineIndex(curLines, blk.lineNumber, blk.rawLine, blk.blockId);
              const { endIndex } = codec.parseChildMetadataLines(curLines, idx);
              curLines = [...curLines.slice(0, idx), ...curLines.slice(endIndex + 1)];
              archivedTasks += 1;
              removedAny = true;
            } catch {
              // Line changed concurrently; keep rather than risk losing edits
            }
          }
          return removedAny ? curLines.join(eol) : content;
        });
      }
    }

    return { archivedProjects, archivedTasks };
  }

  async clearSampleItems() {
    const f = this.getFolders();
    let cleared = 0;

    for (const file of [...this.getMarkdownFilesInFolder(f.inbox), ...this.getMarkdownFilesInFolder(f.projects)]) {
      const content = await this.app.vault.cachedRead(file);
      const fm = this.getFrontmatterForFile(file, content);
      if (fm && fm.sample === true) {
        await this.app.vault.trash(file, true);
        cleared += 1;
      }
    }

    for (const file of this.getMarkdownFilesInFolder(f.areas)) {
      await this.app.vault.process(file, (content) => {
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const lines = content.split(/\r?\n/);
        const kept = [];
        let skipUntil = -1;
        let removedInFile = 0;
        for (let i = 0; i < lines.length; i++) {
          if (i <= skipUntil) continue;
          const parsed = codec.parseTaskLine(lines[i], i);
          if (parsed && parsed.isSample) {
            const { endIndex } = codec.parseChildMetadataLines(lines, i);
            skipUntil = endIndex;
            cleared += 1;
            removedInFile += 1;
            continue;
          }
          kept.push(lines[i]);
        }
        return removedInFile === 0 ? content : kept.join(eol);
      });
    }
    return cleared;
  }

  async scaffoldParaVault({ includeSamples = false } = {}) {
    const f = this.getFolders();
    const todayKey = logic.toDateKey(new Date());
    let createdFiles = 0;

    for (const folder of [f.inbox, f.projects, f.areas, f.resources, f.archives, f.system, `${f.system}/Templates`]) {
      await this.ensureFolder(folder);
    }

    const createIfMissing = async (relPath, body) => {
      const fullPath = obsidian.normalizePath(relPath);
      if (!this.app.vault.getAbstractFileByPath(fullPath)) {
        await this.app.vault.create(fullPath, body);
        createdFiles += 1;
      }
    };

    for (const areaName of DEFAULT_AREAS) {
      await createIfMissing(
        `${f.areas}/${areaName}.md`,
        `---\ntype: area\narea: ${areaName}\n---\n\n# ${areaName}\n\n## Next Actions\n\n`
      );
    }

    await createIfMissing(`${f.inbox}/Quick Inbox.md`, "# Quick Inbox\n\n");
    await createIfMissing(`${f.archives}/Completed Tasks.md`, "# Completed Tasks Archive\n\n");

    await createIfMissing(
      `${f.system}/Templates/Project Template.md`,
      [
        "---",
        "type: project",
        "status: active",
        "today: false",
        'area: "[[Work]]"',
        "due: ",
        "created: {{date:YYYY-MM-DD}}",
        'snoozed_until: ""',
        'waiting_on: ""',
        'closed: ""',
        "---",
        "",
        "# {{title}}",
        "",
        "## Outcome & Notes",
        "",
        "## Steps",
        "- [ ] First physical next action #next ➕ {{date:YYYY-MM-DD}}",
        "",
      ].join("\n")
    );

    await createIfMissing(
      `${f.system}/GTD Dashboard.md`,
      [
        "# GTD + PARA Overview",
        "",
        "Open **Horizon LifeOS** from the left ribbon (or `Ctrl/Cmd+P` -> `Open Horizon Desk`) for the visual timeline, Today-3 cap, Fading Ink, and Inbox triage.",
        "",
        "## Active Folders",
        `- \`${f.inbox}/\` — Unprocessed thoughts & iPhone voice captures`,
        `- \`${f.projects}/\` — Multi-step outcomes with a finish line`,
        `- \`${f.areas}/\` — Ongoing responsibilities (${DEFAULT_AREAS.join(", ")})`,
        `- \`${f.resources}/\` — Reference notes only`,
        `- \`${f.archives}/\` — Completed projects & append-only task archive`,
        "",
      ].join("\n")
    );

    if (includeSamples) {
      const d2 = logic.addDaysKey(todayKey, 2);
      const d11 = logic.addDaysKey(todayKey, 11);
      const d34 = logic.addDaysKey(todayKey, 34);
      const dOld = logic.addDaysKey(todayKey, -16);
      await createIfMissing(
        `${f.projects}/Finalize Q1 Vendor Proposal.md`,
        [
          "---",
          "type: project",
          "status: active",
          "today: true",
          'area: "[[Work]]"',
          `due: ${d2}`,
          `created: ${todayKey}`,
          'snoozed_until: ""',
          'waiting_on: ""',
          'closed: ""',
          "sample: true",
          "---",
          "",
          "# Finalize Q1 Vendor Proposal",
          "",
          "## Steps",
          `- [x] Collect vendor quotes ✅ ${todayKey}`,
          `- [/] Verify pricing table on slide 4 #next ➕ ${todayKey}`,
          `- [ ] Send draft for review ➕ ${todayKey}`,
          "",
        ].join("\n")
      );

      const workFile = await this.getOrCreateAreaFile("Work");
      await this.appendLinesToFile(workFile, [
        `- [ ] Legal sign-off on contract renewal 📅 ${d11} ➕ ${todayKey} #waiting #sample ^hz-smp1`,
        `\t- ◷ Ana (Legal)`,
        `- [ ] Clean up project bookmarks ➕ ${dOld} #sample ^hz-smp2`,
      ]);
      const personalFile = await this.getOrCreateAreaFile("Personal");
      await this.appendLinesToFile(personalFile, [
        `- [ ] Renew car insurance #home 🔁 every year 📅 ${d34} ➕ ${todayKey} #sample ^hz-smp3`,
      ]);
    }

    return { createdFiles };
  }

  importStandaloneHorizonJson(rawJsonText, { dryRun = true } = {}) {
    const raw = JSON.parse(String(rawJsonText || ""));
    const rawList = Array.isArray(raw) ? raw : raw && Array.isArray(raw.tasks) ? raw.tasks : null;
    if (!rawList) throw new Error("Expected a Horizon tasks.json array or schema-2 object.");

    const activeRaw = rawList.filter((t) => t && typeof t === "object" && !t.deleted && t.title);
    const projectsToCreate = [];
    const tasksToAppend = [];
    const archivedToAppend = [];

    for (const t of activeRaw) {
      const area = t.area === "personal" ? "Personal" : "Work";
      const createdDate = t.createdAt ? logic.toDateKey(new Date(t.createdAt)) : logic.toDateKey(new Date());
      const dueDate = logic.normalizeDateValue(t.dueDate);
      const snoozedUntil = logic.normalizeDateValue(t.snoozedUntil);
      const completedDate = logic.normalizeDateValue(t.completedAt);
      const isDone = t.list === "done" || t.status === "done";
      const hasSubs = Array.isArray(t.subtasks) && t.subtasks.length > 0;
      const hasNotes = typeof t.notes === "string" && t.notes.trim().length > 0;

      if (hasSubs || hasNotes) {
        projectsToCreate.push({
          title: t.title.trim(),
          area,
          dueDate,
          today: t.list === "today" && !isDone,
          waitingOn: !isDone && t.stage === "waiting" ? t.waitingOn || "Pending" : "",
          status: isDone ? "done" : t.stage === "waiting" ? "waiting" : "active",
          completedDate,
          snoozedUntil,
          createdDate,
          notes: t.notes || "",
          initialSteps: (t.subtasks || []).map((s) => ({
            title: s.title || s.text || "Step",
            done: Boolean(s.done),
            completedDate: s.completedAt || (s.done ? completedDate || createdDate : ""),
          })),
        });
      } else {
        const recRule = logic.formatSimpleRecurrenceRule(t.recurrence);
        const recStr = recRule || t.recurrence || "";
        const line =
          `- [${isDone ? "x" : t.stage === "started" ? "/" : " "}] ${t.title.trim()}` +
          (recStr ? ` 🔁 ${recStr}` : "") +
          (snoozedUntil ? ` 🛫 ${snoozedUntil}` : "") +
          (dueDate ? ` 📅 ${dueDate}` : "") +
          ` ➕ ${createdDate}` +
          (isDone && completedDate ? ` ✅ ${completedDate}` : "") +
          (!isDone && t.list === "today" && t.stage !== "waiting" ? " #today" : "") +
          (!isDone && t.stage === "waiting" ? " #waiting" : "");
        const blockId = codec.generateBlockId(t.id || t.title);
        const target = isDone ? archivedToAppend : tasksToAppend;
        target.push({
          area,
          line: `${line} ^${blockId}`,
          nextStep: !isDone ? t.nextStep || "" : "",
          waitingOn: !isDone ? t.waitingOn || "" : "",
          blockId,
          touchedAt: Number(t.touchedAt) || Number(t.createdAt) || Date.now(),
        });
      }
    }

    if (dryRun) {
      return {
        dryRun: true,
        projectsCount: projectsToCreate.length,
        tasksCount: tasksToAppend.length,
        archivedCount: archivedToAppend.length,
      };
    }

    return (async () => {
      const f = this.getFolders();
      await this.ensureFolder(f.projects);
      await this.ensureFolder(f.areas);
      await this.ensureFolder(f.archives);

      for (const p of projectsToCreate) {
        const targetFolder = p.status === "done" ? f.archives : f.projects;
        const fileName = codec.sanitizeVaultFileName(p.title, targetFolder, this.getAllExistingPathsLower());
        const filePath = obsidian.normalizePath(`${targetFolder}/${fileName}`);
        const lines = [
          "---",
          "type: project",
          `status: ${p.status}`,
          `today: ${Boolean(p.today)}`,
          `area: "[[${p.area}]]"`,
          `due: ${p.dueDate}`,
          `created: ${p.createdDate}`,
          `snoozed_until: ${escapeYamlQuoted(p.snoozedUntil)}`,
          `waiting_on: ${escapeYamlQuoted(p.waitingOn)}`,
          `closed: ${escapeYamlQuoted(p.completedDate)}`,
          "---",
          "",
          `# ${p.title}`,
          "",
          ...(p.notes ? [p.notes.trim(), ""] : []),
          "## Steps",
          ...p.initialSteps.map((s) => `- [${s.done ? "x" : " "}] ${s.title}${s.done && s.completedDate ? ` ✅ ${s.completedDate}` : ""}`),
          "",
        ];
        await this.app.vault.create(filePath, lines.join("\n"));
      }

      const byArea = new Map();
      for (const item of tasksToAppend) {
        if (!byArea.has(item.area)) byArea.set(item.area, []);
        byArea.get(item.area).push(item.line);
        if (item.waitingOn) byArea.get(item.area).push(`\t- ◷ ${item.waitingOn}`);
        if (item.nextStep) byArea.get(item.area).push(`\t- ◐ ${item.nextStep}`);
        this.sidecar.touchedMap[item.blockId] = {
          touchedAt: item.touchedAt,
          lineHash: logic.hashString32(item.line).toString(36),
        };
      }
      for (const [area, lines] of byArea.entries()) {
        const areaFile = await this.getOrCreateAreaFile(area);
        await this.appendLinesToFile(areaFile, lines);
      }

      if (archivedToAppend.length > 0) {
        const archPath = obsidian.normalizePath(`${f.archives}/Completed Tasks.md`);
        let archFile = this.app.vault.getAbstractFileByPath(archPath);
        if (!archFile) archFile = await this.app.vault.create(archPath, "# Completed Tasks Archive\n\n");
        await this.appendLinesToFile(
          archFile,
          archivedToAppend.map((a) => `${a.line} [Area:: ${a.area}]`)
        );
      }

      await this.saveSidecar();
      return {
        dryRun: false,
        projectsCount: projectsToCreate.length,
        tasksCount: tasksToAppend.length,
        archivedCount: archivedToAppend.length,
      };
    })();
  }

  async exportAnonymizedAudit() {
    const f = this.getFolders();
    const exportsDir = obsidian.normalizePath(`${f.system}/Exports`);
    await this.ensureFolder(exportsDir);

    const { items, archivedItems } = await this.scanVault();
    const behaviorEvents = await this.readAllBehaviorEvents();
    const now = new Date();
    const todayKey = logic.toDateKey(now);
    const audit = logic.buildAnonymizedAudit(items, archivedItems, now, behaviorEvents);

    const base = `Anonymized-Audit-${todayKey}`;
    const mdPath = obsidian.normalizePath(`${exportsDir}/${base}.md`);
    const jsonPath = obsidian.normalizePath(`${exportsDir}/${base}.json`);
    const csvPath = obsidian.normalizePath(`${exportsDir}/${base}.csv`);

    const upsert = async (path, text) => {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) await this.app.vault.modify(existing, text);
      else await this.app.vault.create(path, text);
    };

    const safeJson = JSON.stringify(
      {
        generatedAt: audit.generatedAt,
        summary: audit.summary,
        behavior: audit.behavior,
        records: audit.records,
      },
      null,
      2
    );

    await upsert(mdPath, audit.markdown);
    await upsert(jsonPath, `${safeJson}\n`);
    await upsert(csvPath, audit.csv);

    return { mdPath, jsonPath, csvPath, summary: audit.summary };
  }

  async openNote(filePath, lineNumber = null) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, lineNumber !== null ? { eState: { line: lineNumber } } : undefined);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_PREFS,
  DEFAULT_AREAS,
  ExternalConflictError,
  VaultAdapter,
};
