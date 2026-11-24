/**
 * app.js — Horizon UI Controller & Storage Adapter
 *
 * Compact, single-pipeline architecture:
 *   All task rules live in logic.js. Both server mode (Home PC Python server)
 *   and portable mode (Work laptop single HTML + OneDrive file handle) execute
 *   the exact same transitions and persist a schema-2 document envelope through
 *   a single serialized syncQueue (preventing overlapping writes & stale races).
 *
 * Sections:
 *   1. State, Helpers & Device Identity
 *   2. IndexedDB File-Handle Persistence (file:// safe)
 *   3. Serialized Sync & Storage Layer (Server ETag + Portable File + Backups)
 *   4. Task Mutations, Today Cap (3), & Targeted Undo
 *   5. Rendering (Header, Horizon Timeline, Today, Later + Waiting, Done)
 *   6. Import / Export (Merge by Default)
 *   7. Lifecycle, Midnight Refresh & Event Wiring
 */

const STORAGE_KEY = "horizon_tasks_v2";
const LEGACY_STORAGE_KEY = "horizon_tasks_v1";
const BACKUP_KEY = "horizon_backups_v2";
const PREFS_KEY = "horizon_ui_prefs_v1";
const SAMPLE_FLAG_KEY = "horizon_samples_dismissed_v1";
const DEVICE_ID_KEY = "horizon_device_id_v1";
const IDB_NAME = "horizon_file_handles_v1";
const IDB_STORE = "handles";
const IDB_KEY = "linked_tasks_file";

// ============================================================================
// 1. State, Helpers & Device Identity
// ============================================================================

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const uiPrefs = loadPrefs();
function savePrefs(patch) {
  Object.assign(uiPrefs, patch);
  safeLocalSet(PREFS_KEY, JSON.stringify(uiPrefs));
}

let tasks = [];
let laterFilter = ["all", "dated", "flexible"].includes(uiPrefs.laterFilter) ? uiPrefs.laterFilter : "all";
let waitingExpanded = Boolean(uiPrefs.waitingExpanded);
let showAllDone = false;
let captureArea = uiPrefs.captureArea === "personal" ? "personal" : "work";
let searchQuery = "";
let checkinMode = "auto"; // "auto" | "cards" | "hidden"
let checkinCards = [];
let checkinIndex = 0;
let inspectedTaskId = null;
let expandedTaskId = null;
let editingNotesId = null;
let editingTitleId = null;
let editingStage = null; // { id, mode: "started"|"waiting", prompt?: string, draft?: string }
let pendingFocusTarget = null; // { taskId, key } — focuses one exact control after render
const notesDrafts = new Map(); // taskId -> unsaved note text (survives tab sync / redraws)
const stepDrafts = new Map(); // taskId -> unsaved new-step text
let pendingSwap = null; // { kind: "move", taskId } | { kind: "add", title, dueDate, area }
let undoEntry = null; // { delta: Map<id, prevTask|null>, timerId }
let lastRenderedDateKey = toDateKey(new Date());

// Server mode state
const useServerApi =
  window.location.protocol.startsWith("http") &&
  (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
let hasLoadedServer = false;
let serverEtag = null;
let serverFileName = "tasks.json";
const serverToken = document.querySelector('meta[name="horizon-token"]')?.getAttribute("content") || "";

// Portable mode state
let linkedFileHandle = null;
let reconnectHandle = null;
let lastDiskStamp = null;
let lastSyncTime = "";
let syncState = "local"; // "synced" | "local" | "error"
let syncErrorMsg = "";
let syncQueue = Promise.resolve();

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `dev-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "dev-session";
  }
}

const DEVICE_ID = getDeviceId();
const activeTasks = () => tasks.filter((t) => !t.deleted);
const nowHHMM = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const cloneTask = (t) => (t ? { ...t, subtasks: (t.subtasks || []).map((s) => ({ ...s })) } : null);

function makeButton(label, className, onClick, attrs = {}) {
  const b = document.createElement("button");
  b.type = "button";
  if (className) b.className = className;
  b.textContent = label;
  Object.entries(attrs).forEach(([k, v]) => {
    if (v !== undefined && v !== null) b.setAttribute(k, String(v));
  });
  b.addEventListener("click", onClick);
  return b;
}

function enqueueSync(fn) {
  syncQueue = syncQueue.then(fn, fn);
  return syncQueue;
}

// ============================================================================
// 2. IndexedDB File-Handle Persistence (graceful fallback on file://)
// ============================================================================

function openHandleDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function saveStoredHandle(handle) {
  try {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Opaque file:// origins or enterprise policies may block IndexedDB; safe to skip
  }
}

async function loadStoredHandle() {
  try {
    const db = await openHandleDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

// ============================================================================
// 3. Serialized Sync & Storage Layer
// ============================================================================

function supportsDirectFileAccess() {
  return (
    typeof window.showOpenFilePicker === "function" &&
    typeof window.showSaveFilePicker === "function"
  );
}

function safeLocalSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage quota or opaque file:// restriction
  }
}

function saveLocalCache(doc) {
  safeLocalSet(STORAGE_KEY, JSON.stringify(doc));
  try {
    const existing = JSON.parse(localStorage.getItem(BACKUP_KEY) || "[]");
    const list = Array.isArray(existing) ? existing : [];
    list.unshift({ savedAt: doc.savedAt, doc });
    localStorage.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, 3)));
  } catch {
    // Best-effort rolling local backup
  }
}

function updateStorageIndicator() {
  const pill = document.getElementById("storage-tag");
  const reconnectBtn = document.getElementById("reconnect-file-btn");
  const openBtn = document.getElementById("link-file-btn");
  const newBtn = document.getElementById("new-file-btn");

  pill.classList.remove("is-synced", "is-local", "is-error");

  if (useServerApi) {
    reconnectBtn.classList.add("hidden");
    openBtn.classList.add("hidden");
    newBtn.classList.add("hidden");
    if (syncState === "error") {
      pill.textContent = "▲ Server error · Retry";
      pill.title = syncErrorMsg || "Could not reach local Python server.";
      pill.classList.add("is-error");
    } else {
      pill.textContent = `● Synced · ${serverFileName}${lastSyncTime ? ` · ${lastSyncTime}` : ""}`;
      pill.title = "Auto-saving directly via local Python server.";
      pill.classList.add("is-synced");
    }
    return;
  }

  const canLink = supportsDirectFileAccess();
  openBtn.classList.toggle("hidden", !canLink);
  newBtn.classList.toggle("hidden", !canLink);
  reconnectBtn.classList.toggle("hidden", !reconnectHandle || Boolean(linkedFileHandle));
  if (reconnectHandle && !linkedFileHandle) {
    reconnectBtn.textContent = `Reconnect ${reconnectHandle.name}`;
  }

  if (syncState === "error") {
    pill.textContent = `▲ Couldn't save${linkedFileHandle ? ` ${linkedFileHandle.name}` : ""} · Retry`;
    pill.title = syncErrorMsg || "Click to retry saving or export a backup.";
    pill.classList.add("is-error");
  } else if (linkedFileHandle) {
    pill.textContent = `● Synced · ${linkedFileHandle.name}${lastSyncTime ? ` · ${lastSyncTime}` : ""}`;
    pill.title = "Auto-saving directly to your linked file (with conflict merge).";
    pill.classList.add("is-synced");
  } else {
    pill.textContent = "● This PC only · Export";
    pill.title = canLink
      ? "Saved in browser only. Click Open file / New file to sync with OneDrive, or Export."
      : "Saved in browser only. Use Export / Import to move tasks.json between PCs.";
    pill.classList.add("is-local");
  }
}

function showBanner(text, actions = [], isError = false) {
  const banner = document.getElementById("system-banner");
  const textEl = document.getElementById("system-banner-text");
  const actionsEl = document.getElementById("system-banner-actions");
  textEl.textContent = text;
  actionsEl.innerHTML = "";
  actions.forEach(({ label, onClick }) => actionsEl.appendChild(makeButton(label, "banner-btn", onClick)));
  banner.classList.toggle("is-error", isError);
  banner.classList.remove("hidden");
  // At most one system banner visible at a time
  document.getElementById("checkin-banner").classList.add("hidden");
}

function hideBanner() {
  document.getElementById("system-banner").classList.add("hidden");
  renderCheckin();
}

function reportSyncError(targetName, message, retryFn) {
  syncState = "error";
  syncErrorMsg = message;
  updateStorageIndicator();
  showBanner(
    `Couldn't save to ${targetName}: ${message}`,
    [
      { label: "Retry", onClick: retryFn },
      { label: "Export backup", onClick: exportJson },
    ],
    true
  );
}

async function serverFetch(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (serverToken) headers["X-Horizon-Token"] = serverToken;
  return fetch(url, { ...options, headers });
}

