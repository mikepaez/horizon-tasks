/**
 * logic.js — "The Kitchen"
 * Pure functions that handle dates, the zoomable timeline position,
 * the transparent-to-solid urgency gradient math, recurrence, tags,
 * quick-capture parsing and task normalization.
 *
 * Notice there is NO button or HTML code here — just clear rules
 * (Input -> Logic -> Output) so it is easy to read and test.
 */

const HORIZON_DAYS = 90; // 3 months zoomed out (default)
const VALID_RECURRENCES = ["", "weekly", "monthly", "quarterly", "yearly"];
const LOGIC_VALID_STATUSES = ["inbox", "today", "done"];
const LOGIC_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Convert a Date object to local "YYYY-MM-DD" text (safe from timezone shifts).
 */
function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Turn "YYYY-MM-DD" into a local midnight Date.
 */
function parseDateKey(dateKey) {
  if (!dateKey || typeof dateKey !== "string") return null;
  const parts = dateKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

/**
 * True only for real calendar dates written exactly as "YYYY-MM-DD".
 */
function logicIsValidDateKey(dateKey) {
  if (typeof dateKey !== "string" || !LOGIC_DATE_KEY_PATTERN.test(dateKey)) return false;
  const d = parseDateKey(dateKey);
  return !!d && toDateKey(d) === dateKey;
}

/**
 * Add (or subtract) whole days to a "YYYY-MM-DD" key. Returns "" if the key is invalid.
 */
function addDaysToKey(dateKey, deltaDays) {
  const d = parseDateKey(dateKey);
  if (!d || Number.isNaN(d.getTime())) return "";
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays));
}

/**
 * Add whole months to a date, clamping the day to the target month's last day.
 * `anchorDay` is the day-of-month we want to return to (so Jan 31 -> Feb 28 -> Mar 31).
 */
function logicAddMonthsClamped(year, monthIndex, anchorDay, months) {
  const total = year * 12 + monthIndex + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(ny, nm + 1, 0).getDate();
  return new Date(ny, nm, Math.min(anchorDay, lastDay));
}

/**
 * Whole calendar days between today and dueDateKey.
 * Negative = overdue, 0 = due today, positive = days left.
 */
function daysUntil(dueDateKey, today = new Date()) {
  const due = parseDateKey(dueDateKey);
  if (!due) return null;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((due - startOfToday) / msPerDay);
}

/**
 * Human-friendly label like "Today", "Tomorrow", "In 12d", or "2d overdue".
 */
function formatDaysLabel(days) {
  if (days === null || days === undefined) return "";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days}d`;
}

/**
 * Short readable date like "Dec 12".
 */
function formatShortDate(dateKey) {
  const d = parseDateKey(dateKey);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Calculate the visual gradient style for a task based on how many days are left.
 *
 * How it works:
 * - "closeness" goes smoothly from 0 (horizonDays+ away) to 1 (due today or overdue).
 * - Far-away tasks start almost transparent and peak softly.
 * - Close tasks ramp into a rich, full solid color block so they naturally stand out.
 */
function getGradientStyle(daysLeft, horizonDays = HORIZON_DAYS) {
  const horizon = horizonDays > 0 ? horizonDays : HORIZON_DAYS;
  // Clamp daysLeft between 0 and horizon for smooth scaling
  const clamped = Math.max(0, Math.min(horizon, daysLeft));
  const closeness = 1 - clamped / horizon; // 0 = far away, 1 = due right now

  // Paper Desk watercolor palette:
  // Far (calm sage) -> Mid (warm ochre) -> Approaching (burnt sienna) -> Imminent (terracotta crimson)
  let rgb;
  let badgeDarken = 30;
  if (daysLeft < 0) {
    rgb = [168, 38, 32]; // Overdue deep brick
  } else if (daysLeft <= 3) {
    rgb = [185, 58, 46]; // Imminent terracotta red
  } else if (daysLeft <= 14) {
    rgb = [196, 108, 43]; // Approaching burnt sienna
  } else if (daysLeft <= 35) {
    rgb = [168, 134, 58]; // Mid-term warm ochre
    badgeDarken = 54; // Ochre is light: darken more so the badge text stays readable
  } else {
    rgb = [92, 118, 106]; // Long-term calm sage
  }

  const [r, g, b] = rgb;

  // Left edge of the bar: near-transparent watercolor wash; right edge: solid color cap
  const startAlpha = Number((0.03 + closeness * 0.34).toFixed(2));
  const endAlpha = Number((0.26 + closeness * 0.74).toFixed(2));

  // Keep dark ink on pale/mid washes; white text only on near-solid deep crimson/brick blocks
  const useLightText = daysLeft <= 3 && closeness >= 0.85;

  return {
    closeness: Number(closeness.toFixed(3)),
    startAlpha,
    endAlpha,
    background: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, ${startAlpha}) 0%, rgba(${r}, ${g}, ${b}, ${endAlpha}) 100%)`,
    borderColor: `rgb(${r}, ${g}, ${b})`,
    textColor: useLightText ? "#fdfaf4" : "#231e18",
    badgeBg: `rgba(${r}, ${g}, ${b}, ${Number((0.11 + closeness * 0.2).toFixed(2))})`,
    badgeColor: `rgb(${Math.max(0, r - badgeDarken)}, ${Math.max(0, g - badgeDarken)}, ${Math.max(0, b - badgeDarken)})`,
  };
}

