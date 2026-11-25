/**
 * app.js — "The Front Counter"
 * Works in three storage modes automatically:
 * 1. Python local server (http://): saves directly to tasks.json via /api/tasks.
 * 2. Browser Direct File Access (Edge/Chrome, no Python): click "Open file" or "New file"
 *    to auto-save straight to a real tasks.json file on your PC or OneDrive (persisted in IndexedDB).
 * 3. Browser localStorage fallback: always keeps a backup copy even with zero setup.
 */

const STORAGE_KEY = "horizon_tasks_v1";
const SAMPLE_FLAG_KEY = "horizon_samples_dismissed_v1";
const HORIZON_ZOOM_KEY = "horizon_zoom_days_v1";
const LAST_SYNC_MTIME_KEY = "horizon_last_sync_mtime_v1";
const LOCAL_DIRTY_KEY = "horizon_local_dirty_v1";

const IDB_NAME = "horizon_tasks_db";
const IDB_STORE = "handles";
const IDB_HANDLE_KEY = "linkedFile";

const MAX_UNDO_STEPS = 15;
const MTIME_TOLERANCE_MS = 50;
const UNDO_COALESCE_MS = 1500;
const RECURRENCE_OPTIONS = [
  { value: "", label: "None" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

let tasks = [];
let inboxFilter = "all"; // "all" | "dated" | "flexible"
let searchQuery = "";
let activeTag = null;
let horizonDays = loadSavedHorizonDays();
let expandedTaskId = null;
let showAllTimeline = false;
let showAllDone = false;
let focusSubtaskInputTaskId = null;

let useServerApi =
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "localhost";

let linkedFileHandle = null; // Active FileSystemFileHandle with readwrite permission
let pendingReconnectHandle = null; // Saved handle waiting on 1-click user permission prompt
let lastKnownFileMtime = null;
let lastKnownServerMtime = null;
let isWritingFile = false;
let fileWritePromise = null;
let fileWritePending = false;
let fileWritePendingForce = false;

let mutationQueue = Promise.resolve();
let inFlightMutations = 0;
let mutationEpoch = 0;

let conflictState = null; // null | { mode: "file" | "server", filename?: string, retryAction?: Function }
let pendingImport = null; // null | { tasks: Array, filename: string }

const undoStack = []; // [{ tasks, label, key, ts }]
let toastTimer = null;
let lastRenderedDateKey = toDateKey(new Date());
let isPointerDown = false;

function enqueueMutation(fn) {
  const run = async () => {
    inFlightMutations += 1;
    mutationEpoch += 1;
    try {
      return await fn();
    } finally {
      mutationEpoch += 1;
      inFlightMutations -= 1;
    }
  };
  const next = mutationQueue.then(run, run);
  mutationQueue = next.catch(() => {});
  return next;
}

function getSavedSyncMtime() {
  try {
    const raw = localStorage.getItem(LAST_SYNC_MTIME_KEY);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}

function setSavedSyncMtime(mtime) {
  try {
    if (mtime !== null && mtime !== undefined && Number.isFinite(Number(mtime))) {
      localStorage.setItem(LAST_SYNC_MTIME_KEY, String(Number(mtime)));
    } else {
      localStorage.removeItem(LAST_SYNC_MTIME_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function isLocalDirty() {
  try {
    return localStorage.getItem(LOCAL_DIRTY_KEY) === "1";
  } catch {
    return false;
  }
}

function setLocalDirty(flag) {
  try {
    if (flag) localStorage.setItem(LOCAL_DIRTY_KEY, "1");
    else localStorage.removeItem(LOCAL_DIRTY_KEY);
  } catch {
    // ignore storage errors
  }
}

function handleServerNetworkError(err, actionName = "save changes") {
  console.warn(`Server error while attempting to ${actionName}:`, err);
  renderAll();
  const isHttpErr = err && typeof err.message === "string" && err.message.startsWith("HTTP ");
  const msg = isHttpErr
    ? `Could not ${actionName} (${err.message})`
    : "Could not reach Python server — is start.bat running?";
  showToast(msg, { duration: 5000 });
}

function loadSavedHorizonDays() {
  try {
    return parseHorizonDays(localStorage.getItem(HORIZON_ZOOM_KEY), HORIZON_DAYS);
  } catch {
    // ignore storage access issues
  }
  return HORIZON_DAYS;
}

function setHorizonDays(rawValue) {
  const nextDays = parseHorizonDays(rawValue, horizonDays);
  const changed = nextDays !== horizonDays;
  horizonDays = nextDays;
  const inputEl = document.getElementById("horizon-days-input");
  if (inputEl) {
    inputEl.value = String(horizonDays);
  }
  if (changed) {
    try {
      localStorage.setItem(HORIZON_ZOOM_KEY, String(horizonDays));
    } catch {
      // ignore storage errors
    }
    renderTimeline();
    renderLists();
  }
}

function setHorizonMenuOpen(open) {
  const menu = document.getElementById("horizon-preset-menu");
  const toggle = document.getElementById("horizon-preset-toggle");
  const input = document.getElementById("horizon-days-input");
  if (!menu || !toggle || !input) return;
  const isOpen = Boolean(open);
  menu.classList.toggle("hidden", !isOpen);
  toggle.setAttribute("aria-expanded", String(isOpen));
  input.setAttribute("aria-expanded", String(isOpen));
}

function isHorizonMenuOpen() {
  const menu = document.getElementById("horizon-preset-menu");
  return Boolean(menu && !menu.classList.contains("hidden"));
}

function extractSafeUrls(notesText) {
  if (!notesText || typeof notesText !== "string") return [];
  const matches = notesText.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const seen = new Set();
  const urls = [];
  matches.forEach((raw) => {
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    try {
      const u = new URL(cleaned);
      if ((u.protocol === "http:" || u.protocol === "https:") && !seen.has(u.href)) {
        seen.add(u.href);
        urls.push({ href: u.href, label: cleaned });
      }
    } catch {
      // ignore malformed URLs
    }
  });
  return urls;
}

function cloneTasks(list) {
  return JSON.parse(JSON.stringify(list));
}

function scheduleBlurCommit(commitFn) {
  if (!isPointerDown) {
    commitFn();
    return;
  }
  let ran = false;
  const runOnce = () => {
    if (ran) return;
    ran = true;
    window.removeEventListener("click", runOnce, true);
    setTimeout(commitFn, 0);
  };
  window.addEventListener("click", runOnce, true);
  setTimeout(runOnce, 240);
}

// --- Sample Tasks (for first-time offline / portable launch) ---

function addDaysKey(daysFromToday) {
  return addDaysToKey(toDateKey(new Date()), daysFromToday);
}

function createSampleTasks() {
  const now = Date.now();
  return normalizeTaskList([
    {
      id: "sample-1",
      title: "Pay electricity bill #home",
      dueDate: addDaysKey(2),
      status: "today",
      previousStatus: "today",
      notes: "Autopay is off. Account number is on the paper statement.",
      subtasks: [],
      recurrence: "monthly",
      recurrenceSpawnedId: null,
      createdAt: now - 4000,
      updatedAt: now - 4000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-2",
      title: "Book dentist checkup #health",
      dueDate: addDaysKey(11),
      status: "inbox",
      previousStatus: "inbox",
      notes: "Ask about the cleaning slot after 3pm. Bring insurance card.",
      subtasks: [
        { id: "st-sample-2a", text: "Check insurance coverage", done: true },
        { id: "st-sample-2b", text: "Call the clinic", done: false },
        { id: "st-sample-2c", text: "Add appointment to calendar", done: false },
      ],
      recurrence: "quarterly",
      recurrenceSpawnedId: null,
      createdAt: now - 3000,
      updatedAt: now - 3000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-3",
      title: "Renew car insurance #home",
      dueDate: addDaysKey(34),
      status: "inbox",
      previousStatus: "inbox",
      notes: "Compare at least two quotes before renewing.",
      subtasks: [
        { id: "st-sample-3a", text: "Get two competing quotes", done: false },
        { id: "st-sample-3b", text: "Renew online", done: false },
      ],
      recurrence: "yearly",
      recurrenceSpawnedId: null,
      createdAt: now - 2000,
      updatedAt: now - 2000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-4",
      title: "Plan spring trip & flights",
      dueDate: addDaysKey(74),
      status: "inbox",
      previousStatus: "inbox",
      notes: "",
      subtasks: [],
      recurrence: "",
      recurrenceSpawnedId: null,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-5",
      title: "Clean up Downloads folder",
      dueDate: "",
      status: "inbox",
      previousStatus: "inbox",
      notes: "",
      subtasks: [],
      recurrence: "",
      recurrenceSpawnedId: null,
      createdAt: now - 500,
      updatedAt: now - 500,
      completedAt: null,
      isSample: true,
    },
  ]);
}

// --- IndexedDB Handle Persistence ---

function openHandlesDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandleToIdb(handle) {
  try {
    const db = await openHandlesDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, IDB_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("Could not persist file handle in IndexedDB:", err);
  }
}

async function loadHandleFromIdb() {
  try {
    const db = await openHandlesDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const getReq = tx.objectStore(IDB_STORE).get(IDB_HANDLE_KEY);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => reject(getReq.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

// --- Toast & Undo Stack ---

function pushUndoSnapshot(snapshotTasks, label, coalesceKey = null) {
  const now = Date.now();
  const top = undoStack[undoStack.length - 1];
  if (coalesceKey && top && top.key === coalesceKey && now - top.ts < UNDO_COALESCE_MS) {
    top.label = label;
    top.ts = now;
    return;
  }
  undoStack.push({ tasks: snapshotTasks, label, key: coalesceKey, ts: now });
  if (undoStack.length > MAX_UNDO_STEPS) {
    undoStack.shift();
  }
}

function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  document.getElementById("undo-toast").classList.add("hidden");
}

function showToast(message, { showUndo = false, duration = 6000 } = {}) {
  const toastEl = document.getElementById("undo-toast");
  const msgEl = document.getElementById("toast-msg");
  const undoBtn = document.getElementById("toast-undo-btn");

  msgEl.textContent = message;
  undoBtn.classList.toggle("hidden", !(showUndo && undoStack.length > 0));
  toastEl.classList.remove("hidden");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
    toastTimer = null;
  }, duration);
}

async function serverMutate(url, { method = "POST", body = null, force = false, actionName = "save changes" } = {}) {
  let reqUrl = url;
  const fetchOptions = { method };

  if (method === "DELETE") {
    const params = new URLSearchParams();
    if (lastKnownServerMtime !== null && !force) {
      params.set("expectedMtimeMs", String(lastKnownServerMtime));
    }
    if (force) params.set("force", "true");
    const qs = params.toString();
    if (qs) reqUrl = `${url}${url.includes("?") ? "&" : "?"}${qs}`;
  } else {
    const payload = body && typeof body === "object" ? { ...body } : {};
    if (lastKnownServerMtime !== null && !force) {
      payload.expectedMtimeMs = lastKnownServerMtime;
    }
    if (force) payload.force = true;
    fetchOptions.body = JSON.stringify(payload);
  }

  try {
    const data = await apiRequest(reqUrl, fetchOptions);
    if (Array.isArray(data.tasks)) {
      tasks = normalizeTaskList(data.tasks);
    }
    if (data.mtimeMs !== undefined) {
      lastKnownServerMtime = data.mtimeMs;
    }
    saveLocalBackup();
    hideConflictBanner();
    return { ok: true, data };
  } catch (err) {
    if (err && err.status === 409) {
      return { ok: false, conflict: true, status: 409, error: err };
    }
    handleServerNetworkError(err, actionName);
    return { ok: false, conflict: false, status: (err && err.status) || 0, error: err };
  }
}

async function performUndo({ force = false } = {}) {
  return enqueueMutation(async () => {
    if (undoStack.length === 0) return { ok: false };
    const entry = undoStack.pop();
    const restored = normalizeTaskList(entry.tasks);

    if (useServerApi) {
      const res = await serverMutate("/api/tasks/restore", {
        method: "POST",
        body: { tasks: restored },
        force,
        actionName: "undo",
      });
      if (!res.ok) {
        undoStack.push(entry);
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", () => performUndo({ force: true }));
        }
        return res;
      }
    } else {
      tasks = restored;
      const persisted = await persistOffline();
      if (persisted) {
        hideConflictBanner();
      }
    }
    renderAll();
    showToast(`Undid: ${entry.label}`, {
      showUndo: undoStack.length > 0,
      duration: 3500,
    });
    return { ok: true };
  });
}

// --- External Sync Conflict Banner ---

function showConflictBanner(mode, filename = "tasks.json", retryAction = null) {
  conflictState = { mode, filename, retryAction };
  const banner = document.getElementById("conflict-banner");
  const textEl = document.getElementById("conflict-banner-text");
  const overwriteBtn = document.getElementById("conflict-overwrite-btn");

  textEl.textContent = `${filename || "tasks.json"} changed outside this tab`;
  overwriteBtn.textContent =
    mode === "server" ? "Overwrite with mine" : "Keep my version & overwrite";
  banner.classList.remove("hidden");
}

function hideConflictBanner() {
  conflictState = null;
  document.getElementById("conflict-banner").classList.add("hidden");
}

async function reloadFromExternalSource() {
  if (useServerApi) {
    try {
      const data = await apiRequest("/api/tasks");
      tasks = normalizeTaskList(data.tasks);
      if (data.mtimeMs !== undefined) lastKnownServerMtime = data.mtimeMs;
      saveLocalBackup();
      hideConflictBanner();
      renderAll();
      showToast("Reloaded latest tasks from disk", { duration: 3000 });
    } catch (err) {
      handleServerNetworkError(err, "reload tasks");
    }
    return;
  }

  if (linkedFileHandle) {
    try {
      const file = await linkedFileHandle.getFile();
      const text = await file.text();
      const parsed = text.trim() ? JSON.parse(text) : [];
      if (!Array.isArray(parsed)) {
        alert("The external file is no longer a valid JSON task list.");
        return;
      }
      tasks = normalizeTaskList(parsed);
      lastKnownFileMtime = file.lastModified;
      setSavedSyncMtime(file.lastModified);
      setLocalDirty(false);
      saveLocalBackup();
      hideConflictBanner();
      renderAll();
      showToast(`Reloaded ${linkedFileHandle.name}`, { duration: 3000 });
    } catch (err) {
      console.warn("Could not reload linked file:", err);
      showToast(`Could not reload ${linkedFileHandle.name}`, { duration: 4000 });
    }
  }
}

async function overwriteExternalWithMine() {
  const pendingRetry = conflictState && conflictState.retryAction;
  if (useServerApi) {
    if (pendingRetry) {
      const res = await pendingRetry();
      if (res === true || (res && res.ok)) {
        hideConflictBanner();
        showToast("Saved your changes to disk", { duration: 3000 });
        return;
      }
      // Only fall through to full restore when the target task vanished externally (404).
      // For network / 5xx errors, pendingRetry already displayed an error toast.
      if (!res || res.status !== 404) {
        return;
      }
    }
    const res = await enqueueMutation(() =>
      serverMutate("/api/tasks/restore", {
        method: "POST",
        body: { tasks },
        force: true,
        actionName: "overwrite server tasks",
      })
    );
    if (res.ok) {
      renderAll();
      showToast("Overwrote tasks.json with your version", { duration: 3000 });
    }
    return;
  }

  if (linkedFileHandle) {
    const ok = await writeLinkedFile({ force: true });
    if (ok) {
      hideConflictBanner();
      renderAll();
      showToast(`Overwrote ${linkedFileHandle.name} with your version`, { duration: 3000 });
    }
  }
}

async function checkExternalSyncDrift() {
  if (inFlightMutations > 0) return;

  if (useServerApi) {
    if (lastKnownServerMtime === null) return;
    const epochBefore = mutationEpoch;
    try {
      const data = await apiRequest("/api/tasks");
      if (
        inFlightMutations === 0 &&
        mutationEpoch === epochBefore &&
        data.mtimeMs !== undefined &&
        data.mtimeMs !== null &&
        Math.abs(data.mtimeMs - lastKnownServerMtime) > MTIME_TOLERANCE_MS
      ) {
        showConflictBanner("server", "tasks.json");
      }
    } catch {
      // ignore transient focus check failures
    }
    return;
  }

  if (linkedFileHandle && !isWritingFile && lastKnownFileMtime !== null) {
    const epochBefore = mutationEpoch;
    try {
      const currentFile = await linkedFileHandle.getFile();
      if (
        !isWritingFile &&
        mutationEpoch === epochBefore &&
        currentFile.lastModified !== lastKnownFileMtime
      ) {
        showConflictBanner("file", linkedFileHandle.name);
      }
    } catch {
      // ignore transient file handle access errors
    }
  }
}

// --- API / Direct File / Browser Storage Layer ---

function supportsDirectFileAccess() {
  return (
    typeof window.showOpenFilePicker === "function" &&
    typeof window.showSaveFilePicker === "function"
  );
}

function updateStorageIndicator() {
  const tag = document.getElementById("storage-tag");
  const openBtn = document.getElementById("link-file-btn");
  const newBtn = document.getElementById("new-file-btn");
  const reconnectBtn = document.getElementById("reconnect-file-btn");

  if (useServerApi) {
    tag.textContent = "tasks.json (Python)";
    tag.classList.add("is-linked");
    openBtn.classList.add("hidden");
    newBtn.classList.add("hidden");
    reconnectBtn.classList.add("hidden");
    return;
  }

  const canLink = supportsDirectFileAccess();
  openBtn.classList.toggle("hidden", !canLink);
  newBtn.classList.toggle("hidden", !canLink);

  if (linkedFileHandle) {
    tag.textContent = `${linkedFileHandle.name} (auto-saving)`;
    tag.title = "Every change automatically saves directly to this file on your PC.";
    tag.classList.add("is-linked");
    reconnectBtn.classList.add("hidden");
  } else if (pendingReconnectHandle) {
    tag.textContent = "browser storage";
    tag.title = "Click Reconnect to resume saving directly to your linked JSON file.";
    tag.classList.remove("is-linked");
    reconnectBtn.textContent = `Reconnect ${pendingReconnectHandle.name}`;
    reconnectBtn.classList.remove("hidden");
  } else {
    tag.textContent = "browser storage";
    tag.title = canLink
      ? "Click Open file or New file to auto-save directly to a real tasks.json file."
      : "Saved in browser storage. Use Export / Import to move tasks.json.";
    tag.classList.remove("is-linked");
    reconnectBtn.classList.add("hidden");
  }
}

async function apiRequest(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 409) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    const err = new Error("Conflict");
    err.status = 409;
    err.conflictData = payload;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function saveLocalBackup() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (err) {
    console.warn("Could not save to localStorage:", err);
  }
}

async function writeLinkedFileOnce({ force = false } = {}) {
  if (!linkedFileHandle) return false;
  try {
    if (!force && lastKnownFileMtime !== null) {
      const checkFile = await linkedFileHandle.getFile();
      if (checkFile.lastModified !== lastKnownFileMtime) {
        showConflictBanner("file", linkedFileHandle.name);
        return false;
      }
    }
    isWritingFile = true;
    const writable = await linkedFileHandle.createWritable();
    await writable.write(JSON.stringify(tasks, null, 2) + "\n");
    await writable.close();
    const updatedFile = await linkedFileHandle.getFile();
    lastKnownFileMtime = updatedFile.lastModified;
    setSavedSyncMtime(lastKnownFileMtime);
    setLocalDirty(false);
    isWritingFile = false;
    return true;
  } catch (err) {
    isWritingFile = false;
    console.warn("Could not write linked tasks.json file:", err);
    showToast(`Could not save to ${linkedFileHandle.name} — backup kept in browser`, {
      duration: 5000,
    });
    return false;
  }
}

async function writeLinkedFile({ force = false } = {}) {
  if (!linkedFileHandle) return false;
  if (fileWritePromise) {
    fileWritePending = true;
    fileWritePendingForce = fileWritePendingForce || force;
    return fileWritePromise;
  }
  const run = async (runForce) => {
    let ok = await writeLinkedFileOnce({ force: runForce });
    while (fileWritePending) {
      const nextForce = fileWritePendingForce;
      fileWritePending = false;
      fileWritePendingForce = false;
      ok = await writeLinkedFileOnce({ force: nextForce });
    }
    return ok;
  };
  fileWritePromise = run(force).finally(() => {
    fileWritePromise = null;
  });
  return fileWritePromise;
}

async function persistOffline() {
  saveLocalBackup();
  // Always mark dirty BEFORE writing so a failed write or conflict never loses browser edits on reload
  setLocalDirty(true);
  if (!linkedFileHandle) {
    return true;
  }
  return writeLinkedFile();
}

async function loadFromFileHandle(handle) {
  const file = await handle.getFile();
  const text = await file.text();
  const parsed = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid tasks JSON list");
  }
  linkedFileHandle = handle;
  pendingReconnectHandle = null;
  lastKnownFileMtime = file.lastModified;
  setSavedSyncMtime(file.lastModified);
  setLocalDirty(false);
  tasks = normalizeTaskList(parsed);
  localStorage.setItem(SAMPLE_FLAG_KEY, "1");
  saveLocalBackup();
  hideConflictBanner();
  updateStorageIndicator();
}

async function linkExistingFile() {
  if (!supportsDirectFileAccess()) return;
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "JSON Tasks File", accept: { "application/json": [".json"] } }],
      multiple: false,
    });
    const preSnapshot = tasks.some((t) => !t.isSample) ? cloneTasks(tasks) : null;
    await loadFromFileHandle(handle);
    await saveHandleToIdb(handle);
    if (preSnapshot) {
      pushUndoSnapshot(preSnapshot, `Opened "${handle.name}"`);
    }
    renderAll();
    if (preSnapshot) {
      showToast(`Opened ${handle.name}`, { showUndo: true, duration: 5000 });
    }
  } catch (err) {
    if (err && err.message === "Invalid tasks JSON list") {
      alert("That file doesn't look like a Horizon tasks.json list.");
    } else if (err && err.name !== "AbortError") {
      alert("Direct file linking isn't allowed here — use Export / Import instead. Your tasks are still saved in the browser.");
    }
  }
}