function loadFromServer({ merge = false } = {}) {
  return enqueueSync(async () => {
    try {
      const res = await serverFetch("/api/data", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const parsed = parseTaskDocument(data.document || []);
      const prevEtag = serverEtag;
      serverEtag = res.headers.get("ETag");
      serverFileName = data.fileName || "tasks.json";

      if (data.isNew && !hasLoadedServer && !merge) {
        // Brand-new server file: seed starter samples once via logic.js
        tasks = createSampleTasks();
        hasLoadedServer = true;
        await saveToServerInner();
      } else if (merge && hasLoadedServer) {
        if (prevEtag && serverEtag === prevEtag) return false;
        tasks = mergeTaskLists(tasks, parsed.tasks);
        renderAll();
        showToast(`Synced latest changes from ${serverFileName}`);
      } else {
        tasks = parsed.tasks;
        hasLoadedServer = true;
      }

      syncState = "synced";
      syncErrorMsg = "";
      lastSyncTime = nowHHMM();
      hideBanner();
      updateStorageIndicator();
      return true;
    } catch (err) {
      syncState = "error";
      syncErrorMsg = String(err.message || err);
      updateStorageIndicator();
      showBanner(
        `Local server issue: ${syncErrorMsg}. Edits won't save to disk until reconnected.`,
        [{ label: "Retry", onClick: async () => { if (await loadFromServer({ merge: hasLoadedServer })) renderAll(); } }],
        true
      );
      return false;
    }
  });
}

async function saveToServerInner() {
  // Never overwrite disk before at least one server read has succeeded
  if (!hasLoadedServer || !serverEtag) {
    reportSyncError(serverFileName, "Server has not loaded yet — click Retry to reconnect first.", async () => {
      if (await loadFromServer({ merge: hasLoadedServer })) renderAll();
    });
    return;
  }

  const doc = serializeTaskDocument(tasks, DEVICE_ID);
  saveLocalCache(doc);

  try {
    const res = await serverFetch("/api/data", {
      method: "PUT",
      headers: { "If-Match": serverEtag },
      body: JSON.stringify(doc),
    });

    if (res.status === 409) {
      const conflictData = await res.json();
      const remoteDoc = parseTaskDocument(conflictData.document);
      tasks = mergeTaskLists(tasks, remoteDoc.tasks);
      serverEtag = res.headers.get("ETag");
      const mergedDoc = serializeTaskDocument(tasks, DEVICE_ID);
      saveLocalCache(mergedDoc);

      const retry = await serverFetch("/api/data", {
        method: "PUT",
        headers: { "If-Match": serverEtag },
        body: JSON.stringify(mergedDoc),
      });
      if (!retry.ok) {
        const retryErr = await retry.json().catch(() => ({}));
        throw new Error(retryErr.error || `HTTP ${retry.status}`);
      }
      serverEtag = retry.headers.get("ETag");
      showToast(`Merged updates from ${serverFileName}`);
      renderAll();
    } else if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    } else {
      serverEtag = res.headers.get("ETag");
    }

    syncState = "synced";
    syncErrorMsg = "";
    lastSyncTime = nowHHMM();
    hideBanner();
    updateStorageIndicator();
  } catch (err) {
    reportSyncError(serverFileName, String(err.message || err), () => persistState());
  }
}

async function readFileWithRetry(handle) {
  try {
    return await handle.getFile();
  } catch {
    // OneDrive Files On-Demand can transiently fail on first touch — retry once
    await new Promise((r) => setTimeout(r, 350));
    return handle.getFile();
  }
}

function writeLinkedFileQueued() {
  if (!linkedFileHandle) return Promise.resolve();
  return enqueueSync(async () => {
    try {
      let mergedRemote = false;
      const file = await readFileWithRetry(linkedFileHandle);
      const text = await file.text();
      if (lastDiskStamp && file.lastModified !== lastDiskStamp && text.trim()) {
        const remote = parseTaskDocument(JSON.parse(text));
        tasks = mergeTaskLists(tasks, remote.tasks);
        mergedRemote = true;
        showToast(`Merged updates from ${linkedFileHandle.name}`);
      }

      const doc = serializeTaskDocument(tasks, DEVICE_ID);
      saveLocalCache(doc);
      const writable = await linkedFileHandle.createWritable();
      await writable.write(JSON.stringify(doc, null, 2) + "\n");
      await writable.close();

      const updatedFile = await linkedFileHandle.getFile();
      lastDiskStamp = updatedFile.lastModified;
      syncState = "synced";
      syncErrorMsg = "";
      lastSyncTime = nowHHMM();
      hideBanner();
      updateStorageIndicator();
      if (mergedRemote) renderAll();
    } catch (err) {
      reportSyncError(linkedFileHandle.name, String(err.message || err), () => writeLinkedFileQueued());
    }
  });
}

function persistState() {
  if (useServerApi) {
    return enqueueSync(() => saveToServerInner());
  }

  const doc = serializeTaskDocument(tasks, DEVICE_ID);
  saveLocalCache(doc);
  if (linkedFileHandle) return writeLinkedFileQueued();
  if (activeTasks().some((t) => !t.isSample)) {
    savePrefs({ lastLocalEditAt: Date.now() });
  }
  syncState = "local";
  updateStorageIndicator();
  return Promise.resolve();
}

function syncFromExternalChange() {
  if (useServerApi) {
    return loadFromServer({ merge: true });
  }
  if (!linkedFileHandle) return Promise.resolve();
  return enqueueSync(async () => {
    try {
      const file = await readFileWithRetry(linkedFileHandle);
      if (lastDiskStamp && file.lastModified === lastDiskStamp) return;
      const text = await file.text();
      if (!text.trim()) return;
      const remote = parseTaskDocument(JSON.parse(text));
      tasks = mergeTaskLists(tasks, remote.tasks);
      lastDiskStamp = file.lastModified;
      saveLocalCache(serializeTaskDocument(tasks, DEVICE_ID));
      lastSyncTime = nowHHMM();
      updateStorageIndicator();
      renderAll();
      showToast(`Synced latest changes from ${linkedFileHandle.name}`);
    } catch {
      // Non-fatal on focus refresh; next write surfaces any persistent lock
    }
  });
}

async function attachFileHandle(handle) {
  const file = await readFileWithRetry(handle);
  const text = await file.text();
  let merged = false;

  if (text.trim()) {
    const parsed = parseTaskDocument(JSON.parse(text));
    if (parsed.wasV1) {
      safeLocalSet(`horizon_v1_backup_${toDateKey(new Date())}`, text);
    }
    // Keep local tombstones when merging so deletions made while unlinked propagate!
    const localReal = tasks.filter((t) => !t.isSample);
    if (localReal.length > 0) {
      tasks = mergeTaskLists(localReal, parsed.tasks);
      merged = true;
    } else {
      tasks = parsed.tasks;
    }
  }

  linkedFileHandle = handle;
  reconnectHandle = null;
  lastDiskStamp = file.lastModified;
  safeLocalSet(SAMPLE_FLAG_KEY, "1");
  await saveStoredHandle(handle);
  await persistState();
  renderAll();
  showToast(merged ? `Linked & merged with ${handle.name}` : `Linked to ${handle.name}`);
}

async function pickAndLinkFile(mode) {
  if (!supportsDirectFileAccess()) return;
  let handle;
  try {
    if (mode === "open") {
      [handle] = await window.showOpenFilePicker({
        types: [{ description: "JSON Tasks File", accept: { "application/json": [".json"] } }],
        multiple: false,
      });
    } else {
      handle = await window.showSaveFilePicker({
        suggestedName: "tasks.json",
        types: [{ description: "JSON Tasks File", accept: { "application/json": [".json"] } }],
      });
    }
  } catch (err) {
    if (err && err.name !== "AbortError") {
      showBanner(
        "Direct file linking isn't allowed here — use Export / Import instead. Your tasks stay saved in browser storage.",
        [{ label: "Dismiss", onClick: hideBanner }]
      );
    }
    return;
  }

  try {
    await attachFileHandle(handle);
  } catch (err) {
    showBanner(
      `Couldn't read ${handle.name}: ${err.message || err}. Make sure it's valid Horizon JSON.`,
      [{ label: "Dismiss", onClick: hideBanner }],
      true
    );
  }
}

async function reconnectSavedFile() {
  if (!reconnectHandle) return;
  try {
    const perm = await reconnectHandle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      await attachFileHandle(reconnectHandle);
    } else {
      showBanner("Permission not granted to reconnect file.", [{ label: "Dismiss", onClick: hideBanner }]);
    }
  } catch (err) {
    showBanner(`Could not reconnect: ${err.message || err}`, [{ label: "Open file", onClick: () => pickAndLinkFile("open") }], true);
  }
}

async function loadInitialTasks() {
  if (useServerApi) {
    await loadFromServer({ merge: false });
    return;
  }

  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY);
    const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (rawV2) {
      tasks = parseTaskDocument(JSON.parse(rawV2)).tasks;
    } else if (rawV1) {
      safeLocalSet(`horizon_v1_backup_${toDateKey(new Date())}`, rawV1);
      tasks = parseTaskDocument(JSON.parse(rawV1)).tasks;
      saveLocalCache(serializeTaskDocument(tasks, DEVICE_ID));
    } else if (!localStorage.getItem(SAMPLE_FLAG_KEY)) {
      tasks = createSampleTasks();
      saveLocalCache(serializeTaskDocument(tasks, DEVICE_ID));
    }
  } catch {
    tasks = [];
  }

  if (supportsDirectFileAccess()) {
    const savedHandle = await loadStoredHandle();
    if (savedHandle) {
      try {
        const perm = await savedHandle.queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
          await attachFileHandle(savedHandle);
          return;
        }
        reconnectHandle = savedHandle;
        showBanner(`Previously synced with ${savedHandle.name}.`, [
          { label: `Reconnect ${savedHandle.name}`, onClick: reconnectSavedFile },
          { label: "Stay local", onClick: hideBanner },
        ]);
      } catch {
        // Handle no longer valid
      }
    }
  }

  syncState = "local";
  updateStorageIndicator();
}

// ============================================================================
// 4. Task Mutations, Today Cap (3), & Targeted Undo
// ============================================================================

function showToast(text, undoDelta = null) {
  const toast = document.getElementById("toast");
  const textEl = document.getElementById("toast-text");
  const undoBtn = document.getElementById("toast-undo-btn");

  if (undoEntry && undoEntry.timerId) clearTimeout(undoEntry.timerId);
  textEl.textContent = text;
  undoBtn.classList.toggle("hidden", !undoDelta);
  toast.classList.remove("hidden");

  const timerId = setTimeout(() => {
    toast.classList.add("hidden");
    undoEntry = null;
  }, 5500);

  undoEntry = { delta: undoDelta, timerId };
}

