/**
 * logic.js — Horizon Domain Logic (Single Source of Truth)
 *
 * Pure, dependency-free functions shared by browser UI (app.js) and Node tests.
 * No DOM, no fetch, no storage I/O here.
 *
 * Sections:
 *   1. Constants & Date Math (DST-safe local calendar arithmetic + quick capture)
 *   2. Schema v2 Normalization, v1 Migration & Multi-PC Merge
 *   3. Task Transitions, Starter Samples, Fading Ink & Morning Check-in
 *   4. Urgency Gradient, Timeline Geometry & Sorting
 *
 * Key Invariants (enforced in normalizeTask):
 *   - list:  "today" | "later" | "done"  (v1 "inbox" migrates to "later")
 *   - stage: "todo"  | "started" | "waiting"
 *   - list === "done"     => stage = "todo", waitingOn = null, completedAt set
 *   - stage === "waiting" => non-empty waitingOn (else falls back to "started")
 *                            and list !== "today" (moved to "later")
 *   - invalid dueDate     => sanitized to ""
 */

const SCHEMA_VERSION = 2;
const HORIZON_DAYS = 90;
const TODAY_CAP = 3;
const MAX_SUBTASKS = 7;
const MAX_NOTES_LENGTH = 4000;
const FRESH_DAYS = 7;
const STALE_DAYS = 14;
const MILESTONE_SAFE_DAYS = 21;
const TOMBSTONE_TTL_DAYS = 30;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const URL_TOKEN_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

// ============================================================================
// 1. Date Math (local calendar dates, DST-safe)
// ============================================================================

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Strict YYYY-MM-DD parser. Rejects invalid calendars like 2026-02-30 or 2026-13-45. */
function parseDateKey(dateKey) {
  if (!dateKey || typeof dateKey !== "string") return null;
  const match = DATE_KEY_RE.exec(dateKey.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const parsed = new Date(y, m - 1, d);
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
    return null;
  }
  return parsed;
}

/** Add whole calendar days to a Date or YYYY-MM-DD key (DST-safe). */
function addDaysKey(base, deltaDays) {
  const d = typeof base === "string" ? parseDateKey(base) : new Date(base.getTime());
  if (!d) return "";
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays));
}

/** Next occurrence of weekday (0=Sun..6=Sat), always strictly in the future (1..7 days). */
function getNextWeekdayKey(targetDow, today = new Date()) {
  const diff = (targetDow - today.getDay() + 7) % 7 || 7;
  return addDaysKey(today, diff);
}

/**
 * Parse lightweight quick-capture tokens from title text:
 *   !today, #personal/#p, #work/#w,
 *   @today, @tom/@tomorrow, @+1w, @+2w, @+1m, @mon..@sun
 * Returns { title, list, area, dueDate } without altering normal words.
 */
function parseQuickCapture(rawText, today = new Date()) {
  const dowMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let list = null;
  let area = null;
  let dueDate = null;
  const kept = [];

  for (const token of String(rawText || "").trim().split(/\s+/)) {
    if (!token) continue;
    const low = token.toLowerCase();
    if (low === "!today") {
      list = "today";
      continue;
    }
    if (low === "#personal" || low === "#p") {
      area = "personal";
      continue;
    }
    if (low === "#work" || low === "#w") {
      area = "work";
      continue;
    }
    if (low === "@today") {
      dueDate = toDateKey(today);
      continue;
    }
    if (low === "@tom" || low === "@tomorrow") {
      dueDate = addDaysKey(today, 1);
      continue;
    }
    if (low === "@+1w") {
      dueDate = addDaysKey(today, 7);
      continue;
    }
    if (low === "@+2w") {
      dueDate = addDaysKey(today, 14);
      continue;
    }
    if (low === "@+1m") {
      dueDate = addDaysKey(today, 30);
      continue;
    }
    if (low.startsWith("@") && Object.prototype.hasOwnProperty.call(dowMap, low.slice(1))) {
      dueDate = getNextWeekdayKey(dowMap[low.slice(1)], today);
      continue;
    }
    kept.push(token);
  }

  return { title: kept.join(" ").trim(), list, area, dueDate };
}