/**
 * True calendar width percentage (2.5..100) for a task bar stretching from Today
 * to its exact deadline on the horizon (default 90 days).
 */
function getTimelineWidthPercent(daysLeft, horizonDays = HORIZON_DAYS) {
  const horizon = horizonDays > 0 ? horizonDays : HORIZON_DAYS;
  if (daysLeft <= 0) return 2.5; // Crisp solid block right on Today
  const clamped = Math.min(horizon, daysLeft);
  const rawPercent = (clamped / horizon) * 100;
  return Math.min(100, Math.max(2.5, Number(rawPercent.toFixed(2))));
}

/**
 * Build the month markers along the horizon strip (Today + each upcoming month's 1st).
 */
function getMonthMarkers(today = new Date(), horizonDays = HORIZON_DAYS) {
  const horizon = horizonDays > 0 ? horizonDays : HORIZON_DAYS;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const markers = [
    {
      label: "Today",
      percent: 0,
      isToday: true,
    },
  ];

  for (let offset = 1; offset <= horizon; offset++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (d.getDate() === 1) {
      const percent = Number(((offset / horizon) * 100).toFixed(2));
      // Keep clean breathing room from the Today label
      if (percent >= 8 && percent <= 94) {
        markers.push({
          label: d.toLocaleDateString("en-US", { month: "short", year: d.getMonth() === 0 ? "numeric" : undefined }),
          percent,
          isToday: false,
        });
      }
    }
  }
  return markers;
}

/**
 * Count how many tasks were completed within the last 7 days.
 */
function countCompletedThisWeek(tasks, today = new Date()) {
  const sevenDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  return tasks.filter((t) => {
    if (t.status !== "done" || !t.completedAt) return false;
    const doneDate = parseDateKey(t.completedAt);
    return doneDate && doneDate >= sevenDaysAgo;
  }).length;
}

/**
 * Sort active tasks: soonest deadline first, then tasks without deadlines (newest first).
 */