/** Restore only the tasks touched by the undone action so newer edits/merges survive. */
async function performUndo() {
  if (!undoEntry || !undoEntry.delta) return;
  const { delta, timerId } = undoEntry;
  clearTimeout(timerId);
  undoEntry = null;
  document.getElementById("toast").classList.add("hidden");

  const now = new Date();
  const nowMs = now.getTime();
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const [id, prevTask] of delta.entries()) {
    if (prevTask === null) {
      const cur = byId.get(id);
      if (cur) byId.set(id, applyTaskTransition(cur, { deleted: true }, now));
    } else {
      byId.set(id, normalizeTask({ ...prevTask, updatedAt: nowMs }, now));
    }
  }

  tasks = Array.from(byId.values()).filter(Boolean);
  await persistState();
  renderAll();
}

function todayActiveList() {
  return activeTasks().filter((t) => t.list === "today");
}

async function addTask(title, dueDate, putInToday, forceToday = false, area = "work") {
  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  if (putInToday && !forceToday && todayActiveList().length >= TODAY_CAP) {
    pendingSwap = { kind: "add", title: cleanTitle, dueDate, area };
    renderLists();
    return;
  }

  const created = createTask({
    title: cleanTitle,
    dueDate,
    area,
    list: putInToday ? "today" : "later",
  });
  tasks.unshift(created);
  pendingSwap = null;
  await persistState();
  renderAll();
}

async function updateTask(taskId, patch, { undoLabel = null, forceToday = false } = {}) {
  const idx = tasks.findIndex((t) => t.id === taskId && !t.deleted);
  if (idx === -1) return;
  const current = tasks[idx];

  if (
    patch.list === "today" &&
    current.list !== "today" &&
    !forceToday &&
    todayActiveList().length >= TODAY_CAP
  ) {
    pendingSwap = { kind: "move", taskId };
    renderLists();
    return;
  }

  const undoDelta = undoLabel ? new Map([[taskId, cloneTask(current)]]) : null;
  const movingStartedOutOfToday =
    current.list === "today" &&
    patch.list === "later" &&
    current.stage === "started" &&
    !current.nextStep;

  tasks[idx] = applyTaskTransition(current, patch);
  pendingSwap = null;

  if (movingStartedOutOfToday) {
    editingStage = { id: taskId, mode: "started", prompt: "Where did you leave this?" };
    pendingFocusTarget = { taskId, key: "stage-input" };
  }

  await persistState();
  renderAll();
  if (undoLabel && undoDelta) showToast(undoLabel, undoDelta);
}

async function executeSwap(swapOutTaskId) {
  if (!pendingSwap) return;
  const swapInfo = pendingSwap;
  pendingSwap = null;

  const outIdx = tasks.findIndex((t) => t.id === swapOutTaskId && !t.deleted);
  if (outIdx !== -1) {
    const outTask = tasks[outIdx];
    const promptNext = outTask.stage === "started" && !outTask.nextStep;
    tasks[outIdx] = applyTaskTransition(outTask, { list: "later" });
    if (promptNext) {
      editingStage = { id: outTask.id, mode: "started", prompt: "Where did you leave this?" };
      pendingFocusTarget = { taskId: outTask.id, key: "stage-input" };
    }
  }

  if (swapInfo.kind === "add") {
    tasks.unshift(
      createTask({ title: swapInfo.title, dueDate: swapInfo.dueDate, area: swapInfo.area || "work", list: "today" })
    );
  } else if (swapInfo.kind === "move") {
    const inIdx = tasks.findIndex((t) => t.id === swapInfo.taskId && !t.deleted);
    if (inIdx !== -1) tasks[inIdx] = applyTaskTransition(tasks[inIdx], { list: "today" });
  }

  await persistState();
  renderAll();
}

async function toggleDone(taskId) {
  const task = tasks.find((t) => t.id === taskId && !t.deleted);
  if (!task) return;
  if (task.list === "done") {
    const restoreList = task.prevList === "today" && todayActiveList().length < TODAY_CAP ? "today" : "later";
    await updateTask(taskId, { list: restoreList });
  } else {
    await updateTask(taskId, { list: "done" }, { undoLabel: `Completed "${task.title}"` });
  }
}

async function deleteTask(taskId) {
  const idx = tasks.findIndex((t) => t.id === taskId && !t.deleted);
  if (idx === -1) return;
  const prev = cloneTask(tasks[idx]);
  tasks[idx] = applyTaskTransition(tasks[idx], { deleted: true });
  if (inspectedTaskId === taskId) inspectedTaskId = null;
  if (expandedTaskId === taskId) expandedTaskId = null;
  if (editingNotesId === taskId) editingNotesId = null;
  notesDrafts.delete(taskId);
  stepDrafts.delete(taskId);
  if (editingStage && editingStage.id === taskId) editingStage = null;
  await persistState();
  renderAll();
  showToast(`Deleted "${prev.title}"`, new Map([[taskId, prev]]));
}

async function clearMatching(predicate, labelFn, afterFn = null) {
  const targets = activeTasks().filter(predicate);
  if (targets.length === 0) return;
  const delta = new Map(targets.map((t) => [t.id, cloneTask(t)]));
  const targetIds = new Set(delta.keys());
  tasks = tasks.map((t) => (targetIds.has(t.id) ? applyTaskTransition(t, { deleted: true }) : t));
  if (afterFn) afterFn();
  await persistState();
  renderAll();
  showToast(labelFn(targets.length), delta);
}

const clearCompleted = () =>
  clearMatching((t) => t.list === "done", (n) => `Cleared ${n} completed task${n === 1 ? "" : "s"}`);

const clearSamples = () =>
  clearMatching(
    (t) => Boolean(t.isSample),
    () => "Cleared sample tasks",
    () => safeLocalSet(SAMPLE_FLAG_KEY, "1")
  );

// ============================================================================
// 5. Rendering (Header, Horizon Timeline, Lists, Inline Editors)
// ============================================================================

function matchesSearch(task) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (
    task.title.toLowerCase().includes(q) ||
    (task.nextStep && task.nextStep.toLowerCase().includes(q)) ||
    (task.waitingOn && task.waitingOn.toLowerCase().includes(q)) ||
    (task.area && task.area.toLowerCase().includes(q))
  );
}

function finishCheckin(toastMsg = null) {
  checkinMode = "hidden";
  checkinCards = [];
  checkinIndex = 0;
  savePrefs({ lastCheckinDate: toDateKey(new Date()) });
  renderCheckin();
  // Never overwrite an active Undo toast
  if (toastMsg && !undoEntry?.delta) showToast(toastMsg);
}

function startCheckinCards() {
  if (!document.getElementById("system-banner").classList.contains("hidden")) {
    showToast("Resolve or dismiss the top alert banner first.");
    return;
  }
  const data = getMorningCheckinData(tasks);
  if (data.cards.length === 0) {
    showToast("All clear — nothing pending for check-in.");
    return;
  }
  checkinCards = data.cards;
  checkinIndex = 0;
  checkinMode = "cards";
  renderCheckin();
}

function advanceCheckin(expectedTaskId = null) {
  // If renderCheckin() already advanced when the card's task was completed/deleted, don't advance twice
  if (expectedTaskId && checkinCards[checkinIndex]?.task?.id !== expectedTaskId) return;

  checkinIndex += 1;
  while (checkinIndex < checkinCards.length) {
    const id = checkinCards[checkinIndex].task.id;
    if (activeTasks().some((t) => t.id === id && t.list !== "done")) break;
    checkinIndex += 1;
  }
  if (checkinIndex >= checkinCards.length) {
    finishCheckin("Morning check-in complete.");
  } else {
    renderCheckin();
  }
}

function appendFreshnessButtons(container, task, { keepCls, btnCls, dropCls, after = null }) {
  container.appendChild(
    makeButton("Keep", keepCls, async () => {
      await updateTask(task.id, { touch: true, snoozedUntil: null });
      if (after) after();
    })
  );
  container.appendChild(
    makeButton("Snooze 2w", btnCls, async () => {
      await updateTask(task.id, { snoozedUntil: addDaysKey(new Date(), 14) });
      if (after) after();
    })
  );
  container.appendChild(
    makeButton("Drop", dropCls, async () => {
      await deleteTask(task.id);
      if (after) after();
    })
  );
}

function needsUnlinkedExportReminder() {
  if (useServerApi || linkedFileHandle) return false;
  if (!activeTasks().some((t) => !t.isSample)) return false;
  return (uiPrefs.lastLocalEditAt || 0) > (uiPrefs.lastExportAt || 0);
}