/** Whole calendar days from today to dueDateKey (UTC-noon diff avoids DST drift). */
function daysUntil(dueDateKey, today = new Date()) {
  const due = parseDateKey(dueDateKey);
  if (!due) return null;
  const dueUtc = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((dueUtc - todayUtc) / 86400000);
}

function formatDaysLabel(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return "";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days}d`;
}

function formatShortDate(dateKey) {
  const d = parseDateKey(dateKey);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ============================================================================
// 2. Schema v2 Normalization, v1 Migration & Multi-PC Merge
// ============================================================================

/**
 * Normalize flat checklist steps.
 * - Preserves up to 20 imported steps (UI caps new additions at MAX_SUBTASKS = 7).
 * - Deduplicates step IDs so toggling/deleting one step never collides with another.
 * - When loading from disk (todayStr = null), legacy done steps without completedAt keep null
 *   rather than falsely counting toward "this week".
 */
function normalizeSubtasks(raw, todayStr = null) {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set();
  const result = [];
  for (const s of raw) {
    if (result.length >= 20) break;
    if (!s || typeof s !== "object" || typeof s.title !== "string" || !s.title.trim()) continue;
    let id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : `s-${result.length + 1}`;
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    seenIds.add(id);
    const done = Boolean(s.done);
    const validComp = parseDateKey(s.completedAt) ? s.completedAt.trim() : null;
    result.push({
      id,
      title: s.title.trim(),
      done,
      completedAt: done ? (validComp || todayStr) : null,
    });
  }
  return result;
}

/**
 * Normalize any v1 or v2 task object into a canonical v2 task while preserving
 * unknown fields for forward compatibility.
 */
function normalizeTask(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const nowMs = now.getTime();
  const todayStr = toDateKey(now);

  // Preserve unknown properties while removing legacy v1 "status" once migrated
  const base = { ...raw };
  delete base.status;

  const rawList = raw.list || raw.status || "later";
  let list = rawList === "inbox" ? "later" : rawList;
  if (list !== "today" && list !== "later" && list !== "done") list = "later";

  const area = raw.area === "personal" ? "personal" : "work";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title && !raw.deleted) return null;

  const validDue = parseDateKey(raw.dueDate) ? raw.dueDate.trim() : "";
  const dueDateAuto = Boolean(raw.dueDateAuto && validDue);

  let stage = raw.stage === "started" || raw.stage === "waiting" ? raw.stage : "todo";
  let waitingOn = typeof raw.waitingOn === "string" ? raw.waitingOn.trim() : "";
  const nextStep = typeof raw.nextStep === "string" ? raw.nextStep.trim() : "";

  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : nowMs;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  const touchedAt = typeof raw.touchedAt === "number" && Number.isFinite(raw.touchedAt) ? raw.touchedAt : createdAt;

  const deleted = Boolean(raw.deleted);
  const deletedAt = deleted
    ? (typeof raw.deletedAt === "number" && Number.isFinite(raw.deletedAt) ? raw.deletedAt : updatedAt)
    : null;

  let completedAt = null;
  if (list === "done") {
    stage = "todo";
    waitingOn = "";
    completedAt = parseDateKey(raw.completedAt) ? raw.completedAt.trim() : todayStr;
  } else {
    if (stage === "waiting") {
      if (!waitingOn) {
        stage = "started";
      } else if (list === "today") {
        // Waiting tasks cannot occupy a Today focus slot
        list = "later";
      }
    }
    if (stage !== "waiting") waitingOn = "";
  }

  const prevList = raw.prevList === "today" ? "today" : "later";
  const snoozedUntil = parseDateKey(raw.snoozedUntil) ? raw.snoozedUntil.trim() : null;
  const rawId = raw.id !== null && raw.id !== undefined ? String(raw.id).trim() : "";
  const id = rawId || `t-${nowMs}-${Math.random().toString(36).slice(2, 7)}`;

  const task = {
    ...base,
    id,
    title: title || "(deleted)",
    area,
    list,
    stage,
    dueDate: validDue,
    dueDateAuto,
    prevList,
    nextStep,
    waitingOn: waitingOn || null,
    subtasks: normalizeSubtasks(raw.subtasks, null),
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, MAX_NOTES_LENGTH) : "",
    createdAt,
    touchedAt,
    updatedAt,
    snoozedUntil,
    completedAt,
    deleted,
    deletedAt,
  };

  if (raw.isSample) task.isSample = true;
  else delete task.isSample;

  return task;
}

/**
 * Parse either a v1 bare task array or a v2 envelope object.
 * Throws Error on malformed root shapes.
 */
function parseTaskDocument(raw, now = new Date()) {
  let rawTasks;
  let wasV1 = false;
  let savedAt = null;
  let savedBy = null;

  if (Array.isArray(raw)) {
    rawTasks = raw;
    wasV1 = true;
  } else if (raw && typeof raw === "object" && Array.isArray(raw.tasks)) {
    rawTasks = raw.tasks;
    wasV1 = Number(raw.schema) < SCHEMA_VERSION;
    savedAt = typeof raw.savedAt === "string" ? raw.savedAt : null;
    savedBy = typeof raw.savedBy === "string" ? raw.savedBy : null;
  } else {
    throw new Error("Expected a Horizon tasks.json array or schema-2 object.");
  }

  const seen = new Set();
  const tasks = [];
  for (const item of rawTasks) {
    const t = normalizeTask(item, now);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      tasks.push(t);
    }
  }

  return { schema: SCHEMA_VERSION, wasV1, savedAt, savedBy, tasks };
}

function pruneTombstones(tasks, nowMs = Date.now()) {
  const cutoff = nowMs - TOMBSTONE_TTL_DAYS * 86400000;
  return tasks.filter((t) => !t.deleted || (t.deletedAt || t.updatedAt || 0) >= cutoff);
}

function serializeTaskDocument(tasks, savedBy = "local", now = new Date()) {
  const cleaned = pruneTombstones(
    tasks.map((t) => normalizeTask(t, now)).filter(Boolean),
    now.getTime()
  );
  return {
    schema: SCHEMA_VERSION,
    savedAt: now.toISOString(),
    savedBy,
    tasks: cleaned,
  };
}

/**
 * Conflict-free merge of two task lists by id using updatedAt (last-write-wins).
 * Deleted tasks are kept as tombstones for TOMBSTONE_TTL_DAYS so deletes sync across PCs.
 */
function mergeTaskLists(localTasks, remoteTasks, now = new Date()) {
  const byId = new Map();
  const order = [];

  const insert = (list, isRemote) => {
    for (const raw of list || []) {
      const task = normalizeTask(raw, now);
      if (!task) continue;
      const existing = byId.get(task.id);
      if (!existing) {
        byId.set(task.id, task);
        order.push(task.id);
      } else if (
        task.updatedAt > existing.updatedAt ||
        (task.updatedAt === existing.updatedAt && (isRemote || task.deleted))
      ) {
        byId.set(task.id, task);
      }
    }
  };

  insert(remoteTasks, true);
  insert(localTasks, false);
  return pruneTombstones(order.map((id) => byId.get(id)), now.getTime());
}

// ============================================================================
// 3. Task Transitions & Starter Samples
// ============================================================================

function createTask({ title, dueDate = "", list = "later", area = "work", stage = "todo", nextStep = "", waitingOn = null }, now = new Date()) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) throw new Error("Task title cannot be empty");

  const validDue = parseDateKey(dueDate) ? dueDate.trim() : "";
  const isToday = list === "today" && stage !== "waiting";
  const resolvedDue = isToday && !validDue ? toDateKey(now) : validDue;
  const dueDateAuto = isToday && !validDue;
  const nowMs = now.getTime();

  return normalizeTask(
    {
      id: `t-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
      title: cleanTitle,
      area,
      list: isToday ? "today" : "later",
      stage,
      dueDate: resolvedDue,
      dueDateAuto,
      prevList: isToday ? "today" : "later",
      nextStep,
      waitingOn,
      subtasks: [],
      notes: "",
      createdAt: nowMs,
      touchedAt: nowMs,
      updatedAt: nowMs,
      snoozedUntil: null,
      completedAt: null,
      deleted: false,
      deletedAt: null,
    },
    now
  );
}