function sortTasksByUrgency(tasks, today = new Date()) {
  return [...tasks].sort((a, b) => {
    const da = a.dueDate ? daysUntil(a.dueDate, today) : Infinity;
    const db = b.dueDate ? daysUntil(b.dueDate, today) : Infinity;
    if (da !== db) return da - db;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/**
 * Next due date for a repeating task, as "YYYY-MM-DD" ("" if the inputs are invalid).
 * Starts from baseDateKey, steps forward by the recurrence interval, and keeps
 * stepping until the result is strictly after today (so overdue tasks catch up).
 * Month/year steps always count from the ORIGINAL day-of-month, so Jan 31 gives
 * Feb 28 and then Mar 31 instead of drifting down to the 28th forever.
 */
function getNextRecurrenceDate(baseDateKey, recurrence, today = new Date()) {
  if (!recurrence || !VALID_RECURRENCES.includes(recurrence)) return "";
  const base = parseDateKey(baseDateKey);
  if (!base || Number.isNaN(base.getTime())) return "";
  const todayKey = toDateKey(today);

  const anchorDay = base.getDate();
  const step = (n) => {
    if (recurrence === "weekly") {
      return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * n);
    }
    const monthsPerStep = recurrence === "monthly" ? 1 : recurrence === "quarterly" ? 3 : 12;
    return logicAddMonthsClamped(base.getFullYear(), base.getMonth(), anchorDay, monthsPerStep * n);
  };

  let n = 1;
  let next = toDateKey(step(n));
  // Hard cap keeps a nonsense base date (year 0001) from looping forever
  while (next <= todayKey && n < 200000) {
    n += 1;
    next = toDateKey(step(n));
  }
  return next;
}

/**
 * Pull #tags out of text. Returns unique lowercase tags without the "#".
 */
function extractTags(text) {
  if (typeof text !== "string") return [];
  const re = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]{0,29})/gu;
  const seen = new Set();
  const tags = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const tag = match[1].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Sorted unique tags found in the titles and notes of all active (not done) tasks.
 */
function getAllTags(tasks) {
  const all = new Set();
  (tasks || []).forEach((t) => {
    if (!t || t.status === "done") return;
    extractTags(t.title).forEach((tag) => all.add(tag));
    extractTags(t.notes).forEach((tag) => all.add(tag));
  });
  return [...all].sort();
}

/**
 * Parse quick-capture shortcuts out of a title being typed:
 *   @today      -> putInToday: true (no deadline is forced)
 *   @tom / @tomorrow -> dueDate = tomorrow
 *   @+3d / @+2w / @+1m -> dueDate = today + 3 days / 2 weeks / 1 month
 * Tokens must be separated by whitespace. They are stripped from the title.
 */
function parseQuickCapture(rawTitle, today = new Date()) {
  const text = typeof rawTitle === "string" ? rawTitle : "";
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let dueDate = "";
  let putInToday = false;

  const kept = [];
  text.split(/\s+/).forEach((token) => {
    if (!token) return;
    if (/^@today$/i.test(token)) {
      putInToday = true;
      return;
    }
    if (/^@(tom|tomorrow)$/i.test(token)) {
      dueDate = toDateKey(new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() + 1));
      return;
    }
    const rel = /^@\+(\d{1,4})([dwm])$/i.exec(token);
    if (rel) {
      const amount = parseInt(rel[1], 10);
      const unit = rel[2].toLowerCase();
      if (unit === "m") {
        dueDate = toDateKey(
          logicAddMonthsClamped(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate(), amount)
        );
      } else {
        const days = unit === "w" ? amount * 7 : amount;
        dueDate = toDateKey(new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() + days));
      }
      return;
    }
    kept.push(token);
  });

  return { title: kept.join(" "), dueDate, putInToday };
}

function makeId(prefix = "t") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn any loosely-shaped saved/imported task into the full, safe task shape.
 * Returns null for anything that is not an object.
 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const now = Date.now();

  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Untitled task";
  const status = LOGIC_VALID_STATUSES.includes(raw.status) ? raw.status : "inbox";
  const dueDate = logicIsValidDateKey(raw.dueDate) ? raw.dueDate : "";

  let previousStatus = raw.previousStatus;
  if (previousStatus !== "inbox" && previousStatus !== "today") {
    previousStatus = status === "today" ? "today" : "inbox";
  }

  const subtasks = [];
  if (Array.isArray(raw.subtasks)) {
    raw.subtasks.forEach((st) => {
      if (!st || typeof st !== "object") return;
      const text = typeof st.text === "string" ? st.text.trim() : "";
      if (!text) return;
      subtasks.push({
        id: typeof st.id === "string" && st.id ? st.id : makeId("st"),
        text,
        done: st.done === true,
      });
    });
  }

  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? Math.trunc(raw.createdAt) : now;
  const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? Math.trunc(raw.updatedAt) : createdAt;

  const task = {
    id: typeof raw.id === "string" && raw.id ? raw.id : makeId("t"),
    title,
    dueDate,
    status,
    previousStatus,
    notes: typeof raw.notes === "string" ? raw.notes : "",
    subtasks,
    recurrence: VALID_RECURRENCES.includes(raw.recurrence) ? raw.recurrence : "",
    recurrenceSpawnedId:
      typeof raw.recurrenceSpawnedId === "string" && raw.recurrenceSpawnedId ? raw.recurrenceSpawnedId : null,
    createdAt,
    updatedAt,
    completedAt: status === "done" && logicIsValidDateKey(raw.completedAt) ? raw.completedAt : null,
  };
  if (raw.isSample === true) task.isSample = true;
  return task;
}

/**
 * Normalize a task list, dropping non-objects and duplicate ids (first wins).
 */
function normalizeTaskList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  rawList.forEach((item) => {
    const t = normalizeTask(item);
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
  });
  return out;
}

/**
 * Pure offline equivalent of server.py:update_task_with_spawn.
 * Validates all fields identically, tracks previousStatus, clears isSample,
 * and spawns the next recurring copy once on non-done -> done transitions.
 * Returns { tasks, task, spawnedTask } or null if taskId is not found.
 */