function renderCheckin() {
  const el = document.getElementById("checkin-banner");
  const systemBannerVisible = !document.getElementById("system-banner").classList.contains("hidden");
  if (systemBannerVisible || checkinMode === "hidden") {
    el.classList.add("hidden");
    return;
  }

  const now = new Date();
  const todayStr = toDateKey(now);
  if (checkinMode === "auto") {
    if (uiPrefs.lastCheckinDate === todayStr) {
      el.classList.add("hidden");
      return;
    }
    const { counts, cards } = getMorningCheckinData(tasks, now);
    const isMonday = now.getDay() === 1;
    const lastWeek = isMonday ? getWeeklyMomentum(activeTasks(), now, { lastWeek: true }) : { tasksDone: 0, stepsDone: 0 };
    const hasMondayWins = isMonday && lastWeek.tasksDone + lastWeek.stepsDone > 0;
    const showExportHint = needsUnlinkedExportReminder();

    if (cards.length === 0 && !hasMondayWins && !showExportHint) {
      el.classList.add("hidden");
      return;
    }

    const parts = [];
    if (counts.started) parts.push(`${counts.started} started`);
    if (counts.waiting) parts.push(`${counts.waiting} waiting`);
    if (counts.dueSoon) parts.push(`${counts.dueSoon} due soon`);
    if (counts.fading) parts.push(`${counts.fading} fading`);

    el.innerHTML = "";

    if (hasMondayWins) {
      const winsEl = document.createElement("div");
      winsEl.className = "checkin-wins-line";
      const winParts = [];
      if (lastWeek.tasksDone) winParts.push(`${lastWeek.tasksDone} done`);
      if (lastWeek.stepsDone) winParts.push(`${lastWeek.stepsDone} step${lastWeek.stepsDone === 1 ? "" : "s"}`);
      winsEl.textContent = `Last week: ${winParts.join(" · ")}`;
      el.appendChild(winsEl);
    }

    const row = document.createElement("div");
    row.className = "checkin-summary-row";

    const text = document.createElement("span");
    text.className = "checkin-summary-text";
    const strong = document.createElement("strong");
    strong.textContent = "Morning";
    text.appendChild(strong);
    text.appendChild(document.createTextNode(parts.length ? ` · ${parts.join(" · ")}` : " · All clear for today"));

    const actions = document.createElement("div");
    actions.className = "system-banner-actions";
    if (cards.length > 0) actions.appendChild(makeButton("Plan today", "banner-btn", startCheckinCards));
    actions.appendChild(makeButton("Skip", "row-btn", () => finishCheckin()));

    row.appendChild(text);
    row.appendChild(actions);
    el.appendChild(row);

    if (showExportHint) {
      const expRow = document.createElement("div");
      expRow.className = "checkin-export-row";
      const msg = document.createElement("span");
      msg.textContent = "Saved on this PC only — export tasks.json to sync via OneDrive.";
      expRow.appendChild(msg);
      expRow.appendChild(
        makeButton("Export now", "banner-btn", () => {
          exportJson();
          renderCheckin();
        })
      );
      el.appendChild(expRow);
    }

    el.classList.remove("hidden");
    return;
  }

  // Card walk-through mode
  const entry = checkinCards[checkinIndex];
  const liveTask = entry ? activeTasks().find((t) => t.id === entry.task.id && t.list !== "done") : null;
  if (!liveTask) {
    advanceCheckin(false);
    return;
  }

  const kindLabel = {
    started: "Started",
    dueSoon: "Due soon",
    waiting: "Waiting on",
    fading: "Fading (14d+)",
  }[entry.kind];

  el.innerHTML = "";
  const card = document.createElement("div");
  card.className = "checkin-card";

  const body = document.createElement("div");
  body.className = "checkin-card-body";

  const kicker = document.createElement("span");
  kicker.className = "checkin-card-kicker";
  const dueMeta = liveTask.dueDate ? ` · ${formatShortDate(liveTask.dueDate)} (${formatDaysLabel(daysUntil(liveTask.dueDate))})` : "";
  kicker.textContent = `${checkinIndex + 1}/${checkinCards.length} · ${kindLabel}${dueMeta}`;
  body.appendChild(kicker);

  const title = document.createElement("span");
  title.className = "checkin-card-title";
  title.textContent = liveTask.title;
  body.appendChild(title);

  if (liveTask.stage === "waiting" && liveTask.waitingOn) {
    const sub = document.createElement("span");
    sub.className = "checkin-card-sub";
    sub.textContent = `◷ Waiting on ${liveTask.waitingOn}${liveTask.nextStep ? ` · ${liveTask.nextStep}` : ""}`;
    body.appendChild(sub);
  } else if (liveTask.nextStep) {
    const sub = document.createElement("span");
    sub.className = "checkin-card-sub";
    sub.textContent = `→ ${liveTask.nextStep}`;
    body.appendChild(sub);
  }

  const actions = document.createElement("div");
  actions.className = "checkin-card-actions";

  if (entry.kind === "started" || entry.kind === "dueSoon") {
    if (liveTask.list === "today") {
      actions.appendChild(makeButton("Keep in Today", "banner-btn", () => advanceCheckin(liveTask.id)));
      actions.appendChild(
        makeButton("Later", "row-btn", async () => {
          await updateTask(liveTask.id, { list: "later" });
          advanceCheckin(liveTask.id);
        })
      );
    } else if (todayActiveList().length < TODAY_CAP) {
      actions.appendChild(
        makeButton("★ Today", "banner-btn", async () => {
          await updateTask(liveTask.id, { list: "today" });
          const moved = activeTasks().some((t) => t.id === liveTask.id && t.list === "today");
          if (moved) {
            if (todayActiveList().length >= TODAY_CAP && !undoEntry?.delta) {
              showToast(`Today is full (${TODAY_CAP}/${TODAY_CAP}) — finishing remaining cards.`);
            }
            advanceCheckin(liveTask.id);
          }
        })
      );
      actions.appendChild(makeButton("Keep in Later", "row-btn", () => advanceCheckin(liveTask.id)));
    } else {
      actions.appendChild(makeButton("Keep in Later", "banner-btn", () => advanceCheckin(liveTask.id)));
    }
    actions.appendChild(
      makeButton("✓ Done", "row-btn", async () => {
        await toggleDone(liveTask.id);
        advanceCheckin(liveTask.id);
      })
    );
  } else if (entry.kind === "waiting") {
    actions.appendChild(
      makeButton("Still waiting", "banner-btn", async () => {
        await updateTask(liveTask.id, { touch: true });
        advanceCheckin(liveTask.id);
      })
    );
    actions.appendChild(
      makeButton("◐ Resume", "row-btn", async () => {
        await updateTask(liveTask.id, { stage: "started", waitingOn: null });
        advanceCheckin(liveTask.id);
      })
    );
    actions.appendChild(
      makeButton("✓ Done", "row-btn", async () => {
        await toggleDone(liveTask.id);
        advanceCheckin(liveTask.id);
      })
    );
  } else {
    appendFreshnessButtons(actions, liveTask, {
      keepCls: "banner-btn",
      btnCls: "row-btn",
      dropCls: "row-btn del",
      after: () => advanceCheckin(liveTask.id),
    });
  }

  actions.appendChild(makeButton("Finish", "row-btn", () => finishCheckin()));
  card.appendChild(body);
  card.appendChild(actions);
  el.appendChild(card);
  el.classList.remove("hidden");
}

function runEndDayRitual(fromChain = false) {
  const startedMissing = [
    ...todayActiveList().filter((t) => t.stage === "started" && !t.nextStep),
    ...activeTasks().filter((t) => t.list === "later" && t.stage === "started" && !t.nextStep),
  ];
  const nextTask = startedMissing[0];
  if (nextTask) {
    if (searchQuery && !matchesSearch(nextTask)) {
      searchQuery = "";
      document.getElementById("search-input").value = "";
      document.getElementById("search-bar").classList.add("hidden");
    }
    editingStage = {
      id: nextTask.id,
      mode: "started",
      prompt: `End day (${startedMissing.length} left) — where did you leave this?`,
      endDayChain: true,
    };
    pendingFocusTarget = { taskId: nextTask.id, key: "stage-input" };
    renderAll();
    return;
  }
  showToast(
    fromChain ? "End day complete — every started task has a next step." : "All started tasks already have a next step."
  );
}

function renderHeader() {
  document.getElementById("today-label").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  document.getElementById("clear-samples-btn").classList.toggle("hidden", !activeTasks().some((t) => t.isSample));
}

function renderTimelineInspector(allActive) {
  const box = document.getElementById("timeline-inspector");
  const task = inspectedTaskId ? allActive.find((t) => t.id === inspectedTaskId && t.list !== "done") : null;
  if (!task) {
    inspectedTaskId = null;
    box.classList.add("hidden");
    return;
  }

  box.innerHTML = "";
  const info = document.createElement("div");
  info.className = "timeline-inspector-info";

  const name = document.createElement("strong");
  name.textContent = task.title;
  info.appendChild(name);

  if (task.stage === "waiting" && task.waitingOn) {
    const w = document.createElement("span");
    w.className = "meta-mono";
    w.textContent = `◷ Waiting on ${task.waitingOn}`;
    info.appendChild(w);
  } else if (task.nextStep) {
    const ns = document.createElement("span");
    ns.className = "meta-mono";
    ns.textContent = `→ ${task.nextStep}`;
    info.appendChild(ns);
  }

  const actions = document.createElement("div");
  actions.className = "timeline-inspector-actions";

  if (task.list !== "today" && task.stage !== "waiting") {
    actions.appendChild(makeButton("→ Today", "banner-btn", () => updateTask(task.id, { list: "today" })));
  } else if (task.list === "today") {
    actions.appendChild(makeButton("Later", "banner-btn", () => updateTask(task.id, { list: "later" })));
  }

  actions.appendChild(
    makeButton(task.stage === "started" ? "Edit next step" : "◐ Start", "banner-btn", () => {
      editingStage = { id: task.id, mode: "started" };
      pendingFocusTarget = { taskId: task.id, key: "stage-input" };
      if (task.stage !== "started") updateTask(task.id, { stage: "started" });
      else renderLists();
    })
  );
  actions.appendChild(makeButton("✓ Done", "banner-btn", () => toggleDone(task.id)));
  actions.appendChild(
    makeButton("×", "banner-btn", () => {
      inspectedTaskId = null;
      box.classList.add("hidden");
    }, { "aria-label": "Close inspector" })
  );

  box.appendChild(info);
  box.appendChild(actions);
  box.classList.remove("hidden");
}