/**
 * Pure state transition for editing a task.
 * Preserves prevList on done, clears auto-dates on Today->Later, updates touchedAt intentionally.
 */
function applyTaskTransition(task, patch, now = new Date()) {
  const next = { ...task };
  const nowMs = now.getTime();
  const todayStr = toDateKey(now);
  let touched = Boolean(patch.touch);

  if (patch.title !== undefined && typeof patch.title === "string") {
    const clean = patch.title.trim();
    if (clean && clean !== next.title) {
      next.title = clean;
      touched = true;
    }
  }

  if (patch.area === "work" || patch.area === "personal") {
    if (patch.area !== next.area) touched = true;
    next.area = patch.area;
  }

  if (patch.dueDate !== undefined) {
    const cleanDue = parseDateKey(patch.dueDate) ? patch.dueDate.trim() : "";
    if (cleanDue !== next.dueDate) touched = true;
    next.dueDate = cleanDue;
    next.dueDateAuto = false;
  }

  if (patch.nextStep !== undefined && typeof patch.nextStep === "string") {
    const cleanStep = patch.nextStep.trim();
    if (cleanStep !== next.nextStep) touched = true;
    next.nextStep = cleanStep;
  }

  if (patch.waitingOn !== undefined) {
    next.waitingOn = typeof patch.waitingOn === "string" ? patch.waitingOn.trim() || null : null;
    touched = true;
  }

  if (patch.stage === "todo" || patch.stage === "started" || patch.stage === "waiting") {
    if (patch.stage !== next.stage) touched = true;
    next.stage = patch.stage;
    if (patch.stage === "waiting" && next.list === "today") {
      next.list = "later";
    }
  }

  if (patch.subtasks !== undefined) {
    next.subtasks = normalizeSubtasks(patch.subtasks, todayStr);
    touched = true;
  }

  if (patch.notes !== undefined && typeof patch.notes === "string") {
    next.notes = patch.notes;
    touched = true;
  }

  if (patch.snoozedUntil !== undefined) {
    next.snoozedUntil = parseDateKey(patch.snoozedUntil) ? patch.snoozedUntil.trim() : null;
  }

  const targetList = patch.list !== undefined ? patch.list : patch.status === "inbox" ? "later" : patch.status;
  if (targetList === "today" || targetList === "later" || targetList === "done") {
    if (targetList !== next.list) touched = true;

    if (targetList === "done") {
      next.prevList = next.list === "today" ? "today" : "later";
      next.list = "done";
      next.completedAt = todayStr;
    } else if (targetList === "today") {
      next.list = "today";
      next.completedAt = null;
      if (next.stage === "waiting") next.stage = "started";
      if (!next.dueDate) {
        next.dueDate = todayStr;
        next.dueDateAuto = true;
      }
    } else {
      // Moving to "later" clears an auto-anchored today date so undated tasks don't become overdue
      if (next.dueDateAuto) {
        next.dueDate = "";
        next.dueDateAuto = false;
      }
      next.list = "later";
      next.completedAt = null;
    }
  }

  if (patch.deleted === true) {
    next.deleted = true;
    next.deletedAt = nowMs;
  } else if (patch.deleted === false) {
    next.deleted = false;
    next.deletedAt = null;
  }

  next.updatedAt = nowMs;
  if (touched) next.touchedAt = nowMs;
  return normalizeTask(next, now);
}