async function createLinkedFile() {
  if (!supportsDirectFileAccess()) return;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "tasks.json",
      types: [{ description: "JSON Tasks File", accept: { "application/json": [".json"] } }],
    });
    linkedFileHandle = handle;
    pendingReconnectHandle = null;
    lastKnownFileMtime = null;
    await saveHandleToIdb(handle);
    await writeLinkedFile({ force: true });
    saveLocalBackup();
    hideConflictBanner();
    updateStorageIndicator();
  } catch (err) {
    if (err && err.name !== "AbortError") {
      alert("Direct file linking isn't allowed here — use Export / Import instead. Your tasks are still saved in the browser.");
    }
  }
}

async function reconnectSavedFile() {
  if (!pendingReconnectHandle) return;
  const handle = pendingReconnectHandle;
  const fileName = handle.name || "tasks.json";
  try {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      showToast(`Permission not granted for ${fileName}`, { duration: 4000 });
      return;
    }

    const diskFile = await handle.getFile();
    const savedMtime = getSavedSyncMtime();
    const dirty = isLocalDirty();

    if (dirty && savedMtime !== null && diskFile.lastModified === savedMtime) {
      // Only browser edits happened while disconnected: resume auto-save and push them to disk
      linkedFileHandle = handle;
      pendingReconnectHandle = null;
      lastKnownFileMtime = diskFile.lastModified;
      const ok = await writeLinkedFile({ force: true });
      updateStorageIndicator();
      renderAll();
      if (ok) {
        showToast(`Reconnected & saved local edits to ${fileName}`, { duration: 4000 });
      }
      return;
    }

    if (dirty) {
      // Both browser and disk may have diverged: keep user's session intact and offer conflict choice
      linkedFileHandle = handle;
      pendingReconnectHandle = null;
      lastKnownFileMtime = savedMtime;
      updateStorageIndicator();
      showConflictBanner("file", fileName);
      renderAll();
      return;
    }

    const preSnapshot = tasks.some((t) => !t.isSample) ? cloneTasks(tasks) : null;
    await loadFromFileHandle(handle);
    if (preSnapshot) {
      pushUndoSnapshot(preSnapshot, `Reconnected "${fileName}"`);
    }
    renderAll();
    showToast(`Reconnected ${fileName}`, { showUndo: Boolean(preSnapshot), duration: 4000 });
  } catch (err) {
    console.warn("Could not reconnect file handle:", err);
    showToast(`Could not reconnect ${fileName} — file may have moved or been deleted`, {
      duration: 5000,
    });
  }
}

function readLocalBackupTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeTaskList(parsed) : null;
  } catch {
    return null;
  }
}

async function loadInitialTasks() {
  if (useServerApi) {
    try {
      const data = await apiRequest("/api/tasks");
      tasks = normalizeTaskList(data.tasks);
      if (data.mtimeMs !== undefined) lastKnownServerMtime = data.mtimeMs;
      saveLocalBackup();
      document.getElementById("storage-tag").title =
        data.dataFile || "Saved directly to tasks.json";
      updateStorageIndicator();
      return;
    } catch (err) {
      console.warn("Python API unavailable, falling back to browser storage:", err);
      useServerApi = false;
    }
  }

  const localBackup = readLocalBackupTasks();

  // Offline mode: inspect IndexedDB for a previously linked file handle
  if (supportsDirectFileAccess()) {
    const savedHandle = await loadHandleFromIdb();
    if (savedHandle && typeof savedHandle.queryPermission === "function") {
      try {
        const perm = await savedHandle.queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
          if (isLocalDirty() && localBackup !== null) {
            // Browser holds edits that failed to write earlier: never silently overwrite them with disk
            tasks = localBackup;
            linkedFileHandle = savedHandle;
            pendingReconnectHandle = null;
            const savedMtime = getSavedSyncMtime();
            const diskFile = await savedHandle.getFile();
            if (savedMtime !== null && diskFile.lastModified === savedMtime) {
              lastKnownFileMtime = diskFile.lastModified;
              await writeLinkedFile({ force: true });
            } else {
              lastKnownFileMtime = savedMtime;
              showConflictBanner("file", savedHandle.name);
            }
            updateStorageIndicator();
            return;
          }
          await loadFromFileHandle(savedHandle);
          return;
        }
        if (perm === "prompt") {
          pendingReconnectHandle = savedHandle;
        }
      } catch {
        // ignore stale handle errors
      }
    }
  }

  if (localBackup !== null) {
    tasks = localBackup;
    updateStorageIndicator();
    return;
  }

  if (!localStorage.getItem(SAMPLE_FLAG_KEY)) {
    tasks = createSampleTasks();
    await persistOffline();
  } else {
    tasks = [];
  }
  updateStorageIndicator();
}

// --- Task Actions ---