function renderTimeline() {
  const monthsEl = document.getElementById("timeline-months");
  const gridEl = document.getElementById("timeline-grid");
  const lanesEl = document.getElementById("timeline-lanes");
  const overdueEl = document.getElementById("overdue-strip");

  monthsEl.innerHTML = "";
  gridEl.innerHTML = "";
  lanesEl.innerHTML = "";
  overdueEl.innerHTML = "";

  getMonthMarkers().forEach((m) => {
    const el = document.createElement("div");
    el.className = `month-marker${m.isToday ? " is-today" : ""}`;
    el.style.left = `${m.percent}%`;
    el.textContent = m.label;
    monthsEl.appendChild(el);

    if (!m.isToday) {
      const line = document.createElement("div");
      line.className = "grid-line is-major";
      line.style.left = `${m.percent}%`;
      gridEl.appendChild(line);
    }
  });

  for (let d = 7; d < HORIZON_DAYS; d += 7) {
    const tick = document.createElement("div");
    tick.className = "grid-line";
    tick.style.left = `${(d / HORIZON_DAYS) * 100}%`;
    gridEl.appendChild(tick);
  }

  const allActive = activeTasks().filter(matchesSearch);
  const todayStr = toDateKey(new Date());
  const timelineTasks = sortTasksByUrgency(
    allActive.filter((t) => t.list !== "done" && (parseDateKey(t.dueDate) || t.list === "today"))
  );

  const overdueTasks = [];
  const upcomingTasks = [];
  const beyondHorizon = [];

  timelineTasks.forEach((t) => {
    const effectiveDate = parseDateKey(t.dueDate) ? t.dueDate : todayStr;
    const days = daysUntil(effectiveDate);
    if (days === null) return;
    if (days < 0) overdueTasks.push({ task: t, days, effectiveDate });
    else if (days <= HORIZON_DAYS) upcomingTasks.push({ task: t, days, effectiveDate });
    else beyondHorizon.push({ task: t, days, effectiveDate });
  });

  document.getElementById("timeline-count").textContent = String(timelineTasks.length);

  if (overdueTasks.length > 0) {
    overdueEl.classList.remove("hidden");
    const label = document.createElement("span");
    label.className = "overdue-label";
    label.textContent = "Overdue";
    overdueEl.appendChild(label);

    overdueTasks.forEach(({ task, days }) => {
      overdueEl.appendChild(
        makeButton(
          `${task.title} (${formatDaysLabel(days)})`,
          "overdue-chip",
          () => {
            inspectedTaskId = task.id;
            renderTimelineInspector(allActive);
          },
          { title: "Click to inspect or pull into Today" }
        )
      );
    });
  } else {
    overdueEl.classList.add("hidden");
  }

  if (upcomingTasks.length === 0 && beyondHorizon.length === 0) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = "No dated or Today tasks yet.";
    lanesEl.appendChild(empty);
    renderTimelineInspector(allActive);
    return;
  }

  upcomingTasks.forEach(({ task, days, effectiveDate }) => {
    const lane = document.createElement("div");
    lane.className = "timeline-lane";

    const style = getGradientStyle(days, task.area);
    const widthPct = getTimelineWidthPercent(days);
    const labelOutside = widthPct < 34;

    const inspectHandler = () => {
      inspectedTaskId = inspectedTaskId === task.id ? null : task.id;
      renderTimelineInspector(allActive);
    };

    const waitingNote = task.stage === "waiting" && task.waitingOn ? ` · Waiting on ${task.waitingOn}` : "";
    const barTitle = `${task.title} — ${formatShortDate(effectiveDate)} (${formatDaysLabel(days)})${waitingNote}. Click for actions.`;

    const bar = makeButton("", "timeline-bar", inspectHandler, { title: barTitle });
    if (task.area === "personal") bar.classList.add("is-personal");
    if (task.list === "today") bar.classList.add("is-today-star");
    if (task.stage === "waiting") bar.classList.add("is-waiting");
    bar.style.width = `${widthPct}%`;
    bar.style.background = style.background;
    bar.style.borderRightColor = style.borderColor;
    bar.style.color = style.textColor;

    if (task.stage === "started") {
      const fill = document.createElement("span");
      fill.className = "timeline-progress-fill";
      fill.style.width = `${Math.round(getTaskProgressRatio(task) * 100)}%`;
      fill.style.background = style.borderColor;
      bar.appendChild(fill);
    }

    const prefix = task.list === "today" ? "★ " : task.stage === "started" ? "◐ " : task.stage === "waiting" ? "◷ " : "";
    const titleText = `${prefix}${task.title}`;
    const metaText = `${formatShortDate(effectiveDate)} · ${formatDaysLabel(days)}`;
    const freshness = getTaskFreshness(task);

    if (labelOutside) {
      bar.tabIndex = -1;
      bar.setAttribute("aria-hidden", "true");

      const outside = makeButton("", "timeline-outside-label", inspectHandler, { title: barTitle });
      if (freshness.isFading) outside.style.opacity = String(freshness.opacity);
      const titleSpan = document.createElement("span");
      titleSpan.className = "timeline-outside-title";
      titleSpan.textContent = titleText;
      const metaSpan = document.createElement("span");
      metaSpan.className = "timeline-outside-meta";
      metaSpan.style.color = style.badgeColor;
      metaSpan.textContent = metaText;
      outside.appendChild(titleSpan);
      outside.appendChild(metaSpan);
      lane.appendChild(bar);
      lane.appendChild(outside);
    } else {
      const titleSpan = document.createElement("span");
      titleSpan.className = "timeline-bar-label";
      if (freshness.isFading) titleSpan.style.opacity = String(freshness.opacity);
      titleSpan.textContent = titleText;
      const metaSpan = document.createElement("span");
      metaSpan.className = "timeline-bar-meta";
      metaSpan.textContent = metaText;
      bar.appendChild(titleSpan);
      bar.appendChild(metaSpan);
      lane.appendChild(bar);
    }

    lanesEl.appendChild(lane);
  });

  if (beyondHorizon.length > 0) {
    const note = document.createElement("div");
    note.className = "timeline-beyond-note";
    note.textContent =
      `Beyond 90d (${beyondHorizon.length}): ` +
      beyondHorizon
        .map(({ task, days, effectiveDate }) => `${task.title} (${formatShortDate(effectiveDate)}, ${days}d)`)
        .join(" · ");
    lanesEl.appendChild(note);
  }

  renderTimelineInspector(allActive);
}

function buildStageEditor(task) {
  const editor = document.createElement("div");
  editor.className = "stage-editor";
  const mode = editingStage.mode;

  if (editingStage.prompt) {
    const hint = document.createElement("div");
    hint.className = "stage-editor-hint";
    hint.textContent = editingStage.prompt;
    editor.appendChild(hint);
  }

  const tabs = document.createElement("div");
  tabs.className = "stage-editor-tabs";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "stage-editor-input";
  input.dataset.focusKey = "stage-input";
  input.placeholder =
    mode === "waiting" ? "Waiting on who / what? (e.g. Ana – legal)" : "Next physical step (where I left off)...";
  input.value =
    editingStage.draft !== undefined
      ? editingStage.draft
      : mode === "waiting"
      ? task.waitingOn || ""
      : task.nextStep || "";

  tabs.appendChild(
    makeButton("◐ Started", `stage-chip${mode === "started" ? " active" : ""}`, () => {
      editingStage = { id: task.id, mode: "started" };
      pendingFocusTarget = { taskId: task.id, key: "stage-input" };
      renderLists();
    })
  );
  tabs.appendChild(
    makeButton("◷ Waiting on", `stage-chip${mode === "waiting" ? " active" : ""}`, () => {
      editingStage = { id: task.id, mode: "waiting" };
      pendingFocusTarget = { taskId: task.id, key: "stage-input" };
      renderLists();
    })
  );
  tabs.appendChild(
    makeButton("○ Reset to Todo", "stage-chip", () => {
      editingStage = null;
      updateTask(task.id, { stage: "todo", waitingOn: null });
    })
  );
  tabs.appendChild(
    makeButton(
      task.area === "personal" ? "Personal" : "Work",
      `stage-chip area-chip${task.area === "personal" ? " is-personal" : ""}`,
      () => {
        editingStage.draft = input.value;
        updateTask(task.id, { area: task.area === "personal" ? "work" : "personal" });
      },
      { title: "Toggle Work / Personal" }
    )
  );
  editor.appendChild(tabs);

  const row = document.createElement("div");
  row.className = "stage-editor-row";

  const commit = async () => {
    const val = input.value.trim();
    const continueChain = Boolean(editingStage?.endDayChain);
    editingStage = null;
    if (mode === "waiting") {
      if (val) {
        waitingExpanded = true;
        savePrefs({ waitingExpanded: true });
        await updateTask(task.id, { stage: "waiting", waitingOn: val, list: "later" });
      } else {
        await updateTask(task.id, { stage: "started", waitingOn: null });
      }
    } else {
      await updateTask(task.id, { stage: "started", nextStep: val });
      if (continueChain && val) runEndDayRitual(true);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      editingStage = null;
      renderLists();
    }
  });

  row.appendChild(input);
  row.appendChild(makeButton("Save", "banner-btn", commit));
  row.appendChild(
    makeButton("Cancel", "row-btn", () => {
      editingStage = null;
      renderLists();
    })
  );
  editor.appendChild(row);
  return editor;
}

function renderSafeNotes(container, text) {
  container.innerHTML = "";
  tokenizeNotes(text).forEach((tok) => {
    if (tok.type === "link") {
      const a = document.createElement("a");
      a.className = "notes-link";
      a.href = tok.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = tok.label;
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(tok.value));
    }
  });
}

function toggleExpandTask(task) {
  if (!task) return;
  const hasDetail = (task.subtasks && task.subtasks.length > 0) || Boolean(task.notes && task.notes.trim());
  if (task.list === "done" && !hasDetail) return;
  const nextId = expandedTaskId === task.id ? null : task.id;
  if (nextId !== expandedTaskId) editingNotesId = null;
  expandedTaskId = nextId;
  renderLists();
}