function createSampleTasks(now = new Date()) {
  const nowMs = now.getTime();
  return [
    normalizeTask({
      id: "sample-1",
      title: "Finalize Q1 vendor proposal",
      area: "work",
      list: "today",
      stage: "started",
      dueDate: addDaysKey(now, 2),
      nextStep: "Verify pricing table on slide 4 and send draft",
      subtasks: [
        { id: "s-1", title: "Collect vendor quotes", done: true, completedAt: toDateKey(now) },
        { id: "s-2", title: "Verify pricing table on slide 4", done: false, completedAt: null },
        { id: "s-3", title: "Send draft for review", done: false, completedAt: null },
      ],
      notes: "",
      createdAt: nowMs - 4000,
      isSample: true,
    }, now),
    normalizeTask({
      id: "sample-2",
      title: "Legal sign-off on contract renewal",
      area: "work",
      list: "later",
      stage: "waiting",
      waitingOn: "Ana (Legal)",
      dueDate: addDaysKey(now, 11),
      nextStep: "Ping if no reply by Thursday",
      createdAt: nowMs - 3000,
      isSample: true,
    }, now),
    normalizeTask({
      id: "sample-3",
      title: "Renew car insurance",
      area: "personal",
      list: "later",
      stage: "todo",
      dueDate: addDaysKey(now, 34),
      createdAt: nowMs - 2000,
      isSample: true,
    }, now),
    normalizeTask({
      id: "sample-4",
      title: "Prepare quarterly architecture review",
      area: "work",
      list: "later",
      stage: "todo",
      dueDate: addDaysKey(now, 68),
      createdAt: nowMs - 1000,
      isSample: true,
    }, now),
    normalizeTask({
      id: "sample-5",
      title: "Clean up project notes & bookmarks",
      area: "work",
      list: "later",
      stage: "todo",
      dueDate: "",
      createdAt: nowMs - 16 * 86400000,
      touchedAt: nowMs - 16 * 86400000,
      updatedAt: nowMs - 16 * 86400000,
      isSample: true,
    }, now),
  ];
}