async function addTask(rawTitle, explicitDueDate, explicitToday, { force = false } = {}) {
  return enqueueMutation(async () => {
    const parsed = parseQuickCapture(rawTitle, new Date());
    const cleanTitle = (parsed.title || "").trim();
    if (!cleanTitle) return { ok: false };

    // Preserve Do-Date vs Due-Date: undated Today tasks keep dueDate: ""
    const resolvedDate = explicitDueDate || parsed.dueDate || "";
    const putInToday = Boolean(explicitToday || parsed.putInToday);
    const snapshot = cloneTasks(tasks);
    const undoLabel = `Added "${cleanTitle}"`;

    if (useServerApi) {
      const res = await serverMutate("/api/tasks", {
        method: "POST",
        body: { title: cleanTitle, dueDate: resolvedDate, today: putInToday },
        force,
        actionName: "add task",
      });
      if (!res.ok) {
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", async () => {
            const retryRes = await addTask(rawTitle, explicitDueDate, explicitToday, { force: true });
            if (retryRes && retryRes.ok) {
              const titleInput = document.getElementById("task-title-input");
              const dateInput = document.getElementById("task-date-input");
              const todayInput = document.getElementById("task-today-input");
              if (titleInput.value === rawTitle) {
                titleInput.value = "";
                dateInput.value = "";
                todayInput.checked = false;
                syncQuickDatePills();
              }
            }
            return retryRes;
          });
        }
        return res;
      }
      pushUndoSnapshot(snapshot, undoLabel);
      renderAll();
      return { ok: true };
    }

    pushUndoSnapshot(snapshot, undoLabel);
    const now = Date.now();
    const initialStatus = putInToday ? "today" : "inbox";
    const newTask = normalizeTask({
      id: makeId("t"),
      title: cleanTitle,
      dueDate: resolvedDate,
      status: initialStatus,
      previousStatus: initialStatus,
      notes: "",
      subtasks: [],
      recurrence: "",
      recurrenceSpawnedId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    tasks.unshift(newTask);
    await persistOffline();
    renderAll();
    return { ok: true };
  });
}

async function updateTask(taskId, patch, options = {}) {
  return enqueueMutation(async () => {
    const existing = tasks.find((item) => item.id === taskId);
    if (!existing) return { ok: false, status: 404 };

    const isTransitionToDone = existing.status !== "done" && patch.status === "done";
    const isStatusMove =
      patch.status !== undefined &&
      patch.status !== "done" &&
      existing.status !== patch.status;
    const preActionSnapshot = cloneTasks(tasks);
    const patchFields = Object.keys(patch).sort().join(",");
    const undoLabel = options.undoLabel
      ? options.undoLabel
      : isTransitionToDone
        ? `Completed "${existing.title}"`
        : isStatusMove
          ? patch.status === "today"
            ? `Pulled "${existing.title}" into Today`
            : `Moved "${existing.title}" to Inbox`
          : `Updated "${existing.title}"`;
    const coalesceKey =
      isTransitionToDone || isStatusMove || options.toastMessage
        ? null
        : `${taskId}:${patchFields}`;

    let spawnedTask = null;

    if (useServerApi) {
      const res = await serverMutate(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: patch,
        force: Boolean(options.force),
        actionName: "update task",
      });
      if (!res.ok) {
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", () =>
            updateTask(taskId, patch, { ...options, force: true })
          );
          renderAll();
        }
        return res;
      }
      pushUndoSnapshot(preActionSnapshot, undoLabel, coalesceKey);
      spawnedTask = res.data && res.data.spawnedTask ? normalizeTask(res.data.spawnedTask) : null;
      renderAll();
    } else {
      const patched = applyTaskPatch(tasks, taskId, patch, new Date(), Date.now());
      if (!patched) return { ok: false, status: 404 };
      pushUndoSnapshot(preActionSnapshot, undoLabel, coalesceKey);
      tasks = patched.tasks;
      spawnedTask = patched.spawnedTask;
      await persistOffline();
      renderAll();
    }

    if (isTransitionToDone) {
      if (spawnedTask) {
        showToast(
          `Completed "${existing.title}" · Next (${spawnedTask.recurrence}) due ${formatShortDate(spawnedTask.dueDate)}`,
          { showUndo: true }
        );
      } else {
        showToast(undoLabel, { showUndo: true });
      }
    } else if (options.toastMessage) {
      showToast(options.toastMessage, { showUndo: true, duration: 4500 });
    } else if (isStatusMove) {
      showToast(undoLabel, { showUndo: true, duration: 4000 });
    }
    return { ok: true };
  });
}

async function toggleDone(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  const nextStatus =
    task.status === "done"
      ? task.previousStatus === "today"
        ? "today"
        : "inbox"
      : "done";
  await updateTask(taskId, { status: nextStatus });
}

async function deleteTask(taskId, { force = false } = {}) {
  return enqueueMutation(async () => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return { ok: false, status: 404 };
    const snapshot = cloneTasks(tasks);
    const label = `Deleted "${target.title}"`;

    if (useServerApi) {
      const res = await serverMutate(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        force,
        actionName: "delete task",
      });
      if (!res.ok) {
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", () =>
            deleteTask(taskId, { force: true })
          );
        }
        return res;
      }
      if (expandedTaskId === taskId) expandedTaskId = null;
      pushUndoSnapshot(snapshot, label);
    } else {
      if (expandedTaskId === taskId) expandedTaskId = null;
      pushUndoSnapshot(snapshot, label);
      tasks = tasks.filter((t) => t.id !== taskId);
      await persistOffline();
    }
    renderAll();
    showToast(label, { showUndo: true });
    return { ok: true };
  });
}

async function clearCompleted({ force = false } = {}) {
  return enqueueMutation(async () => {
    const doneCount = tasks.filter((t) => t.status === "done").length;
    if (doneCount === 0) return { ok: false };
    const snapshot = cloneTasks(tasks);
    const label = `Cleared ${doneCount} completed task${doneCount === 1 ? "" : "s"}`;

    if (useServerApi) {
      const res = await serverMutate("/api/tasks/clear-done", {
        method: "POST",
        body: {},
        force,
        actionName: "clear completed tasks",
      });
      if (!res.ok) {
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", () => clearCompleted({ force: true }));
        }
        return res;
      }
      pushUndoSnapshot(snapshot, label);
    } else {
      pushUndoSnapshot(snapshot, label);
      tasks = tasks.filter((t) => t.status !== "done");
      await persistOffline();
    }
    renderAll();
    showToast(label, { showUndo: true });
    return { ok: true };
  });
}

async function clearSamples({ force = false } = {}) {
  return enqueueMutation(async () => {
    if (!tasks.some((t) => t.isSample)) return { ok: false };
    const snapshot = cloneTasks(tasks);
    const label = "Cleared sample tasks";

    if (useServerApi) {
      const res = await serverMutate("/api/tasks/clear-samples", {
        method: "POST",
        body: {},
        force,
        actionName: "clear sample tasks",
      });
      if (!res.ok) {
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", () => clearSamples({ force: true }));
        }
        return res;
      }
      pushUndoSnapshot(snapshot, label);
    } else {
      pushUndoSnapshot(snapshot, label);
      tasks = tasks.filter((t) => !t.isSample);
      localStorage.setItem(SAMPLE_FLAG_KEY, "1");
      await persistOffline();
    }
    renderAll();
    showToast(label, { showUndo: true });
    return { ok: true };
  });
}

// --- Filtering & Search ---

function isFilterActive() {
  return Boolean(activeTag || searchQuery.trim());
}

function taskMatchesFilters(task) {
  if (activeTag) {
    const tags = new Set([
      ...extractTags(task.title),
      ...extractTags(task.notes),
    ]);
    if (!tags.has(activeTag)) return false;
  }

  const q = searchQuery.trim().toLowerCase();
  if (q) {
    const inTitle = (task.title || "").toLowerCase().includes(q);
    const inNotes = (task.notes || "").toLowerCase().includes(q);
    const inSubtasks =
      Array.isArray(task.subtasks) &&
      task.subtasks.some((s) => (s.text || "").toLowerCase().includes(q));
    if (!inTitle && !inNotes && !inSubtasks) return false;
  }

  return true;
}

function renderFilterBar() {
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("search-clear-btn");
  const tagChipsEl = document.getElementById("tag-chips");
  const clearFiltersBtn = document.getElementById("clear-filters-btn");

  if (searchInput.value !== searchQuery) {
    searchInput.value = searchQuery;
  }
  clearSearchBtn.classList.toggle("hidden", !searchQuery);

  const tags = getAllTags(tasks);
  const displayTags =
    activeTag && !tags.includes(activeTag) ? [activeTag, ...tags] : tags;

  tagChipsEl.replaceChildren();
  if (displayTags.length === 0) {
    tagChipsEl.classList.add("hidden");
  } else {
    tagChipsEl.classList.remove("hidden");
    displayTags.forEach((tag) => {
      const chip = document.createElement("button");
      chip.type = "button";
      const isActive = activeTag === tag;
      chip.className = `tag-chip${isActive ? " active" : ""}`;
      chip.dataset.tag = tag;
      chip.setAttribute("aria-pressed", String(isActive));
      chip.textContent = `#${tag}`;
      chip.title = isActive ? `Clear #${tag} filter` : `Filter by #${tag}`;
      chip.addEventListener("click", () => {
        activeTag = isActive ? null : tag;
        renderAll();
        const nextChip = document.querySelector(`.tag-chip[data-tag="${CSS.escape(tag)}"]`);
        if (nextChip) nextChip.focus();
      });
      tagChipsEl.appendChild(chip);
    });
  }

  clearFiltersBtn.classList.toggle("hidden", !isFilterActive());
}