function buildTaskDetail(task) {
  const detail = document.createElement("div");
  detail.className = "task-detail";

  // 1. Flat Mini-Checklist (up to MAX_SUBTASKS = 7 steps)
  const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
  const subLabel = document.createElement("div");
  subLabel.className = "detail-label";
  const doneCount = subs.filter((s) => s.done).length;
  subLabel.textContent = subs.length > 0 ? `Steps (${doneCount}/${subs.length})` : "Steps";
  detail.appendChild(subLabel);

  if (subs.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "subtask-list";
    subs.forEach((sub) => {
      const row = document.createElement("li");
      row.className = `subtask-row${sub.done ? " is-done" : ""}`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "task-checkbox";
      cb.dataset.focusKey = `sub-${sub.id}`;
      cb.checked = sub.done;
      cb.disabled = task.list === "done";
      cb.setAttribute("aria-label", `Step: ${sub.title}`);
      cb.addEventListener("change", () => {
        const nextDone = !sub.done;
        const todayStr = toDateKey(new Date());
        const nextSubs = subs.map((s) =>
          s.id === sub.id ? { ...s, done: nextDone, completedAt: nextDone ? todayStr : null } : s
        );
        const patch = { subtasks: nextSubs };
        if (nextDone && task.stage === "todo") patch.stage = "started";
        updateTask(task.id, patch);
      });

      const title = document.createElement("span");
      title.className = "subtask-title";
      title.textContent = sub.title;

      row.appendChild(cb);
      row.appendChild(title);

      if (task.list !== "done") {
        row.appendChild(
          makeButton("×", "row-btn del", () => {
            updateTask(task.id, { subtasks: subs.filter((s) => s.id !== sub.id) });
          }, { "aria-label": `Remove step "${sub.title}"`, "data-focus-key": `sub-del-${sub.id}` })
        );
      }
      ul.appendChild(row);
    });
    detail.appendChild(ul);
  }

  if (task.list !== "done") {
    if (subs.length < MAX_SUBTASKS) {
      const addRow = document.createElement("div");
      addRow.className = "subtask-add-row";
      const subInput = document.createElement("input");
      subInput.type = "text";
      subInput.className = "stage-editor-input";
      subInput.dataset.focusKey = "subtask-input";
      subInput.placeholder = `Add step (${subs.length}/${MAX_SUBTASKS})...`;
      subInput.value = stepDrafts.get(task.id) || "";
      subInput.addEventListener("input", () => stepDrafts.set(task.id, subInput.value));

      const addStep = () => {
        const val = subInput.value.trim();
        if (!val) return;
        stepDrafts.delete(task.id);
        const newSub = {
          id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          title: val,
          done: false,
          completedAt: null,
        };
        pendingFocusTarget = { taskId: task.id, key: "subtask-input" };
        updateTask(task.id, { subtasks: [...subs, newSub] });
      };

      subInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addStep();
        }
      });

      addRow.appendChild(subInput);
      addRow.appendChild(makeButton("Add", "banner-btn", addStep));
      detail.appendChild(addRow);
    } else {
      const cap = document.createElement("span");
      cap.className = "meta-mono";
      cap.textContent = `Max ${MAX_SUBTASKS} steps reached.`;
      detail.appendChild(cap);
    }
  }

  // 2. Notes with safe clickable http(s) links (drafts preserved across tab switches/redraws)
  const notesBlock = document.createElement("div");
  notesBlock.className = "notes-block";

  const notesHead = document.createElement("div");
  notesHead.className = "notes-head";
  const notesLabel = document.createElement("span");
  notesLabel.className = "detail-label";
  notesLabel.textContent = "Notes & links";
  notesHead.appendChild(notesLabel);

  if (task.list !== "done" && editingNotesId !== task.id) {
    notesHead.appendChild(
      makeButton(
        task.notes ? "Edit" : "+ Add note",
        "text-btn",
        () => {
          editingNotesId = task.id;
          pendingFocusTarget = { taskId: task.id, key: "notes-input" };
          renderLists();
        },
        { "data-focus-key": "notes-edit" }
      )
    );
  }
  notesBlock.appendChild(notesHead);

  if (editingNotesId === task.id && task.list !== "done") {
    const area = document.createElement("textarea");
    area.className = "notes-textarea";
    area.dataset.focusKey = "notes-input";
    area.maxLength = MAX_NOTES_LENGTH;
    area.placeholder = "Jot context or paste https:// links... (Ctrl+Enter to save)";
    area.value = notesDrafts.has(task.id) ? notesDrafts.get(task.id) : task.notes || "";
    area.addEventListener("input", () => notesDrafts.set(task.id, area.value));

    let finished = false;
    const commitNotes = () => {
      if (finished || !area.isConnected) return;
      finished = true;
      const val = area.value.trim() ? area.value.trimEnd().slice(0, MAX_NOTES_LENGTH) : "";
      notesDrafts.delete(task.id);
      editingNotesId = null;
      pendingFocusTarget = { taskId: task.id, key: "notes-edit" };
      if (val !== (task.notes || "")) updateTask(task.id, { notes: val });
      else renderLists();
    };

    area.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        commitNotes();
      } else if (e.key === "Escape") {
        finished = true;
        notesDrafts.delete(task.id);
        editingNotesId = null;
        pendingFocusTarget = { taskId: task.id, key: "notes-edit" };
        renderLists();
      }
    });

    const noteActions = document.createElement("div");
    noteActions.className = "notes-actions";
    noteActions.appendChild(makeButton("Save note", "banner-btn", commitNotes, { "data-focus-key": "notes-save" }));
    noteActions.appendChild(
      makeButton("Cancel", "row-btn", () => {
        finished = true;
        notesDrafts.delete(task.id);
        editingNotesId = null;
        pendingFocusTarget = { taskId: task.id, key: "notes-edit" };
        renderLists();
      })
    );

    notesBlock.appendChild(area);
    notesBlock.appendChild(noteActions);
  } else if (task.notes && task.notes.trim()) {
    const view = document.createElement("div");
    view.className = "notes-view";
    renderSafeNotes(view, task.notes);
    notesBlock.appendChild(view);
  }

  detail.appendChild(notesBlock);
  return detail;
}