// ============================================================================
// 3b. Fading Ink Freshness & Morning Check-in Summary
// ============================================================================

/**
 * Compute ink freshness for an active task.
 * - Full dark ink (1.0) for 0..7 days untouched; fades smoothly to 0.68 by day 14 (WCAG AA legible).
 * - Exempts done, waiting, and tasks snoozed through snoozedUntil (inclusive).
 * - Long-horizon milestones (>21d away) stay fresh; once inside 21d, age counts from max(touchedAt, dueDate - 21d)
 *   so they fade smoothly instead of dropping overnight.
 */
function getTaskFreshness(task, today = new Date()) {
  if (!task || task.deleted || task.list === "done" || task.stage === "waiting") {
    return { daysUntouched: 0, opacity: 1, isFading: false, isStale: false };
  }
  if (task.snoozedUntil) {
    const snoozeDays = daysUntil(task.snoozedUntil, today);
    if (snoozeDays !== null && snoozeDays >= 0) {
      return { daysUntouched: 0, opacity: 1, isFading: false, isStale: false };
    }
  }

  let refDate = new Date(task.touchedAt || task.createdAt || today.getTime());
  if (task.dueDate) {
    const dueDays = daysUntil(task.dueDate, today);
    if (dueDays !== null && dueDays > MILESTONE_SAFE_DAYS) {
      return { daysUntouched: 0, opacity: 1, isFading: false, isStale: false };
    }
    if (dueDays !== null) {
      const windowStart = parseDateKey(addDaysKey(task.dueDate, -MILESTONE_SAFE_DAYS));
      if (windowStart && windowStart.getTime() > refDate.getTime()) {
        refDate = windowStart;
      }
    }
  }

  const daysUntouched = Math.max(0, daysUntil(toDateKey(today), refDate) ?? 0);

  if (daysUntouched <= FRESH_DAYS) {
    return { daysUntouched, opacity: 1, isFading: false, isStale: false };
  }
  if (daysUntouched >= STALE_DAYS) {
    return { daysUntouched, opacity: 0.68, isFading: true, isStale: true };
  }
  const ratio = (daysUntouched - FRESH_DAYS) / (STALE_DAYS - FRESH_DAYS);
  const opacity = Number((1 - ratio * 0.32).toFixed(2));
  return { daysUntouched, opacity, isFading: true, isStale: false };
}

/**
 * Build the daily Morning Check-in counts and ordered walk-through card stack.
 * Order: all started tasks -> due soon (<=7d / overdue) -> waiting -> fading (14d+).
 */
function getMorningCheckinData(tasks, today = new Date()) {
  const active = (tasks || []).filter((t) => t && !t.deleted && t.list !== "done");
  const started = sortTasksByUrgency(active.filter((t) => t.stage === "started"), today);
  const waiting = sortTasksByUrgency(active.filter((t) => t.stage === "waiting"), today);

  const dueSoon = sortTasksByUrgency(
    active.filter((t) => {
      if (t.stage === "waiting" || !t.dueDate) return false;
      const d = daysUntil(t.dueDate, today);
      return d !== null && d <= 7;
    }),
    today
  );

  const fading = sortTasksByUrgency(
    active.filter((t) => getTaskFreshness(t, today).isStale),
    today
  );

  const seen = new Set();
  const cards = [];
  const pushCard = (task, kind) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    cards.push({ task, kind });
  };

  started.forEach((t) => pushCard(t, "started"));
  dueSoon.forEach((t) => pushCard(t, "dueSoon"));
  waiting.forEach((t) => pushCard(t, "waiting"));
  fading.forEach((t) => pushCard(t, "fading"));

  return {
    counts: {
      started: started.length,
      waiting: waiting.length,
      dueSoon: dueSoon.length,
      fading: fading.length,
    },
    cards,
  };
}

