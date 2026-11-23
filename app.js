/**
 * app.js — "The Front Counter"
 * Works in three storage modes automatically:
 * 1. Python local server (http://): saves directly to tasks.json via /api/tasks.
 * 2. Browser Direct File Access (Edge/Chrome, no Python): click "Open file" or "New file"
 *    to auto-save straight to a real tasks.json file on your PC or OneDrive.
 * 3. Browser localStorage fallback: always keeps a backup copy even with zero setup.
 */

const STORAGE_KEY = "horizon_tasks_v1";
const SAMPLE_FLAG_KEY = "horizon_samples_dismissed_v1";

let tasks = [];
let inboxFilter = "all"; // "all" | "dated" | "flexible"
let useServerApi =
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "localhost";
let linkedFileHandle = null; // FileSystemFileHandle when linked in Edge/Chrome without Python

// --- Sample Tasks (for first-time offline / portable launch) ---

function addDaysKey(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return toDateKey(d);
}

function createSampleTasks() {
  const now = Date.now();
  return [
    {
      id: "sample-1",
      title: "Pay electricity bill",
      dueDate: addDaysKey(2),
      status: "today",
      createdAt: now - 4000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-2",
      title: "Book dentist checkup",
      dueDate: addDaysKey(11),
      status: "inbox",
      createdAt: now - 3000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-3",
      title: "Renew car insurance",
      dueDate: addDaysKey(34),
      status: "inbox",
      createdAt: now - 2000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-4",
      title: "Plan spring trip & flights",
      dueDate: addDaysKey(74),
      status: "inbox",
      createdAt: now - 1000,
      completedAt: null,
      isSample: true,
    },
    {
      id: "sample-5",
      title: "Clean up Downloads folder",
      dueDate: "",
      status: "inbox",
      createdAt: now - 500,
      completedAt: null,
      isSample: true,
    },
  ];
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

  if (useServerApi) {
    tag.textContent = "tasks.json (Python)";
    tag.classList.add("is-linked");
    openBtn.classList.add("hidden");
    newBtn.classList.add("hidden");
    return;
  }

  // Offline / portable mode (no Python required)
  const canLink = supportsDirectFileAccess();
  openBtn.classList.toggle("hidden", !canLink);
  newBtn.classList.toggle("hidden", !canLink);

  if (linkedFileHandle) {
    tag.textContent = `${linkedFileHandle.name} (auto-saving)`;
    tag.title = "Every change automatically saves directly to this file on your PC.";
    tag.classList.add("is-linked");
  } else {
    tag.textContent = "browser storage";
    tag.title = canLink
      ? "Click Open file or New file to auto-save directly to a real tasks.json file."
      : "Saved in browser storage. Use Export / Import to move tasks.json.";
    tag.classList.remove("is-linked");
  }
}

async function apiRequest(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function writeLinkedFile() {
  if (!linkedFileHandle) return;
  try {
    const writable = await linkedFileHandle.createWritable();
    await writable.write(JSON.stringify(tasks, null, 2) + "\n");
    await writable.close();
  } catch (err) {
    console.warn("Could not write linked tasks.json file:", err);
  }
}

async function persistOffline() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (err) {
    console.warn("Could not save to localStorage:", err);
  }
  await writeLinkedFile();
}

async function linkExistingFile() {
  if (!supportsDirectFileAccess()) return;
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "JSON Tasks File", accept: { "application/json": [".json"] } }],
      multiple: false,
    });
    const file = await handle.getFile();
    const text = await file.text();
    const parsed = text.trim() ? JSON.parse(text) : [];
    if (!Array.isArray(parsed)) {
      alert("That file doesn't look like a Horizon tasks.json list.");
      return;
    }
    linkedFileHandle = handle;
    tasks = parsed;
    localStorage.setItem(SAMPLE_FLAG_KEY, "1");
    await persistOffline();
    updateStorageIndicator();
    renderAll();
  } catch (err) {
    if (err && err.name !== "AbortError") {
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
    await persistOffline();
    updateStorageIndicator();
  } catch (err) {
    if (err && err.name !== "AbortError") {
      alert("Direct file linking isn't allowed here — use Export / Import instead. Your tasks are still saved in the browser.");
    }
  }
}