function buildTaskRow(task, context) {
  const freshness = getTaskFreshness(task);
  const li = document.createElement("li");
  li.className = `task-item${task.list === "done" ? " is-done" : ""}${task.area === "personal" ? " is-personal" : ""}${freshness.isFading ? " is-fading" : ""}`;
  if (freshness.isFading) li.style.setProperty("--ink-alpha", String(freshness.opacity));
  li.dataset.taskId = task.id;

  const mainRow = document.createElement("div");
  mainRow.className = "task-main-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.dataset.focusKey = "check";
  checkbox.checked = task.list === "done";
  checkbox.setAttribute("aria-label", `Mark "${task.title}" as ${task.list === "done" ? "not done" : "done"}`);
  checkbox.addEventListener("change", () => toggleDone(task.id));
  mainRow.appendChild(checkbox);

  if (task.list !== "done") {
    const glyph = task.stage === "started" ? "◐" : task.stage === "waiting" ? "◷" : "○";
    const stageCls = `stage-btn${task.stage === "started" ? " is-started" : task.stage === "waiting" ? " is-waiting" : ""}`;
    const stageTitle =
      task.stage === "started"
        ? "Started — click to edit next step or stage"
        : task.stage === "waiting"
        ? `Waiting on ${task.waitingOn || "..."} — click to update`
        : "Mark as Started (◐) or Waiting (◷)";
    mainRow.appendChild(
      makeButton(
        glyph,
        stageCls,
        () => {
          if (editingStage && editingStage.id === task.id) {
            editingStage = null;
            renderLists();
            return;
          }
          pendingFocusTarget = { taskId: task.id, key: "stage-input" };
          if (task.stage === "todo") {
            editingStage = { id: task.id, mode: "started" };
            updateTask(task.id, { stage: "started" });
          } else {
            editingStage = { id: task.id, mode: task.stage === "waiting" ? "waiting" : "started" };
            renderLists();
          }
        },
        { title: stageTitle, "aria-label": stageTitle, "data-focus-key": "stage" }
      )
    );
  }

  const body = document.createElement("div");
  body.className = "task-body";
  const line = document.createElement("div");
  line.className = "task-line";

  if (editingTitleId === task.id) {
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "task-title-input";
    titleInput.value = task.title;
    titleInput.dataset.focusKey = "title-input";
    let finished = false;
    const commitTitle = () => {
      if (finished || !titleInput.isConnected) return;
      finished = true;
      const val = titleInput.value.trim();
      editingTitleId = null;
      if (val && val !== task.title) updateTask(task.id, { title: val });
      else renderLists();
    };
    titleInput.addEventListener("blur", commitTitle);
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitTitle();
      } else if (e.key === "Escape") {
        finished = true;
        editingTitleId = null;
        renderLists();
      }
    });
    line.appendChild(titleInput);
  } else {
    const titleEl = document.createElement("span");
    titleEl.className = "task-title";
    titleEl.textContent = task.title;
    titleEl.title = "Double-click to rename";
    titleEl.addEventListener("dblclick", () => {
      if (task.list === "done") return;
      editingTitleId = task.id;
      pendingFocusTarget = { taskId: task.id, key: "title-input" };
      renderLists();
    });
    line.appendChild(titleEl);
  }

  if (task.list === "done" && task.completedAt) {
    const doneSpan = document.createElement("span");
    doneSpan.className = "done-date";
    doneSpan.textContent = formatShortDate(task.completedAt);
    line.appendChild(doneSpan);
  } else if (task.dueDate && parseDateKey(task.dueDate)) {
    const days = daysUntil(task.dueDate);
    const style = getGradientStyle(days, task.area);
    const tag = document.createElement("span");
    tag.className = "due-tag";
    tag.style.background = style.badgeBg;
    tag.style.color = style.badgeColor;
    tag.textContent = `${formatShortDate(task.dueDate)} · ${formatDaysLabel(days)}`;
    line.appendChild(tag);
  }

  // Collapsed row shows quiet plain-text subtask progress (e.g. 2/4), zero extra icons
  if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
    const doneSub = task.subtasks.filter((s) => s.done).length;
    line.appendChild(
      makeButton(
        `${doneSub}/${task.subtasks.length}`,
        "subtask-count-btn",
        () => toggleExpandTask(task),
        { title: `${doneSub} of ${task.subtasks.length} steps done — click to expand` }
      )
    );
  }

  body.appendChild(line);

  if (task.list !== "done" && task.stage === "waiting" && task.waitingOn) {
    body.appendChild(
      makeButton(
        `Waiting on ${task.waitingOn}${task.nextStep ? ` · ${task.nextStep}` : ""}`,
        "next-step-line is-waiting-line",
        () => {
          editingStage = { id: task.id, mode: "waiting" };
          pendingFocusTarget = { taskId: task.id, key: "stage-input" };
          renderLists();
        }
      )
    );
  } else if (task.list !== "done" && task.nextStep) {
    body.appendChild(
      makeButton(
        `→ ${task.nextStep}`,
        "next-step-line",
        () => {
          editingStage = { id: task.id, mode: "started" };
          pendingFocusTarget = { taskId: task.id, key: "stage-input" };
          renderLists();
        },
        { title: "Click to edit next step" }
      )
    );
  }

  const actions = document.createElement("div");
  actions.className = "task-actions";

  if (task.list !== "done") {
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = "inline-date-input";
    dateInput.dataset.focusKey = "date";
    dateInput.value = task.dueDate || "";
    dateInput.title = "Change deadline";
    dateInput.setAttribute("aria-label", `Deadline for ${task.title}`);
    let dateCommitted = false;
    const commitDate = () => {
      if (dateCommitted || !dateInput.isConnected) return;
      const nextVal = dateInput.value || "";
      if (nextVal !== (task.dueDate || "")) {
        dateCommitted = true;
        updateTask(task.id, { dueDate: nextVal });
      }
    };
    dateInput.addEventListener("blur", commitDate);
    dateInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitDate();
      } else if (e.key === "Escape") {
        dateCommitted = true;
        dateInput.value = task.dueDate || "";
        dateInput.blur();
      }
    });
    actions.appendChild(dateInput);

    if (task.stage !== "waiting") {
      actions.appendChild(
        makeButton(
          context === "today" ? "Later" : "→ Today",
          "row-btn",
          () => updateTask(task.id, { list: context === "today" ? "later" : "today" }),
          { "data-focus-key": "move" }
        )
      );
    }
  }

  const isExpanded = expandedTaskId === task.id;
  const hasDetailContent = (task.subtasks && task.subtasks.length > 0) || Boolean(task.notes && task.notes.trim());
  if (task.list !== "done" || hasDetailContent) {
    actions.appendChild(
      makeButton(
        isExpanded ? "▾" : "▸",
        "row-btn",
        () => toggleExpandTask(task),
        {
          title: "Steps & notes (E)",
          "aria-label": `${isExpanded ? "Collapse" : "Expand"} steps and notes for "${task.title}"`,
          "aria-expanded": String(isExpanded),
          "data-focus-key": "detail",
        }
      )
    );
  }

  actions.appendChild(
    makeButton("×", "row-btn del", () => deleteTask(task.id), {
      "aria-label": `Delete "${task.title}"`,
      "data-focus-key": "del",
    })
  );

  mainRow.appendChild(body);
  mainRow.appendChild(actions);
  li.appendChild(mainRow);

  // Quiet inline stale check (14+ days untouched) — no badge clutter on row
  if (freshness.isStale && !(editingStage && editingStage.id === task.id)) {
    const staleBar = document.createElement("div");
    staleBar.className = "stale-bar";
    const age = document.createElement("span");
    age.textContent = `Untouched ${freshness.daysUntouched}d:`;
    staleBar.appendChild(age);
    appendFreshnessButtons(staleBar, task, { keepCls: "stale-btn", btnCls: "stale-btn", dropCls: "stale-btn is-drop" });
    li.appendChild(staleBar);
  }

  if (editingStage && editingStage.id === task.id && task.list !== "done") {
    li.appendChild(buildStageEditor(task));
  }

  if (isExpanded) {
    li.appendChild(buildTaskDetail(task));
  }

  return li;
}

function renderSwapPrompt(todayTasks) {
  const el = document.getElementById("today-swap-prompt");
  if (!pendingSwap || todayTasks.length < TODAY_CAP) {
    pendingSwap = null;
    el.classList.add("hidden");
    return;
  }
  el.innerHTML = "";
  const label = document.createElement("span");
  label.className = "swap-prompt-label";
  label.textContent = `Today is full (${todayTasks.length}/${TODAY_CAP}). Swap out:`;
  el.appendChild(label);

  todayTasks.forEach((t) => {
    const shortTitle = t.title.length > 26 ? `${t.title.slice(0, 24)}…` : t.title;
    el.appendChild(makeButton(shortTitle, "banner-btn", () => executeSwap(t.id)));
  });

  el.appendChild(
    makeButton(pendingSwap.kind === "add" ? "Add to Later" : "Cancel", "row-btn", () => {
      const info = pendingSwap;
      pendingSwap = null;
      if (info.kind === "add") addTask(info.title, info.dueDate, false, false, info.area || "work");
      else renderLists();
    })
  );

  el.appendChild(
    makeButton("Add anyway", "row-btn", () => {
      const info = pendingSwap;
      pendingSwap = null;
      if (info.kind === "add") addTask(info.title, info.dueDate, true, true, info.area || "work");
      else updateTask(info.taskId, { list: "today" }, { forceToday: true });
    })
  );

  el.classList.remove("hidden");
}

function renderLists() {
  const focusedEl = document.activeElement;
  const focusedTaskId = focusedEl?.closest?.("[data-task-id]")?.dataset?.taskId || null;
  const focusedKey = focusedEl?.dataset?.focusKey || null;

  const allActive = activeTasks();
  const visibleActive = allActive.filter(matchesSearch);
  const todayTasks = sortTasksByUrgency(visibleActive.filter((t) => t.list === "today"));
  const waitingTasks = sortTasksByUrgency(visibleActive.filter((t) => t.list === "later" && t.stage === "waiting"));
  const allLaterTasks = sortTasksByUrgency(visibleActive.filter((t) => t.list === "later" && t.stage !== "waiting"));
  const doneTasks = visibleActive
    .filter((t) => t.list === "done")
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));

  const visibleLater = allLaterTasks.filter((t) => {
    if (laterFilter === "dated") return Boolean(parseDateKey(t.dueDate));
    if (laterFilter === "flexible") return !parseDateKey(t.dueDate);
    return true;
  });

  // Today
  const allToday = todayActiveList();
  renderSwapPrompt(allToday);
  const todayListEl = document.getElementById("today-list");
  todayListEl.innerHTML = "";
  todayTasks.forEach((t) => todayListEl.appendChild(buildTaskRow(t, "today")));
  document.getElementById("today-count").textContent = `${allToday.length}/${TODAY_CAP}`;
  const todayEmptyEl = document.getElementById("today-empty");
  todayEmptyEl.classList.toggle("hidden", todayTasks.length > 0);
  todayEmptyEl.textContent = searchQuery && allToday.length > 0 ? "No matching tasks in Today." : "Nothing set for today.";
  document.getElementById("end-day-btn").classList.toggle(
    "hidden",
    !allActive.some((t) => t.list !== "done" && t.stage === "started")
  );

  const nudge = document.getElementById("focus-nudge");
  if (allToday.length > TODAY_CAP) {
    nudge.textContent = `${allToday.length} in focus — trim to ${TODAY_CAP}?`;
    nudge.classList.add("is-heavy");
  } else {
    nudge.textContent = `1–${TODAY_CAP} focus items`;
    nudge.classList.remove("is-heavy");
  }

  // Later
  const laterListEl = document.getElementById("later-list");
  laterListEl.innerHTML = "";
  visibleLater.forEach((t) => laterListEl.appendChild(buildTaskRow(t, "later")));
  document.getElementById("later-count").textContent =
    laterFilter === "all" ? String(allLaterTasks.length) : `${visibleLater.length}/${allLaterTasks.length}`;

  const laterEmptyEl = document.getElementById("later-empty");
  laterEmptyEl.classList.toggle("hidden", visibleLater.length > 0);
  if (visibleLater.length === 0) {
    laterEmptyEl.textContent =
      laterFilter === "dated"
        ? "No dated tasks in Later."
        : laterFilter === "flexible"
        ? "No undated tasks in Later."
        : "Nothing waiting in Later.";
  }

  // Waiting On (tucked inside Later)
  const waitSection = document.getElementById("waiting-section");
  const waitListEl = document.getElementById("waiting-list");
  const waitToggle = document.getElementById("waiting-toggle");
  waitSection.classList.toggle("hidden", waitingTasks.length === 0);
  document.getElementById("waiting-toggle-label").textContent = `◷ Waiting on (${waitingTasks.length})`;
  document.getElementById("waiting-chevron").textContent = waitingExpanded ? "▾" : "▸";
  waitToggle.setAttribute("aria-expanded", String(waitingExpanded));
  waitListEl.classList.toggle("hidden", !waitingExpanded);
  waitListEl.innerHTML = "";
  if (waitingExpanded) waitingTasks.forEach((t) => waitListEl.appendChild(buildTaskRow(t, "later")));

  // Done
  const doneListEl = document.getElementById("done-list");
  doneListEl.innerHTML = "";
  (showAllDone ? doneTasks : doneTasks.slice(0, 12)).forEach((t) => doneListEl.appendChild(buildTaskRow(t, "done")));

  const moreBtn = document.getElementById("done-more-btn");
  if (doneTasks.length > 12) {
    moreBtn.classList.remove("hidden");
    moreBtn.textContent = showAllDone ? "Show fewer" : `Show ${doneTasks.length - 12} more completed`;
  } else {
    moreBtn.classList.add("hidden");
  }

  const momentum = getWeeklyMomentum(allActive);
  document.getElementById("wins-week-badge").textContent =
    momentum.stepsDone > 0
      ? `${momentum.tasksDone} done · ${momentum.stepsDone} step${momentum.stepsDone === 1 ? "" : "s"} this week`
      : `${momentum.tasksDone} this week`;
  document.getElementById("done-empty").classList.toggle("hidden", doneTasks.length > 0);
  document.getElementById("clear-done-btn").classList.toggle("hidden", doneTasks.length === 0);

  // Focus one exact requested control (never steals focus from other rows), else restore prior control
  const requested = pendingFocusTarget;
  pendingFocusTarget = null;
  if (requested) {
    const target = document.querySelector(
      `[data-task-id="${CSS.escape(requested.taskId)}"] [data-focus-key="${CSS.escape(requested.key)}"]`
    );
    if (target) {
      target.focus();
      if (requested.key === "title-input" && typeof target.select === "function") target.select();
    }
  } else if (focusedTaskId && focusedKey) {
    const target = document.querySelector(
      `[data-task-id="${CSS.escape(focusedTaskId)}"] [data-focus-key="${CSS.escape(focusedKey)}"]`
    );
    if (target) target.focus();
  }
}