// --- Rendering ---

function renderHeader() {
  const now = new Date();
  document.getElementById("today-label").textContent = now.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const hasSamples = tasks.some((t) => t.isSample);
  document.getElementById("clear-samples-btn").classList.toggle("hidden", !hasSamples);

  // Glanceable pinned-tab title (unfiltered active counts)
  let overdueCount = 0;
  let todayCount = 0;
  tasks.forEach((t) => {
    if (t.status === "done") return;
    if (t.status === "today") todayCount += 1;
    if (t.dueDate && daysUntil(t.dueDate, now) < 0) overdueCount += 1;
  });
  const parts = ["Horizon"];
  if (overdueCount > 0) parts.push(`${overdueCount} overdue`);
  if (todayCount > 0) parts.push(`${todayCount} today`);
  document.title = parts.join(" · ");
}

function snoozeTaskByDays(task, deltaDays) {
  const nextDate = addDaysToKey(toDateKey(new Date()), deltaDays);
  if (!nextDate) return;
  const label = `Snoozed "${task.title}" to ${formatShortDate(nextDate)}`;
  updateTask(task.id, { dueDate: nextDate }, { undoLabel: label, toastMessage: label });
}

function handleTimelineTaskClick(task) {
  if (task.status !== "today") {
    updateTask(task.id, { status: "today" });
    return;
  }
  expandedTaskId = expandedTaskId === task.id ? null : task.id;
  renderAll();
  if (expandedTaskId === task.id) {
    const rowEl = document.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`);
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}

function renderTimeline() {
  const monthsEl = document.getElementById("timeline-months");
  const gridEl = document.getElementById("timeline-grid");
  const lanesEl = document.getElementById("timeline-lanes");
  const beyondEl = document.getElementById("timeline-beyond");
  const overdueEl = document.getElementById("overdue-strip");
  const footEl = document.getElementById("timeline-foot");
  const moreBtn = document.getElementById("timeline-more-btn");

  document.getElementById("horizon-heading").textContent = getHorizonHeadingText(horizonDays);
  document.getElementById("legend-horizon-label").textContent = `${horizonDays}d`;

  const horizonInput = document.getElementById("horizon-days-input");
  if (horizonInput && document.activeElement !== horizonInput) {
    horizonInput.value = String(horizonDays);
  }
  document.querySelectorAll(".horizon-preset-option").forEach((opt) => {
    const isActive = Number(opt.dataset.horizon) === horizonDays;
    opt.classList.toggle("active", isActive);
    opt.setAttribute("aria-selected", String(isActive));
  });

  monthsEl.replaceChildren();
  gridEl.replaceChildren();
  lanesEl.replaceChildren();
  overdueEl.replaceChildren();

  const now = new Date();
  const todayStr = toDateKey(now);

  // Adaptive axis markers & vertical grid lines
  const { markers, gridLines } = getTimelineAxis(now, horizonDays);
  markers.forEach((m) => {
    const el = document.createElement("div");
    const cls = ["month-marker"];
    if (m.isToday) cls.push("is-today");
    else if (m.isAccent) cls.push("is-accent");
    else if (!m.isMajor) cls.push("is-minor");
    el.className = cls.join(" ");
    el.style.left = `${m.percent}%`;
    el.textContent = m.label;
    monthsEl.appendChild(el);
  });

  gridLines.forEach((g) => {
    const line = document.createElement("div");
    line.className = `grid-line${g.isMajor ? " is-major" : ""}`;
    line.style.left = `${g.percent}%`;
    gridEl.appendChild(line);
  });

  // Active tasks with a deadline OR currently in Today's Focus, filtered by search/#tag
  const timelineTasks = sortTasksByUrgency(
    tasks.filter(
      (t) =>
        t.status !== "done" &&
        (t.dueDate || t.status === "today") &&
        taskMatchesFilters(t)
    ),
    now
  );

  const overdueTasks = [];
  const upcomingTasks = [];
  const beyondHorizon = [];

  timelineTasks.forEach((t) => {
    const effectiveDate = t.dueDate || todayStr;
    const days = daysUntil(effectiveDate, now);
    if (days < 0) overdueTasks.push({ task: t, days, effectiveDate });
    else if (days <= horizonDays) upcomingTasks.push({ task: t, days, effectiveDate });
    else beyondHorizon.push({ task: t, days, effectiveDate });
  });

  document.getElementById("timeline-count").textContent = String(timelineTasks.length);

  // Overdue strip (with calm 1-click +1w snooze)
  if (overdueTasks.length > 0) {
    overdueEl.classList.remove("hidden");
    const label = document.createElement("span");
    label.className = "overdue-label";
    label.textContent = "Overdue";
    overdueEl.appendChild(label);

    overdueTasks.forEach(({ task, days }) => {
      const group = document.createElement("span");
      group.className = "overdue-chip-group";

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "overdue-chip";
      chip.textContent = `${task.title} (${formatDaysLabel(days)})`;
      chip.title =
        task.status === "today"
          ? "In Today's Focus — click to open task details"
          : "Click to pull into Today";
      chip.addEventListener("click", () => handleTimelineTaskClick(task));

      const snoozeBtn = document.createElement("button");
      snoozeBtn.type = "button";
      snoozeBtn.className = "overdue-snooze-btn";
      snoozeBtn.textContent = "+1w";
      snoozeBtn.title = `Snooze "${task.title}" +1 week from today`;
      snoozeBtn.setAttribute("aria-label", `Snooze "${task.title}" by 1 week`);
      snoozeBtn.addEventListener("click", () => snoozeTaskByDays(task, 7));

      group.appendChild(chip);
      group.appendChild(snoozeBtn);
      overdueEl.appendChild(group);
    });
  } else {
    overdueEl.classList.add("hidden");
  }

  // Beyond-horizon clickable chips
  beyondEl.replaceChildren();
  if (beyondHorizon.length > 0) {
    beyondEl.classList.remove("hidden");
    const beyondLabel = document.createElement("span");
    beyondLabel.className = "beyond-label";
    beyondLabel.textContent = `Beyond ${horizonDays}d`;
    beyondEl.appendChild(beyondLabel);

    beyondHorizon.forEach(({ task, days, effectiveDate }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "beyond-chip";
      chip.textContent = `${task.title} (${formatShortDate(effectiveDate)}, ${days}d)`;
      chip.title =
        task.status === "today"
          ? "In Today's Focus — click to open task details"
          : "Click to pull into Today";
      chip.addEventListener("click", () => handleTimelineTaskClick(task));
      beyondEl.appendChild(chip);
    });
  } else {
    beyondEl.classList.add("hidden");
  }

  // Expand / collapse >8 lanes
  const hasManyLanes = upcomingTasks.length > 8;
  lanesEl.classList.toggle("is-expanded", Boolean(hasManyLanes && showAllTimeline));
  if (hasManyLanes) {
    footEl.classList.remove("hidden");
    moreBtn.textContent = showAllTimeline
      ? "Show less"
      : `Show all (${upcomingTasks.length})`;
  } else {
    footEl.classList.add("hidden");
  }

  if (upcomingTasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    if (isFilterActive()) {
      empty.textContent = "No matching tasks on this horizon.";
    } else if (beyondHorizon.length > 0) {
      empty.textContent = `No tasks due within ${horizonDays}d.`;
    } else {
      empty.textContent = "No dated or Today tasks yet.";
    }
    lanesEl.appendChild(empty);
    return;
  }

  upcomingTasks.forEach(({ task, days, effectiveDate }) => {
    const lane = document.createElement("div");
    lane.className = "timeline-lane";

    const isUndatedFocus = !task.dueDate;
    const style = getGradientStyle(days, horizonDays);
    const widthPct = getTimelineWidthPercent(days, horizonDays);
    const labelOutside = isUndatedFocus || widthPct < 34;

    const dateDesc = task.dueDate
      ? `${formatShortDate(effectiveDate)} (${formatDaysLabel(days)})`
      : "Today's Focus (no deadline)";
    const actionHint =
      task.status === "today"
        ? expandedTaskId === task.id
          ? "Click to close task details."
          : "In Today — click to open task details."
        : "Click to pull into Today.";
    const tooltip = `${task.title} — ${dateDesc}. ${actionHint}`;

    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = `timeline-bar${isUndatedFocus ? " is-focus-undated" : ""}`;
    bar.style.width = `${widthPct}%`;
    if (!isUndatedFocus) {
      bar.style.background = style.background;
      bar.style.borderRightColor = style.borderColor;
      bar.style.color = style.textColor;
    }
    bar.title = tooltip;
    bar.addEventListener("click", () => handleTimelineTaskClick(task));

    const titleText = task.status === "today" ? `★ ${task.title}` : task.title;
    const metaText = task.dueDate
      ? `${formatShortDate(effectiveDate)} · ${formatDaysLabel(days)}`
      : "Focus · Today";

    if (labelOutside) {
      const outside = document.createElement("button");
      outside.type = "button";
      outside.className = "timeline-outside-label";
      outside.title = tooltip;
      outside.addEventListener("click", () => handleTimelineTaskClick(task));

      const titleSpan = document.createElement("span");
      titleSpan.className = "timeline-outside-title";
      titleSpan.textContent = titleText;

      const metaSpan = document.createElement("span");
      metaSpan.className = `timeline-outside-meta${isUndatedFocus ? " is-focus-undated" : ""}`;
      if (!isUndatedFocus) {
        metaSpan.style.color = style.badgeColor;
      }
      metaSpan.textContent = metaText;

      outside.appendChild(titleSpan);
      outside.appendChild(metaSpan);
      lane.appendChild(bar);
      lane.appendChild(outside);
    } else {
      const titleSpan = document.createElement("span");
      titleSpan.className = "timeline-bar-label";
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
}

function startInlineTitleEdit(task, titleEl) {
  if (!titleEl.isConnected) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-title-input";
  input.value = task.title;
  input.setAttribute("aria-label", "Edit task title");

  let finished = false;
  const restoreDisplay = () => {
    if (input.isConnected) {
      input.replaceWith(titleEl);
    }
  };

  const commit = () => {
    if (finished) return;
    finished = true;
    const nextTitle = input.value.trim();
    if (nextTitle && nextTitle !== task.title) {
      updateTask(task.id, { title: nextTitle });
    } else {
      restoreDisplay();
    }
  };

  const cancel = () => {
    if (finished) return;
    finished = true;
    restoreDisplay();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    scheduleBlurCommit(commit);
  });

  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function buildTaskDrawer(task) {
  const drawer = document.createElement("div");
  drawer.className = "task-drawer";

  // Top row: editable title + recurrence selector
  const topRow = document.createElement("div");
  topRow.className = "drawer-top-row";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "drawer-title-input";
  titleInput.value = task.title;
  titleInput.placeholder = "Task title";
  titleInput.setAttribute("aria-label", "Task title");

  let titleCancelled = false;
  const commitDrawerTitle = () => {
    if (titleCancelled) {
      titleCancelled = false;
      return;
    }
    const trimmed = titleInput.value.trim();
    if (trimmed && trimmed !== task.title) {
      updateTask(task.id, { title: trimmed });
    } else {
      titleInput.value = task.title;
    }
  };

  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInput.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      titleCancelled = true;
      titleInput.value = task.title;
      titleInput.blur();
    }
  });
  titleInput.addEventListener("blur", () => scheduleBlurCommit(commitDrawerTitle));

  const recWrap = document.createElement("label");
  recWrap.className = "drawer-recurrence-wrap";
  const recLabel = document.createElement("span");
  recLabel.textContent = "Repeat";
  const recSelect = document.createElement("select");
  recSelect.className = "drawer-recurrence-select";
  recSelect.setAttribute("aria-label", "Task recurrence");

  RECURRENCE_OPTIONS.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    optionEl.selected = (task.recurrence || "") === opt.value;
    recSelect.appendChild(optionEl);
  });
  recSelect.addEventListener("change", () => {
    updateTask(task.id, { recurrence: recSelect.value });
  });

  recWrap.appendChild(recLabel);
  recWrap.appendChild(recSelect);
  topRow.appendChild(titleInput);
  topRow.appendChild(recWrap);
  drawer.appendChild(topRow);

  // Notes textarea (auto-grows with content) + safe external URL links
  const notesInput = document.createElement("textarea");
  notesInput.className = "drawer-notes-input";
  notesInput.rows = 2;
  notesInput.placeholder = "Notes or links (https://...)";
  notesInput.value = task.notes || "";
  notesInput.setAttribute("aria-label", "Task notes");

  const autoSizeNotes = () => {
    notesInput.style.height = "auto";
    notesInput.style.height = `${Math.min(260, Math.max(48, notesInput.scrollHeight))}px`;
  };
  notesInput.addEventListener("input", autoSizeNotes);
  requestAnimationFrame(autoSizeNotes);

  notesInput.addEventListener("blur", () => {
    scheduleBlurCommit(() => {
      if (notesInput.value !== (task.notes || "")) {
        updateTask(task.id, { notes: notesInput.value });
      }
    });
  });

  drawer.appendChild(notesInput);

  const safeUrls = extractSafeUrls(task.notes || "");
  if (safeUrls.length > 0) {
    const linksRow = document.createElement("div");
    linksRow.className = "drawer-links";
    safeUrls.forEach(({ href, label }) => {
      const a = document.createElement("a");
      a.className = "note-link";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `↗ ${label}`;
      linksRow.appendChild(a);
    });
    drawer.appendChild(linksRow);
  }

  // Subtasks mini-checklist
  const subtaskSection = document.createElement("div");
  subtaskSection.className = "subtask-section";

  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
  if (subtasks.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "subtask-list";

    subtasks.forEach((st) => {
      const item = document.createElement("li");
      item.className = "subtask-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "subtask-checkbox";
      cb.checked = Boolean(st.done);
      cb.setAttribute("aria-label", `Subtask "${st.text}"`);
      cb.addEventListener("change", () => {
        const live = tasks.find((t) => t.id === task.id);
        const currentSubtasks = live && Array.isArray(live.subtasks) ? live.subtasks : [];
        const next = currentSubtasks.map((s) =>
          s.id === st.id ? { ...s, done: cb.checked } : s
        );
        updateTask(task.id, { subtasks: next });
      });

      const txt = document.createElement("span");
      txt.className = `subtask-text${st.done ? " is-done" : ""}`;
      txt.textContent = st.text;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "subtask-del-btn";
      del.textContent = "×";
      del.setAttribute("aria-label", `Delete subtask "${st.text}"`);
      del.addEventListener("click", () => {
        const live = tasks.find((t) => t.id === task.id);
        const currentSubtasks = live && Array.isArray(live.subtasks) ? live.subtasks : [];
        const next = currentSubtasks.filter((s) => s.id !== st.id);
        updateTask(task.id, { subtasks: next });
      });

      item.appendChild(cb);
      item.appendChild(txt);
      item.appendChild(del);
      ul.appendChild(item);
    });

    subtaskSection.appendChild(ul);
  }

  const addRow = document.createElement("div");
  addRow.className = "subtask-add-row";

  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.className = "subtask-add-input";
  addInput.placeholder = "Add subtask...";
  addInput.dataset.subtaskInputFor = task.id;
  addInput.setAttribute("aria-label", "New subtask");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "row-btn subtask-add-btn";
  addBtn.textContent = "Add";

  const submitSubtask = () => {
    const text = addInput.value.trim();
    if (!text) return;
    const live = tasks.find((t) => t.id === task.id);
    const currentSubtasks = live && Array.isArray(live.subtasks) ? live.subtasks : [];
    const next = [
      ...currentSubtasks,
      { id: makeId("st"), text, done: false },
    ];
    focusSubtaskInputTaskId = task.id;
    updateTask(task.id, { subtasks: next });
  };

  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitSubtask();
    }
  });
  addBtn.addEventListener("click", submitSubtask);

  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  subtaskSection.appendChild(addRow);

  drawer.appendChild(subtaskSection);
  return drawer;
}

function buildTaskRow(task, context) {
  const isExpanded = expandedTaskId === task.id;
  const li = document.createElement("li");
  li.className = `task-item${task.status === "done" ? " is-done" : ""}${
    isExpanded ? " is-expanded" : ""
  }`;
  li.dataset.taskId = task.id;

  const row = document.createElement("div");
  row.className = "task-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.status === "done";
  checkbox.setAttribute(
    "aria-label",
    task.status === "done"
      ? `Mark "${task.title}" as incomplete`
      : `Mark "${task.title}" as done`
  );
  checkbox.addEventListener("change", () => toggleDone(task.id));

  const body = document.createElement("div");
  body.className = "task-body";

  const titleEl = document.createElement("span");
  titleEl.className = "task-title";
  titleEl.textContent = task.title;
  titleEl.title = "Double-click to edit title";
  titleEl.addEventListener("dblclick", () => startInlineTitleEdit(task, titleEl));
  body.appendChild(titleEl);

  const toggleDrawer = () => {
    expandedTaskId = expandedTaskId === task.id ? null : task.id;
    renderTimeline();
    renderLists();
    const btn = document.querySelector(
      `[data-task-id="${CSS.escape(task.id)}"] .expand-btn`
    );
    if (btn) btn.focus();
  };

  if (task.status === "done" && task.completedAt) {
    const doneSpan = document.createElement("span");
    doneSpan.className = "done-date";
    doneSpan.textContent = formatShortDate(task.completedAt);
    body.appendChild(doneSpan);
  } else if (task.dueDate) {
    const days = daysUntil(task.dueDate, new Date());
    const style = getGradientStyle(days, horizonDays);
    const tag = document.createElement("span");
    tag.className = "due-tag";
    tag.style.background = style.badgeBg;
    tag.style.color = style.badgeColor;
    tag.textContent = `${formatShortDate(task.dueDate)} · ${formatDaysLabel(days)}`;
    body.appendChild(tag);
  }

  // Subtle metadata pills (recurrence, subtask counter, note indicator)
  if (task.recurrence) {
    const recPill = document.createElement("button");
    recPill.type = "button";
    recPill.className = "meta-pill";
    recPill.textContent = `↻ ${task.recurrence}`;
    recPill.title = "Recurring task — click for details";
    recPill.addEventListener("click", toggleDrawer);
    body.appendChild(recPill);
  }

  if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
    const doneSubCount = task.subtasks.filter((s) => s.done).length;
    const subPill = document.createElement("button");
    subPill.type = "button";
    subPill.className = `meta-pill${
      doneSubCount === task.subtasks.length ? " is-complete" : ""
    }`;
    subPill.textContent = `${doneSubCount}/${task.subtasks.length}`;
    subPill.title = "Subtasks — click to view checklist";
    subPill.addEventListener("click", toggleDrawer);
    body.appendChild(subPill);
  }

  if (task.notes && task.notes.trim()) {
    const notePill = document.createElement("button");
    notePill.type = "button";
    notePill.className = "meta-pill";
    notePill.textContent = "✎";
    notePill.title = "Has notes — click to view";
    notePill.addEventListener("click", toggleDrawer);
    body.appendChild(notePill);
  }

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = `row-btn expand-btn${isExpanded ? " is-open" : ""}`;
  expandBtn.textContent = isExpanded ? "▾" : "···";
  expandBtn.title = isExpanded ? "Close details" : "Task details & subtasks";
  expandBtn.setAttribute("aria-expanded", String(isExpanded));
  expandBtn.addEventListener("click", toggleDrawer);
  actions.appendChild(expandBtn);

  if (task.status !== "done") {
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = `inline-date-input${task.dueDate ? "" : " is-empty"}`;
    dateInput.value = task.dueDate || "";
    dateInput.title = "Change deadline";
    dateInput.setAttribute("aria-label", `Deadline for "${task.title}"`);
    let typingDate = false;
    let dateCancelled = false;
    const commitDate = () => {
      if (dateCancelled) {
        dateCancelled = false;
        return;
      }
      const nextVal = dateInput.value || "";
      if (nextVal !== (task.dueDate || "")) {
        updateTask(task.id, { dueDate: nextVal });
      }
    };
    dateInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        typingDate = false;
        commitDate();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        typingDate = false;
        dateCancelled = true;
        dateInput.value = task.dueDate || "";
        dateInput.blur();
      } else if (/^\d$/.test(e.key) || e.key === "Backspace" || e.key === "Delete") {
        typingDate = true;
      }
    });
    dateInput.addEventListener("change", () => {
      if (!typingDate) commitDate();
    });
    dateInput.addEventListener("blur", () => {
      typingDate = false;
      scheduleBlurCommit(commitDate);
    });
    actions.appendChild(dateInput);

    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "row-btn";
    moveBtn.textContent = context === "inbox" ? "→ Today" : "Later";
    moveBtn.addEventListener("click", () =>
      updateTask(task.id, { status: context === "inbox" ? "today" : "inbox" })
    );
    actions.appendChild(moveBtn);
  }

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "row-btn del";
  delBtn.textContent = "×";
  delBtn.setAttribute("aria-label", `Delete "${task.title}"`);
  delBtn.addEventListener("click", () => deleteTask(task.id));
  actions.appendChild(delBtn);

  row.appendChild(checkbox);
  row.appendChild(body);
  row.appendChild(actions);
  li.appendChild(row);

  if (isExpanded) {
    li.appendChild(buildTaskDrawer(task));
  }

  return li;
}

function renderLists() {
  const now = new Date();
  const filtered = isFilterActive();

  const allTodayTasks = tasks.filter((t) => t.status === "today");
  const todayTasks = sortTasksByUrgency(
    allTodayTasks.filter(taskMatchesFilters),
    now
  );

  const allInboxTasks = sortTasksByUrgency(
    tasks.filter((t) => t.status === "inbox" && taskMatchesFilters(t)),
    now
  );

  const allDoneUnfiltered = tasks.filter((t) => t.status === "done");
  const doneTasks = allDoneUnfiltered
    .filter(taskMatchesFilters)
    .sort(
      (a, b) =>
        (b.completedAt || "").localeCompare(a.completedAt || "") ||
        (b.updatedAt || 0) - (a.updatedAt || 0)
    );

  const visibleInbox = allInboxTasks.filter((t) => {
    if (inboxFilter === "dated") return Boolean(t.dueDate);
    if (inboxFilter === "flexible") return !t.dueDate;
    return true;
  });

  // Today
  const todayListEl = document.getElementById("today-list");
  const todayEmptyEl = document.getElementById("today-empty");
  todayListEl.replaceChildren();
  todayTasks.forEach((t) => todayListEl.appendChild(buildTaskRow(t, "today")));
  document.getElementById("today-count").textContent = String(todayTasks.length);
  todayEmptyEl.textContent = filtered
    ? "No matching tasks in Today."
    : "Nothing set for today.";
  todayEmptyEl.classList.toggle("hidden", todayTasks.length > 0);

  const nudge = document.getElementById("focus-nudge");
  if (allTodayTasks.length > 3) {
    nudge.textContent = `${allTodayTasks.length} in focus — trim to 3?`;
    nudge.classList.add("is-heavy");
  } else {
    nudge.textContent = "1–3 focus items";
    nudge.classList.remove("is-heavy");
  }

  // Inbox
  const inboxListEl = document.getElementById("inbox-list");
  const inboxEmptyEl = document.getElementById("inbox-empty");
  inboxListEl.replaceChildren();
  visibleInbox.forEach((t) => inboxListEl.appendChild(buildTaskRow(t, "inbox")));
  document.getElementById("inbox-count").textContent = String(allInboxTasks.length);
  inboxEmptyEl.textContent = filtered
    ? "No matching tasks in Inbox."
    : "Inbox clear.";
  inboxEmptyEl.classList.toggle("hidden", visibleInbox.length > 0);

  // Done
  const doneListEl = document.getElementById("done-list");
  const doneEmptyEl = document.getElementById("done-empty");
  const doneFootEl = document.getElementById("done-foot");
  const doneMoreBtn = document.getElementById("done-more-btn");

  doneListEl.replaceChildren();
  const visibleDone = showAllDone ? doneTasks : doneTasks.slice(0, 12);
  visibleDone.forEach((t) => doneListEl.appendChild(buildTaskRow(t, "done")));

  if (doneTasks.length > 12) {
    doneFootEl.classList.remove("hidden");
    doneMoreBtn.textContent = showAllDone
      ? "Show less"
      : `Show all (${doneTasks.length})`;
  } else {
    doneFootEl.classList.add("hidden");
  }

  const weeklyWins = countCompletedThisWeek(tasks, now);
  document.getElementById("wins-week-badge").textContent = `${weeklyWins} this week`;
  doneEmptyEl.textContent = filtered
    ? "No matching completed tasks."
    : "Completed tasks appear here.";
  doneEmptyEl.classList.toggle("hidden", doneTasks.length > 0);
  document
    .getElementById("clear-done-btn")
    .classList.toggle("hidden", allDoneUnfiltered.length === 0);

  if (focusSubtaskInputTaskId) {
    const targetInput = document.querySelector(
      `[data-subtask-input-for="${CSS.escape(focusSubtaskInputTaskId)}"]`
    );
    focusSubtaskInputTaskId = null;
    if (targetInput) targetInput.focus();
  }
}

function renderAll() {
  lastRenderedDateKey = toDateKey(new Date());
  renderHeader();
  renderFilterBar();
  renderTimeline();
  renderLists();
}

// --- Export / Safe Import ---

function exportJson() {
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `horizon-tasks-${toDateKey(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showImportBanner(parsedTasks, filename) {
  pendingImport = {
    tasks: normalizeTaskList(parsedTasks),
    filename: filename || "tasks.json",
  };
  const count = pendingImport.tasks.length;
  document.getElementById("import-banner-text").textContent =
    `Import ${count} task${count === 1 ? "" : "s"} from "${pendingImport.filename}"?`;
  document.getElementById("import-banner").classList.remove("hidden");
}

function hideImportBanner() {
  pendingImport = null;
  document.getElementById("import-banner").classList.add("hidden");
}

async function applyPendingImport(mode, { force = false } = {}) {
  return enqueueMutation(async () => {
    if (!pendingImport) return { ok: false };
    const incoming = pendingImport.tasks;
    const count = incoming.length;
    const snapshot = cloneTasks(tasks);
    const label =
      mode === "merge"
        ? `Merged ${count} imported task${count === 1 ? "" : "s"}`
        : `Replaced with ${count} imported task${count === 1 ? "" : "s"}`;

    if (useServerApi) {
      const res = await serverMutate("/api/tasks/import", {
        method: "POST",
        body: { tasks: incoming, mode },
        force,
        actionName: "import tasks",
      });
      if (!res.ok) {
        if (res.conflict) {
          showConflictBanner("server", "tasks.json", () =>
            applyPendingImport(mode, { force: true })
          );
        }
        return res;
      }
      pushUndoSnapshot(snapshot, label);
    } else {
      pushUndoSnapshot(snapshot, label);
      if (mode === "merge") {
        tasks = mergeTaskLists(tasks, incoming);
      } else {
        tasks = normalizeTaskList(incoming);
      }
      localStorage.setItem(SAMPLE_FLAG_KEY, "1");
      await persistOffline();
    }
    hideImportBanner();
    renderAll();
    showToast(label, { showUndo: true });
    return { ok: true };
  });
}

function stageImportJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.tasks)
          ? parsed.tasks
          : null;
      if (!list) throw new Error("Expected a JSON list");
      showImportBanner(list, file.name);
    } catch {
      alert("That file doesn't look like a valid tasks.json list.");
    }
  };
  reader.readAsText(file);
}