async function loadInitialTasks() {
  if (useServerApi) {
    try {
      const data = await apiRequest("/api/tasks");
      tasks = Array.isArray(data.tasks) ? data.tasks : [];
      document.getElementById("storage-tag").title = data.dataFile || "Saved directly to tasks.json";
      updateStorageIndicator();
      return;
    } catch (err) {
      console.warn("Python API unavailable, falling back to browser storage:", err);
      useServerApi = false;
    }
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        tasks = parsed;
        updateStorageIndicator();
        return;
      }
    }
  } catch {
    // ignore storage errors
  }

  // First-time launch without Python: show sample tasks until cleared
  if (!localStorage.getItem(SAMPLE_FLAG_KEY)) {
    tasks = createSampleTasks();
    await persistOffline();
  } else {
    tasks = [];
  }
  updateStorageIndicator();
}

// --- Task Actions ---

async function addTask(title, dueDate, putInToday) {
  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  // If marked for Today with no explicit date, anchor to Today so it appears on the timeline
  const resolvedDate = putInToday && !dueDate ? toDateKey(new Date()) : (dueDate || "");

  if (useServerApi) {
    const data = await apiRequest("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: cleanTitle, dueDate: resolvedDate, today: putInToday }),
    });
    tasks = data.tasks;
  } else {
    tasks.unshift({
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: cleanTitle,
      dueDate: resolvedDate,
      status: putInToday ? "today" : "inbox",
      createdAt: Date.now(),
      completedAt: null,
    });
    await persistOffline();
  }
  renderAll();
}

async function updateTask(taskId, patch) {
  if (useServerApi) {
    const data = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    tasks = data.tasks;
  } else {
    const t = tasks.find((item) => item.id === taskId);
    if (!t) return;
    if (patch.dueDate !== undefined) t.dueDate = patch.dueDate;
    if (patch.status !== undefined) {
      t.status = patch.status;
      t.completedAt = patch.status === "done" ? toDateKey(new Date()) : null;
      if (patch.status === "today" && !t.dueDate) {
        t.dueDate = toDateKey(new Date());
      }
    }
    await persistOffline();
  }
  renderAll();
}

async function toggleDone(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  const nextStatus = task.status === "done" ? "today" : "done";
  await updateTask(taskId, { status: nextStatus });
}

async function deleteTask(taskId) {
  if (useServerApi) {
    const data = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
    tasks = data.tasks;
  } else {
    tasks = tasks.filter((t) => t.id !== taskId);
    await persistOffline();
  }
  renderAll();
}

async function clearCompleted() {
  if (useServerApi) {
    const data = await apiRequest("/api/tasks/clear-done", { method: "POST", body: "{}" });
    tasks = data.tasks;
  } else {
    tasks = tasks.filter((t) => t.status !== "done");
    await persistOffline();
  }
  renderAll();
}

async function clearSamples() {
  if (useServerApi) {
    const data = await apiRequest("/api/tasks/clear-samples", { method: "POST", body: "{}" });
    tasks = data.tasks;
  } else {
    tasks = tasks.filter((t) => !t.isSample);
    localStorage.setItem(SAMPLE_FLAG_KEY, "1");
    await persistOffline();
  }
  renderAll();
}

// --- Rendering ---