function renderAll() {
  const todayKey = toDateKey(new Date());
  if (todayKey !== lastRenderedDateKey && checkinMode === "hidden") {
    checkinMode = "auto";
  }
  lastRenderedDateKey = todayKey;
  renderHeader();
  renderCheckin();
  renderTimeline();
  renderLists();
}

// ============================================================================
// 6. Export / Import (Merge by Default)
// ============================================================================

function exportJson() {
  const doc = serializeTaskDocument(tasks, DEVICE_ID);
  const blob = new Blob([JSON.stringify(doc, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `horizon-tasks-${toDateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  savePrefs({ lastExportAt: Date.now() });
  if (!undoEntry?.delta) showToast("Exported tasks.json — move into OneDrive to sync.");
}

function importJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = parseTaskDocument(JSON.parse(String(reader.result)));
      const beforeById = new Map(tasks.map((t) => [t.id, cloneTask(t)]));
      const merged = mergeTaskLists(tasks, parsed.tasks);

      // Track only tasks actually added or modified by this import for safe targeted Undo
      const delta = new Map();
      merged.forEach((t) => {
        const prev = beforeById.get(t.id) || null;
        if (!prev || prev.updatedAt !== t.updatedAt) delta.set(t.id, prev);
      });

      tasks = merged;
      safeLocalSet(SAMPLE_FLAG_KEY, "1");
      await persistState();
      // Data just came from a file, so don't immediately nag to export it back
      savePrefs({ lastExportAt: Date.now() });
      renderAll();
      showToast(
        `Merged ${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"} from ${file.name}`,
        delta.size > 0 ? delta : null
      );
    } catch {
      showBanner("That file doesn't look like a valid Horizon tasks.json file.", [{ label: "Dismiss", onClick: hideBanner }], true);
    }
  };
  reader.readAsText(file);
}

// ============================================================================
// 7. Lifecycle, Midnight Refresh & Event Wiring
// ============================================================================

async function init() {
  await loadInitialTasks();
  renderAll();

  const form = document.getElementById("add-task-form");
  const titleInput = document.getElementById("task-title-input");
  const dateInput = document.getElementById("task-date-input");
  const todayInput = document.getElementById("task-today-input");
  const areaBtn = document.getElementById("capture-area-btn");
  const searchBar = document.getElementById("search-bar");
  const searchInput = document.getElementById("search-input");

  const resolveQuickDate = (kind) => {
    const now = new Date();
    if (kind === "tomorrow") return addDaysKey(now, 1);
    if (kind === "+1w") return addDaysKey(now, 7);
    if (kind === "next-mon") return getNextWeekdayKey(1, now);
    if (kind === "+1m") return addDaysKey(now, 30);
    return "";
  };

  const syncChipHighlights = () => {
    document.querySelectorAll("[data-quick-date]").forEach((btn) => {
      const target = resolveQuickDate(btn.dataset.quickDate);
      btn.classList.toggle("is-active", Boolean(dateInput.value) && dateInput.value === target);
    });
    areaBtn.textContent = captureArea === "personal" ? "Personal" : "Work";
    areaBtn.classList.toggle("is-personal", captureArea === "personal");
  };

  document.querySelectorAll("[data-quick-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = resolveQuickDate(btn.dataset.quickDate);
      dateInput.value = dateInput.value === target ? "" : target;
      syncChipHighlights();
      titleInput.focus();
    });
  });

  dateInput.addEventListener("change", syncChipHighlights);

  areaBtn.addEventListener("click", () => {
    captureArea = captureArea === "work" ? "personal" : "work";
    savePrefs({ captureArea });
    syncChipHighlights();
    titleInput.focus();
  });
  syncChipHighlights();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const parsed = parseQuickCapture(titleInput.value);
    const finalTitle = parsed.title;
    if (!finalTitle) return;
    const finalDue = dateInput.value || parsed.dueDate || "";
    const finalToday = todayInput.checked || parsed.list === "today";
    const finalArea = parsed.area || captureArea;

    await addTask(finalTitle, finalDue, finalToday, false, finalArea);
    titleInput.value = "";
    dateInput.value = "";
    todayInput.checked = false;
    syncChipHighlights();
    titleInput.focus();
  });

  document.getElementById("checkin-open-btn").addEventListener("click", startCheckinCards);
  document.getElementById("end-day-btn").addEventListener("click", () => runEndDayRitual(false));

  const closeSearch = () => {
    searchQuery = "";
    searchInput.value = "";
    searchBar.classList.add("hidden");
    renderAll();
  };
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderTimeline();
    renderLists();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch();
  });
  document.getElementById("search-clear-btn").addEventListener("click", closeSearch);

  document.getElementById("storage-tag").addEventListener("click", () => {
    if (syncState === "error") {
      if (useServerApi) loadFromServer({ merge: hasLoadedServer }).then((ok) => ok && renderAll());
      else writeLinkedFileQueued();
    } else if (!useServerApi && !linkedFileHandle) {
      exportJson();
    }
  });

  document.getElementById("reconnect-file-btn").addEventListener("click", reconnectSavedFile);
  document.getElementById("link-file-btn").addEventListener("click", () => pickAndLinkFile("open"));
  document.getElementById("new-file-btn").addEventListener("click", () => pickAndLinkFile("save"));
  document.getElementById("clear-samples-btn").addEventListener("click", clearSamples);
  document.getElementById("clear-done-btn").addEventListener("click", clearCompleted);
  document.getElementById("export-btn").addEventListener("click", exportJson);

  const importInput = document.getElementById("import-input");
  document.getElementById("import-btn").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", (e) => {
    importJson(e.target.files[0]);
    e.target.value = "";
  });

  document.getElementById("waiting-toggle").addEventListener("click", () => {
    waitingExpanded = !waitingExpanded;
    savePrefs({ waitingExpanded });
    renderLists();
  });

  document.getElementById("done-more-btn").addEventListener("click", () => {
    showAllDone = !showAllDone;
    renderLists();
  });

  document.getElementById("toast-undo-btn").addEventListener("click", performUndo);
  document.getElementById("toast-close-btn").addEventListener("click", () => {
    document.getElementById("toast").classList.add("hidden");
  });

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === laterFilter);
    btn.addEventListener("click", () => {
      laterFilter = btn.dataset.filter;
      savePrefs({ laterFilter });
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderLists();
    });
  });

  document.addEventListener("keydown", (e) => {
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName;
    const inTextInput =
      tag === "TEXTAREA" ||
      (tag === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(activeEl.type));
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inTextInput && undoEntry?.delta) {
      e.preventDefault();
      performUndo();
      return;
    }
    if (inTextInput || e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if (key === "n") {
      e.preventDefault();
      titleInput.focus();
    } else if (e.key === "/") {
      e.preventDefault();
      searchBar.classList.remove("hidden");
      searchInput.focus();
    } else if (key === "s") {
      const focusedTaskId = document.activeElement?.closest?.("[data-task-id]")?.dataset?.taskId;
      if (focusedTaskId) {
        const t = activeTasks().find((item) => item.id === focusedTaskId && item.list !== "done");
        if (t) {
          e.preventDefault();
          editingStage = { id: t.id, mode: "started" };
          pendingFocusTarget = { taskId: t.id, key: "stage-input" };
          if (t.stage !== "started") updateTask(t.id, { stage: "started" });
          else renderLists();
        }
      }
    } else if (key === "e") {
      const focusedTaskId = document.activeElement?.closest?.("[data-task-id]")?.dataset?.taskId;
      if (focusedTaskId) {
        const t = activeTasks().find((item) => item.id === focusedTaskId);
        if (t) {
          e.preventDefault();
          toggleExpandTask(t);
        }
      }
    }
  });

  setInterval(() => {
    if (toDateKey(new Date()) !== lastRenderedDateKey) renderAll();
  }, 60000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (toDateKey(new Date()) !== lastRenderedDateKey) renderAll();
      syncFromExternalChange();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