function applyTaskPatch(taskList, taskId, patch, today = new Date(), nowMs = Date.now()) {
  const list = Array.isArray(taskList) ? taskList : [];
  const idx = list.findIndex((item) => item && item.id === taskId);
  if (idx === -1) return null;

  const updates = patch && typeof patch === "object" ? patch : {};
  const existing = list[idx];
  const updated = {
    ...existing,
    subtasks: Array.isArray(existing.subtasks) ? existing.subtasks.map((s) => ({ ...s })) : [],
  };

  if (typeof updates.title === "string") {
    const trimmed = updates.title.trim();
    if (trimmed) updated.title = trimmed;
  }

  if (typeof updates.dueDate === "string") {
    const cleanDate = updates.dueDate.trim();
    if (cleanDate === "" || logicIsValidDateKey(cleanDate)) {
      updated.dueDate = cleanDate;
    }
  }

  if (typeof updates.notes === "string") {
    updated.notes = updates.notes;
  }

  if (Array.isArray(updates.subtasks)) {
    const cleanSubs = [];
    updates.subtasks.forEach((st) => {
      if (!st || typeof st !== "object") return;
      const text = typeof st.text === "string" ? st.text.trim() : "";
      if (!text) return;
      cleanSubs.push({
        id: typeof st.id === "string" && st.id ? st.id : makeId("st"),
        text,
        done: st.done === true,
      });
    });
    updated.subtasks = cleanSubs;
  }

  if (VALID_RECURRENCES.includes(updates.recurrence)) {
    updated.recurrence = updates.recurrence;
  }

  let spawnedTask = null;
  if (LOGIC_VALID_STATUSES.includes(updates.status)) {
    const oldStatus = updated.status;
    const newStatus = updates.status;
    updated.status = newStatus;

    if (newStatus === "done") {
      if (oldStatus !== "done") {
        updated.previousStatus = oldStatus === "today" ? "today" : "inbox";
        updated.completedAt = toDateKey(today);

        const existingSpawn =
          updated.recurrenceSpawnedId &&
          list.some((other) => other && other.id === updated.recurrenceSpawnedId);
        if (updated.recurrence && !existingSpawn) {
          const nextDue = getNextRecurrenceDate(
            updated.dueDate || toDateKey(today),
            updated.recurrence,
            today
          );
          if (nextDue) {
            const spawnedId = makeId("t");
            updated.recurrenceSpawnedId = spawnedId;
            spawnedTask = {
              id: spawnedId,
              title: updated.title,
              dueDate: nextDue,
              status: "inbox",
              previousStatus: "inbox",
              notes: updated.notes || "",
              subtasks: updated.subtasks.map((s) => ({
                id: makeId("st"),
                text: s.text,
                done: false,
              })),
              recurrence: updated.recurrence,
              recurrenceSpawnedId: null,
              createdAt: nowMs,
              updatedAt: nowMs,
              completedAt: null,
            };
          }
        }
      }
    } else {
      updated.completedAt = null;
      updated.previousStatus = newStatus;
      // Intentionally preserve dueDate === "" for undated Today tasks
    }
  }

  delete updated.isSample;
  updated.updatedAt = nowMs;

  const nextTasks = list.map((item, i) => (i === idx ? updated : item));
  if (spawnedTask) {
    nextTasks.unshift(spawnedTask);
  }
  return { tasks: nextTasks, task: updated, spawnedTask };
}

/**
 * Pure merge matching server.py:import_tasks(mode="merge").
 * Preserves existing order, updates an existing id only when incoming.updatedAt > existing.updatedAt,
 * and appends new tasks.
 */
function mergeTaskLists(existingList, incomingList) {
  const merged = normalizeTaskList(existingList);
  const index = new Map();
  merged.forEach((t, i) => index.set(t.id, i));

  normalizeTaskList(incomingList).forEach((inc) => {
    const i = index.get(inc.id);
    if (i === undefined) {
      index.set(inc.id, merged.length);
      merged.push(inc);
    } else if ((inc.updatedAt || 0) > (merged[i].updatedAt || 0)) {
      merged[i] = inc;
    }
  });

  return merged;
}

// Export for Node.js tests if running in a test environment, while staying simple in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    HORIZON_DAYS,
    VALID_RECURRENCES,
    toDateKey,
    parseDateKey,
    addDaysToKey,
    daysUntil,
    formatDaysLabel,
    formatShortDate,
    getGradientStyle,
    getTimelineWidthPercent,
    getMonthMarkers,
    countCompletedThisWeek,
    sortTasksByUrgency,
    getNextRecurrenceDate,
    extractTags,
    getAllTags,
    parseQuickCapture,
    makeId,
    normalizeTask,
    normalizeTaskList,
    applyTaskPatch,
    mergeTaskLists,
  };
}