function renderHeader() {
  document.getElementById("today-label").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const hasSamples = tasks.some((t) => t.isSample);
  document.getElementById("clear-samples-btn").classList.toggle("hidden", !hasSamples);
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

  // Month axis markers
  const markers = getMonthMarkers();
  markers.forEach((m) => {
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

  // Subtle weekly ticks
  for (let d = 7; d < HORIZON_DAYS; d += 7) {
    const tick = document.createElement("div");
    tick.className = "grid-line";
    tick.style.left = `${(d / HORIZON_DAYS) * 100}%`;
    gridEl.appendChild(tick);
  }

  // Include ALL active tasks with a deadline OR currently in Today's Focus
  const todayStr = toDateKey(new Date());
  const timelineTasks = sortTasksByUrgency(
    tasks.filter((t) => t.status !== "done" && (t.dueDate || t.status === "today"))
  );

  const overdueTasks = [];
  const upcomingTasks = [];
  const beyondHorizon = [];

  timelineTasks.forEach((t) => {
    const effectiveDate = t.dueDate || todayStr;
    const days = daysUntil(effectiveDate);
    if (days < 0) overdueTasks.push({ task: t, days, effectiveDate });
    else if (days <= HORIZON_DAYS) upcomingTasks.push({ task: t, days, effectiveDate });
    else beyondHorizon.push({ task: t, days, effectiveDate });
  });

  document.getElementById("timeline-count").textContent = String(timelineTasks.length);

  // Overdue strip
  if (overdueTasks.length > 0) {
    overdueEl.classList.remove("hidden");
    const label = document.createElement("span");
    label.className = "overdue-label";
    label.textContent = "Overdue";
    overdueEl.appendChild(label);

    overdueTasks.forEach(({ task, days }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "overdue-chip";
      chip.textContent = `${task.title} (${formatDaysLabel(days)})`;
      chip.title = "Click to move to Today";
      chip.addEventListener("click", () => updateTask(task.id, { status: "today" }));
      overdueEl.appendChild(chip);
    });
  } else {
    overdueEl.classList.add("hidden");
  }

  if (upcomingTasks.length === 0 && beyondHorizon.length === 0) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = "No dated or Today tasks yet.";
    lanesEl.appendChild(empty);
    return;
  }

  upcomingTasks.forEach(({ task, days, effectiveDate }) => {
    const lane = document.createElement("div");
    lane.className = "timeline-lane";

    const style = getGradientStyle(days);
    const widthPct = getTimelineWidthPercent(days);
    const labelOutside = widthPct < 34;

    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "timeline-bar";
    bar.style.width = `${widthPct}%`;
    bar.style.background = style.background;
    bar.style.borderRightColor = style.borderColor;
    bar.style.color = style.textColor;
    bar.title = `${task.title} — ${formatShortDate(effectiveDate)} (${formatDaysLabel(days)}). Click to pull into Today.`;
    bar.addEventListener("click", () => updateTask(task.id, { status: "today" }));

    const titleText = task.status === "today" ? `★ ${task.title}` : task.title;
    const metaText = `${formatShortDate(effectiveDate)} · ${formatDaysLabel(days)}`;

    if (labelOutside) {
      const outside = document.createElement("button");
      outside.type = "button";
      outside.className = "timeline-outside-label";
      outside.title = bar.title;
      outside.addEventListener("click", () => updateTask(task.id, { status: "today" }));

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
      `Beyond 90d: ` +
      beyondHorizon
        .map(({ task, days, effectiveDate }) => `${task.title} (${formatShortDate(effectiveDate)}, ${days}d)`)
        .join(" · ");
    lanesEl.appendChild(note);
  }
}

function buildTaskRow(task, context) {
  const li = document.createElement("li");
  li.className = `task-item${task.status === "done" ? " is-done" : ""}`;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.status === "done";
  checkbox.setAttribute("aria-label", `Mark "${task.title}" as done`);
  checkbox.addEventListener("change", () => toggleDone(task.id));

  const body = document.createElement("div");
  body.className = "task-body";

  const titleEl = document.createElement("span");
  titleEl.className = "task-title";
  titleEl.textContent = task.title;
  body.appendChild(titleEl);

  if (task.status === "done" && task.completedAt) {
    const doneSpan = document.createElement("span");
    doneSpan.className = "done-date";
    doneSpan.textContent = formatShortDate(task.completedAt);
    body.appendChild(doneSpan);
  } else if (task.dueDate) {
    const days = daysUntil(task.dueDate);
    const style = getGradientStyle(days);
    const tag = document.createElement("span");
    tag.className = "due-tag";
    tag.style.background = style.badgeBg;
    tag.style.color = style.badgeColor;
    tag.textContent = `${formatShortDate(task.dueDate)} · ${formatDaysLabel(days)}`;
    body.appendChild(tag);
  }

  const actions = document.createElement("div");
  actions.className = "task-actions";

  if (task.status !== "done") {
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = "inline-date-input";
    dateInput.value = task.dueDate || "";
    dateInput.title = "Change deadline";
    dateInput.addEventListener("change", (e) => updateTask(task.id, { dueDate: e.target.value }));
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

  li.appendChild(checkbox);
  li.appendChild(body);
  li.appendChild(actions);
  return li;
}

function renderLists() {
  const todayTasks = sortTasksByUrgency(tasks.filter((t) => t.status === "today"));
  const allInboxTasks = sortTasksByUrgency(tasks.filter((t) => t.status === "inbox"));
  const doneTasks = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));

  const visibleInbox = allInboxTasks.filter((t) => {
    if (inboxFilter === "dated") return Boolean(t.dueDate);
    if (inboxFilter === "flexible") return !t.dueDate;
    return true;
  });

  // Today
  const todayListEl = document.getElementById("today-list");
  todayListEl.innerHTML = "";
  todayTasks.forEach((t) => todayListEl.appendChild(buildTaskRow(t, "today")));
  document.getElementById("today-count").textContent = String(todayTasks.length);
  document.getElementById("today-empty").classList.toggle("hidden", todayTasks.length > 0);

  const nudge = document.getElementById("focus-nudge");
  if (todayTasks.length > 3) {
    nudge.textContent = `${todayTasks.length} in focus — trim to 3?`;
    nudge.classList.add("is-heavy");
  } else {
    nudge.textContent = "1–3 focus items";
    nudge.classList.remove("is-heavy");
  }

  // Inbox
  const inboxListEl = document.getElementById("inbox-list");
  inboxListEl.innerHTML = "";
  visibleInbox.forEach((t) => inboxListEl.appendChild(buildTaskRow(t, "inbox")));
  document.getElementById("inbox-count").textContent = String(allInboxTasks.length);
  document.getElementById("inbox-empty").classList.toggle("hidden", visibleInbox.length > 0);

  // Done
  const doneListEl = document.getElementById("done-list");
  doneListEl.innerHTML = "";
  doneTasks.slice(0, 12).forEach((t) => doneListEl.appendChild(buildTaskRow(t, "done")));
  const weeklyWins = countCompletedThisWeek(tasks);
  document.getElementById("wins-week-badge").textContent = `${weeklyWins} this week`;
  document.getElementById("done-empty").classList.toggle("hidden", doneTasks.length > 0);
  document.getElementById("clear-done-btn").classList.toggle("hidden", doneTasks.length === 0);
}

function renderAll() {
  renderHeader();
  renderTimeline();
  renderLists();
}

// --- Export / Import ---

function exportJson() {
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `horizon-tasks-${toDateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON list");
      if (useServerApi) {
        const data = await apiRequest("/api/tasks/import", {
          method: "POST",
          body: JSON.stringify({ tasks: parsed }),
        });
        tasks = data.tasks;
      } else {
        tasks = parsed;
        localStorage.setItem(SAMPLE_FLAG_KEY, "1");
        await persistOffline();
      }
      renderAll();
    } catch {
      alert("That file doesn't look like a valid tasks.json list.");
    }
  };
  reader.readAsText(file);
}

// --- Init ---

async function init() {
  await loadInitialTasks();
  renderAll();

  const form = document.getElementById("add-task-form");
  const titleInput = document.getElementById("task-title-input");
  const dateInput = document.getElementById("task-date-input");
  const todayInput = document.getElementById("task-today-input");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await addTask(titleInput.value, dateInput.value, todayInput.checked);
    titleInput.value = "";
    dateInput.value = "";
    todayInput.checked = false;
    titleInput.focus();
  });

  document.getElementById("link-file-btn").addEventListener("click", linkExistingFile);
  document.getElementById("new-file-btn").addEventListener("click", createLinkedFile);
  document.getElementById("clear-samples-btn").addEventListener("click", clearSamples);
  document.getElementById("clear-done-btn").addEventListener("click", clearCompleted);
  document.getElementById("export-btn").addEventListener("click", exportJson);
  document.getElementById("import-input").addEventListener("change", (e) => {
    importJson(e.target.files[0]);
    e.target.value = "";
  });

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      inboxFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderLists();
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