// ============================================================================
// 4. Urgency Gradient, Timeline Geometry & Sorting
// ============================================================================

function getGradientStyle(daysLeft, area = "work") {
  if (daysLeft === null || daysLeft === undefined || Number.isNaN(daysLeft)) {
    return {
      closeness: 0,
      startAlpha: 0.08,
      endAlpha: 0.22,
      background: "linear-gradient(to right, rgba(110, 97, 80, 0.08) 0%, rgba(110, 97, 80, 0.22) 100%)",
      borderColor: "rgb(110, 97, 80)",
      textColor: "#231e18",
      badgeBg: "rgba(110, 97, 80, 0.14)",
      badgeColor: "rgb(80, 67, 50)",
    };
  }

  const clamped = Math.max(0, Math.min(HORIZON_DAYS, daysLeft));
  const closeness = 1 - clamped / HORIZON_DAYS;

  let rgb;
  if (area === "personal") {
    // Cool slate-blue ramp for personal items so they stay distinct without badges
    if (daysLeft < 0) rgb = [155, 52, 58];
    else if (daysLeft <= 3) rgb = [62, 95, 132];
    else if (daysLeft <= 14) rgb = [74, 110, 140];
    else if (daysLeft <= 35) rgb = [88, 120, 138];
    else rgb = [104, 128, 138];
  } else {
    // Warm Paper Desk palette: calm sage -> ochre -> burnt sienna -> terracotta -> brick
    if (daysLeft < 0) rgb = [168, 38, 32];
    else if (daysLeft <= 3) rgb = [185, 58, 46];
    else if (daysLeft <= 14) rgb = [196, 108, 43];
    else if (daysLeft <= 35) rgb = [168, 134, 58];
    else rgb = [92, 118, 106];
  }

  const [r, g, b] = rgb;
  const startAlpha = Number((0.03 + closeness * 0.34).toFixed(2));
  const endAlpha = Number((0.26 + closeness * 0.74).toFixed(2));
  const useLightText = daysLeft <= 14;

  return {
    closeness: Number(closeness.toFixed(3)),
    startAlpha,
    endAlpha,
    background: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, ${startAlpha}) 0%, rgba(${r}, ${g}, ${b}, ${endAlpha}) 100%)`,
    borderColor: `rgb(${r}, ${g}, ${b})`,
    textColor: useLightText ? "#fdfaf4" : "#231e18",
    badgeBg: `rgba(${r}, ${g}, ${b}, ${Number((0.11 + closeness * 0.2).toFixed(2))})`,
    badgeColor: `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)})`,
  };
}

function getTimelineWidthPercent(daysLeft) {
  if (daysLeft === null || daysLeft === undefined || Number.isNaN(daysLeft) || daysLeft <= 0) {
    return 2.5;
  }
  const clamped = Math.min(HORIZON_DAYS, daysLeft);
  const rawPercent = (clamped / HORIZON_DAYS) * 100;
  return Math.max(2.5, Number(rawPercent.toFixed(2)));
}

/** Progress fill ratio (0..1) drawn inside a started bar on the timeline. */
function getTaskProgressRatio(task) {
  if (!task || task.stage !== "started") return 0;
  const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
  if (subs.length > 0) {
    const done = subs.filter((s) => s.done).length;
    return Math.max(0.08, done / subs.length);
  }
  return 0.08;
}

function getMonthMarkers(today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const markers = [{ label: "Today", percent: 0, isToday: true }];

  for (let offset = 1; offset <= HORIZON_DAYS; offset++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (d.getDate() === 1) {
      const percent = Number(((offset / HORIZON_DAYS) * 100).toFixed(2));
      if (percent >= 8 && percent <= 94) {
        markers.push({
          label: d.toLocaleDateString(undefined, { month: "short", year: d.getMonth() === 0 ? "numeric" : undefined }),
          percent,
          isToday: false,
        });
      }
    }
  }
  return markers;
}

/** Count non-deleted tasks completed in the last 7 calendar days (inclusive, DST-safe). */
function countCompletedThisWeek(tasks, today = new Date()) {
  return getWeeklyMomentum(tasks, today, { lastWeek: false }).tasksDone;
}

/**
 * Compute weekly wins (completed tasks + completed subtask steps).
 * - lastWeek: false -> rolling 7 days [today-6d .. today]
 * - lastWeek: true  -> previous 7 days [today-7d .. today-1d] (ideal for Monday check-in)
 */
function getWeeklyMomentum(tasks, today = new Date(), { lastWeek = false } = {}) {
  const endDate = lastWeek
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 6);

  let tasksDone = 0;
  let stepsDone = 0;

  for (const t of tasks || []) {
    if (!t || t.deleted) continue;
    const isDone = t.list === "done" || t.status === "done";
    if (isDone && t.completedAt) {
      const d = parseDateKey(t.completedAt);
      if (d && d >= startDate && d <= endDate) tasksDone += 1;
    }
    if (Array.isArray(t.subtasks)) {
      for (const s of t.subtasks) {
        if (s && s.done && s.completedAt) {
          const sd = parseDateKey(s.completedAt);
          if (sd && sd >= startDate && sd <= endDate) stepsDone += 1;
        }
      }
    }
  }
  return { tasksDone, stepsDone };
}

/**
 * Safely split freeform note text into plain text and http(s) link tokens (no HTML parsing).
 * Strips trailing sentence punctuation from URLs cleanly.
 */
function tokenizeNotes(text) {
  const src = String(text || "");
  if (!src) return [];
  const tokens = [];
  let cursor = 0;
  URL_TOKEN_RE.lastIndex = 0;

  let match;
  while ((match = URL_TOKEN_RE.exec(src)) !== null) {
    if (match.index > cursor) {
      tokens.push({ type: "text", value: src.slice(cursor, match.index) });
    }
    let url = match[0];
    while (url.length > 0 && /[.,;:!?)]$/.test(url)) {
      if (url.endsWith(")")) {
        const opens = (url.match(/\(/g) || []).length;
        const closes = (url.match(/\)/g) || []).length;
        if (closes <= opens) break;
      }
      url = url.slice(0, -1);
    }
    if (/^https?:\/\/\S+$/i.test(url)) {
      tokens.push({ type: "link", href: url, label: url });
      cursor = match.index + url.length;
    } else {
      cursor = match.index;
    }
  }

  if (cursor < src.length) {
    tokens.push({ type: "text", value: src.slice(cursor) });
  }
  return tokens;
}

/** Sort active tasks: soonest valid deadline first, then started before todo, then newest. */
function sortTasksByUrgency(tasks, today = new Date()) {
  const stageRank = { started: 0, todo: 1, waiting: 2 };
  return [...tasks].sort((a, b) => {
    const da = a.dueDate ? daysUntil(a.dueDate, today) : null;
    const db = b.dueDate ? daysUntil(b.dueDate, today) : null;
    const va = da === null ? Infinity : da;
    const vb = db === null ? Infinity : db;
    if (va !== vb) return va - vb;
    const sa = stageRank[a.stage] ?? 1;
    const sb = stageRank[b.stage] ?? 1;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCHEMA_VERSION,
    HORIZON_DAYS,
    TODAY_CAP,
    MAX_SUBTASKS,
    MAX_NOTES_LENGTH,
    FRESH_DAYS,
    STALE_DAYS,
    MILESTONE_SAFE_DAYS,
    TOMBSTONE_TTL_DAYS,
    toDateKey,
    parseDateKey,
    addDaysKey,
    getNextWeekdayKey,
    parseQuickCapture,
    daysUntil,
    formatDaysLabel,
    formatShortDate,
    normalizeTask,
    parseTaskDocument,
    serializeTaskDocument,
    mergeTaskLists,
    createTask,
    applyTaskTransition,
    createSampleTasks,
    getTaskFreshness,
    getMorningCheckinData,
    getGradientStyle,
    getTimelineWidthPercent,
    getTaskProgressRatio,
    getMonthMarkers,
    countCompletedThisWeek,
    getWeeklyMomentum,
    tokenizeNotes,
    sortTasksByUrgency,
  };
}