// --- Quick-Date Pills & Rollover Helpers ---

function computeQuickDateValue(kind) {
  const now = new Date();
  const todayKey = toDateKey(now);
  if (kind === "tom") return addDaysToKey(todayKey, 1);
  if (kind === "1w") return addDaysToKey(todayKey, 7);
  if (kind === "1m") return getNextRecurrenceDate(todayKey, "monthly", now);
  return "";
}

function syncQuickDatePills() {
  const currentVal = document.getElementById("task-date-input").value;
  document.querySelectorAll(".quick-pill").forEach((pill) => {
    const targetVal = computeQuickDateValue(pill.dataset.quickDate);
    const active = Boolean(currentVal && currentVal === targetVal);
    pill.classList.toggle("is-active", active);
    pill.setAttribute("aria-pressed", String(active));
  });
}

function checkDateRollover() {
  const nowKey = toDateKey(new Date());
  if (nowKey !== lastRenderedDateKey) {
    lastRenderedDateKey = nowKey;
    syncQuickDatePills();
    renderAll();
  }
}

function isTypingContext(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
  }
  return false;
}

// --- Init ---

async function init() {
  document.addEventListener("pointerdown", () => {
    isPointerDown = true;
  });
  const clearPointer = () => {
    isPointerDown = false;
  };
  document.addEventListener("pointerup", clearPointer);
  document.addEventListener("pointercancel", clearPointer);

  await loadInitialTasks();
  renderAll();

  const form = document.getElementById("add-task-form");
  const titleInput = document.getElementById("task-title-input");
  const dateInput = document.getElementById("task-date-input");
  const todayInput = document.getElementById("task-today-input");
  const searchInput = document.getElementById("search-input");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await addTask(titleInput.value, dateInput.value, todayInput.checked);
    if (res && res.ok) {
      titleInput.value = "";
      dateInput.value = "";
      todayInput.checked = false;
      syncQuickDatePills();
      titleInput.focus();
    }
  });

  document.querySelectorAll(".quick-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const targetVal = computeQuickDateValue(pill.dataset.quickDate);
      dateInput.value = dateInput.value === targetVal ? "" : targetVal;
      syncQuickDatePills();
      titleInput.focus();
    });
  });
  dateInput.addEventListener("change", syncQuickDatePills);

  // Search & Filter Bar
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderFilterBar();
    renderTimeline();
    renderLists();
  });
  document.getElementById("search-clear-btn").addEventListener("click", () => {
    searchQuery = "";
    searchInput.value = "";
    renderAll();
    searchInput.focus();
  });
  document.getElementById("clear-filters-btn").addEventListener("click", () => {
    searchQuery = "";
    activeTag = null;
    renderAll();
  });

  // Custom Horizon Days Input & Preset Dropdown (no scroll-wheel binding)
  const horizonRangeEl = document.getElementById("horizon-range");
  const horizonDaysInput = document.getElementById("horizon-days-input");
  const horizonPresetToggle = document.getElementById("horizon-preset-toggle");
  const horizonPresetOptions = Array.from(document.querySelectorAll(".horizon-preset-option"));

  let horizonEditCancelled = false;
  horizonDaysInput.addEventListener("focus", () => {
    horizonDaysInput.select();
  });
  horizonDaysInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setHorizonDays(horizonDaysInput.value);
      setHorizonMenuOpen(false);
      horizonDaysInput.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      horizonEditCancelled = true;
      horizonDaysInput.value = String(horizonDays);
      setHorizonMenuOpen(false);
      horizonDaysInput.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHorizonMenuOpen(true);
      const activeOpt =
        horizonPresetOptions.find((opt) => opt.classList.contains("active")) ||
        horizonPresetOptions[0];
      if (activeOpt) activeOpt.focus();
    }
  });
  horizonDaysInput.addEventListener("blur", (e) => {
    if (horizonEditCancelled) {
      horizonEditCancelled = false;
      return;
    }
    if (e.relatedTarget && horizonRangeEl.contains(e.relatedTarget)) {
      return;
    }
    setHorizonDays(horizonDaysInput.value);
  });

  horizonPresetToggle.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  horizonPresetToggle.addEventListener("click", () => {
    const nextOpen = !isHorizonMenuOpen();
    setHorizonMenuOpen(nextOpen);
  });

  horizonPresetOptions.forEach((opt, idx) => {
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    opt.addEventListener("click", () => {
      setHorizonDays(Number(opt.dataset.horizon));
      setHorizonMenuOpen(false);
      horizonDaysInput.blur();
    });
    opt.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        horizonPresetOptions[(idx + 1) % horizonPresetOptions.length].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        horizonPresetOptions[(idx - 1 + horizonPresetOptions.length) % horizonPresetOptions.length].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setHorizonMenuOpen(false);
        horizonDaysInput.focus();
      }
    });
  });

  document.addEventListener("pointerdown", (e) => {
    if (isHorizonMenuOpen() && !horizonRangeEl.contains(e.target)) {
      setHorizonMenuOpen(false);
    }
  });

  horizonRangeEl.addEventListener("focusout", (e) => {
    if (!e.relatedTarget || !horizonRangeEl.contains(e.relatedTarget)) {
      setHorizonMenuOpen(false);
    }
  });

  // Timeline & Done "Show all (N) / Show less" toggles
  document.getElementById("timeline-more-btn").addEventListener("click", () => {
    showAllTimeline = !showAllTimeline;
    renderTimeline();
  });
  document.getElementById("done-more-btn").addEventListener("click", () => {
    showAllDone = !showAllDone;
    renderLists();
  });

  // Storage, Conflict, Import & Toast Controls
  document.getElementById("link-file-btn").addEventListener("click", linkExistingFile);
  document.getElementById("new-file-btn").addEventListener("click", createLinkedFile);
  document.getElementById("reconnect-file-btn").addEventListener("click", reconnectSavedFile);
  document.getElementById("clear-samples-btn").addEventListener("click", clearSamples);
  document.getElementById("clear-done-btn").addEventListener("click", clearCompleted);
  document.getElementById("export-btn").addEventListener("click", exportJson);
  document.getElementById("import-input").addEventListener("change", (e) => {
    stageImportJson(e.target.files[0]);
    e.target.value = "";
  });

  document.getElementById("import-merge-btn").addEventListener("click", () =>
    applyPendingImport("merge")
  );
  document.getElementById("import-replace-btn").addEventListener("click", () =>
    applyPendingImport("replace")
  );
  document.getElementById("import-cancel-btn").addEventListener("click", hideImportBanner);

  document
    .getElementById("conflict-reload-btn")
    .addEventListener("click", reloadFromExternalSource);
  document
    .getElementById("conflict-overwrite-btn")
    .addEventListener("click", overwriteExternalWithMine);

  document.getElementById("toast-undo-btn").addEventListener("click", performUndo);
  document.getElementById("toast-dismiss-btn").addEventListener("click", hideToast);

  // Inbox segmented filter
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.classList.contains("active")));
    btn.addEventListener("click", () => {
      inboxFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-btn").forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", String(isActive));
      });
      renderLists();
    });
  });

  // Global Keyboard Shortcuts
  document.addEventListener("keydown", (e) => {
    const activeEl = document.activeElement;

    if (e.key === "Escape") {
      if (isHorizonMenuOpen()) {
        setHorizonMenuOpen(false);
        return;
      }
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT")
      ) {
        activeEl.blur();
        return;
      }
      if (pendingImport) {
        hideImportBanner();
        return;
      }
      if (expandedTaskId !== null) {
        expandedTaskId = null;
        renderTimeline();
        renderLists();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
      if (!isTypingContext(activeEl)) {
        e.preventDefault();
        performUndo();
      }
      return;
    }

    // Single-key shortcuts: only when NOT focused in text input/textarea/select
    if (isTypingContext(activeEl)) {
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        titleInput.focus();
      } else if (e.key === "/") {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    }
  });

  // Midnight rollover + external sync checks on interval & tab focus/visibility
  setInterval(checkDateRollover, 60_000);

  window.addEventListener("focus", () => {
    checkDateRollover();
    checkExternalSyncDrift();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkDateRollover();
      checkExternalSyncDrift();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
