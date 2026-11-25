/**
 * logic.test.js — Automated tests for logic.js (dates, v2 schema, migration, merge, timeline)
 * Run with: node logic.test.js
 */
const assert = require("assert");
const logic = require("./logic.js");

const fixedToday = new Date(2026, 10, 23); // Nov 23, 2026

function parseRgb(str) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// 1. Strict date parsing & DST-safe day counting
assert.strictEqual(logic.toDateKey(fixedToday), "2026-11-23");
assert.strictEqual(logic.daysUntil("2026-11-23", fixedToday), 0);
assert.strictEqual(logic.daysUntil("2026-11-25", fixedToday), 2);
assert.strictEqual(logic.daysUntil("2026-11-21", fixedToday), -2);
assert.strictEqual(logic.parseDateKey("2026-13-45"), null, "Must reject rollover month/day");
assert.strictEqual(logic.parseDateKey("2026-02-30"), null, "Must reject Feb 30");
assert.strictEqual(logic.parseDateKey("not-a-date"), null);
assert.strictEqual(logic.daysUntil("bad", fixedToday), null);

// DST spring-forward boundary check (Mar 2026 US/EU window)
const beforeSpringDst = new Date(2026, 2, 7);
assert.strictEqual(logic.daysUntil("2026-03-10", beforeSpringDst), 3);

// 2. Human-friendly labels
assert.strictEqual(logic.formatDaysLabel(0), "Today");
assert.strictEqual(logic.formatDaysLabel(1), "Tomorrow");
assert.strictEqual(logic.formatDaysLabel(15), "In 15d");
assert.strictEqual(logic.formatDaysLabel(-3), "3d overdue");
assert.strictEqual(logic.formatDaysLabel(null), "");

// 3. Gradient progression, null safety & personal area tint
const far = logic.getGradientStyle(85);
const mid = logic.getGradientStyle(30);
const close = logic.getGradientStyle(2);
const dueToday = logic.getGradientStyle(0);
const invalidStyle = logic.getGradientStyle(null);
const personalStyle = logic.getGradientStyle(10, "personal");

assert.ok(far.startAlpha < mid.startAlpha && mid.startAlpha < close.startAlpha);
assert.ok(far.endAlpha < mid.endAlpha && mid.endAlpha < close.endAlpha);
assert.strictEqual(dueToday.endAlpha, 1);
assert.strictEqual(dueToday.textColor, "#fdfaf4");
assert.strictEqual(invalidStyle.textColor, "#231e18", "Null daysLeft must not render as urgent red");
assert.notStrictEqual(personalStyle.borderColor, close.borderColor, "Personal area should use distinct cool tint");

// 4. Timeline width, progress fill & month markers
assert.strictEqual(logic.getTimelineWidthPercent(90), 100);
assert.strictEqual(logic.getTimelineWidthPercent(45), 50);
assert.strictEqual(logic.getTimelineWidthPercent(1), 2.5);
assert.strictEqual(logic.getTimelineWidthPercent(null), 2.5);

assert.strictEqual(logic.getTaskProgressRatio({ stage: "todo" }), 0);
assert.strictEqual(logic.getTaskProgressRatio({ stage: "started", subtasks: [] }), 0.08);
assert.strictEqual(
  logic.getTaskProgressRatio({ stage: "started", subtasks: [{ done: true }, { done: false }] }),
  0.5
);

const markers = logic.getMonthMarkers(fixedToday);
assert.ok(markers.length >= 3);
assert.strictEqual(markers[0].isToday, true);

// 5. v1 -> v2 migration & normalizeTask invariants
const v1Array = [
  { id: "v1-1", title: "Old inbox task", status: "inbox", dueDate: "2026-12-01", createdAt: 1000, customField: "keep-me" },
  { id: 42, title: "Numeric id task", status: "today", dueDate: "2026-99-99", createdAt: 2000 },
  { id: "v1-3", title: "Done task", status: "done", completedAt: "2026-11-22", createdAt: 3000 },
  "junk-string-ignored",
];
const migrated = logic.parseTaskDocument(v1Array, fixedToday);
assert.strictEqual(migrated.schema, 2);
assert.strictEqual(migrated.wasV1, true);
assert.strictEqual(migrated.tasks.length, 3);
assert.strictEqual(migrated.tasks[0].list, "later", "v1 inbox must migrate to later");
assert.strictEqual(migrated.tasks[0].status, undefined, "Legacy status key should be dropped");
assert.strictEqual(migrated.tasks[0].customField, "keep-me", "Unknown fields must be preserved");
assert.strictEqual(migrated.tasks[1].id, "42", "Numeric IDs must stay stable as strings");
assert.strictEqual(migrated.tasks[1].dueDate, "", "Invalid dueDate must sanitize to empty string");
assert.strictEqual(migrated.tasks[2].completedAt, "2026-11-22");

// Invariant: waiting without waitingOn falls back to started
const badWaiting = logic.normalizeTask({ title: "Follow up", list: "today", stage: "waiting", waitingOn: "   " }, fixedToday);
assert.strictEqual(badWaiting.stage, "started");

// Invariant: waiting with waitingOn moves out of today into later
const realWaiting = logic.normalizeTask({ title: "Contract", list: "today", stage: "waiting", waitingOn: "Ana" }, fixedToday);
assert.strictEqual(realWaiting.stage, "waiting");
assert.strictEqual(realWaiting.list, "later");

// Invariant: done clears stage & waitingOn but keeps nextStep
const doneCleared = logic.normalizeTask({
  title: "Ship it",
  list: "done",
  stage: "waiting",
  waitingOn: "Bob",
  nextStep: "Archive docs",
}, fixedToday);
assert.strictEqual(doneCleared.stage, "todo");
assert.strictEqual(doneCleared.waitingOn, null);
assert.strictEqual(doneCleared.nextStep, "Archive docs");
assert.strictEqual(doneCleared.completedAt, "2026-11-23");

// 6. State transitions: auto-date cleared on Later, prevList restored on undo-done
const undated = logic.createTask({ title: "Draft brief", list: "later" }, fixedToday);
assert.strictEqual(undated.dueDate, "");
const inToday = logic.applyTaskTransition(undated, { list: "today" }, fixedToday);
assert.strictEqual(inToday.dueDate, "2026-11-23");
assert.strictEqual(inToday.dueDateAuto, true);
const backToLater = logic.applyTaskTransition(inToday, { list: "later" }, fixedToday);
assert.strictEqual(backToLater.dueDate, "", "Moving back to Later must clear auto-anchored date");
assert.strictEqual(backToLater.dueDateAuto, false);

const completedFromLater = logic.applyTaskTransition(backToLater, { list: "done" }, fixedToday);
assert.strictEqual(completedFromLater.prevList, "later");
assert.strictEqual(completedFromLater.completedAt, "2026-11-23");

// 7. Conflict-free multi-PC merge with tombstones
const baseTime = fixedToday.getTime();
const localList = [
  logic.normalizeTask({ id: "a", title: "Local newer", updatedAt: baseTime + 500 }, fixedToday),
  logic.normalizeTask({ id: "b", title: "Remote newer", updatedAt: baseTime + 100 }, fixedToday),
  logic.normalizeTask({ id: "c", title: "Deleted locally", updatedAt: baseTime + 600, deleted: true, deletedAt: baseTime + 600 }, fixedToday),
];
const remoteList = [
  logic.normalizeTask({ id: "a", title: "Remote older", updatedAt: baseTime + 200 }, fixedToday),
  logic.normalizeTask({ id: "b", title: "Remote wins", updatedAt: baseTime + 400 }, fixedToday),
  logic.normalizeTask({ id: "c", title: "Still alive remote", updatedAt: baseTime + 100 }, fixedToday),
  logic.normalizeTask({ id: "d", title: "Added on Home PC", updatedAt: baseTime + 300 }, fixedToday),
];
const merged = logic.mergeTaskLists(localList, remoteList, fixedToday);
const byId = Object.fromEntries(merged.map((t) => [t.id, t]));
assert.strictEqual(byId.a.title, "Local newer");
assert.strictEqual(byId.b.title, "Remote wins");
assert.strictEqual(byId.c.deleted, true, "Newer local tombstone must win over older remote live copy");
assert.strictEqual(byId.d.title, "Added on Home PC");

// 8. Sorting & DST-safe weekly wins counter (excludes deleted and future dates)
const sorted = logic.sortTasksByUrgency(
  [
    { id: "no-date", dueDate: "", stage: "todo", createdAt: 10 },
    { id: "far", dueDate: "2027-01-20", stage: "todo", createdAt: 20 },
    { id: "soon-todo", dueDate: "2026-11-25", stage: "todo", createdAt: 50 },
    { id: "soon-started", dueDate: "2026-11-25", stage: "started", createdAt: 5 },
  ],
  fixedToday
);
assert.deepStrictEqual(
  sorted.map((t) => t.id),
  ["soon-started", "soon-todo", "far", "no-date"]
);

const wins = logic.countCompletedThisWeek(
  [
    { list: "done", completedAt: "2026-11-23" },
    { list: "done", completedAt: "2026-11-17" }, // exactly 6 days ago (7-day inclusive window)
    { list: "done", completedAt: "2026-11-16" }, // 7 days ago (outside 7-day inclusive window)
    { list: "done", completedAt: "2026-11-25" }, // future date (excluded)
    { list: "done", completedAt: "2026-11-23", deleted: true }, // deleted (excluded)
    { list: "today", completedAt: null },
  ],
  fixedToday
);
assert.strictEqual(wins, 2);

// 9. Quick-capture token parsing (!today, #personal, @tom, @+1w, @mon)
const cap1 = logic.parseQuickCapture("Send invoice !today #personal @tom", fixedToday);
assert.strictEqual(cap1.title, "Send invoice");
assert.strictEqual(cap1.list, "today");
assert.strictEqual(cap1.area, "personal");
assert.strictEqual(cap1.dueDate, "2026-11-24");

// fixedToday is Mon Nov 23, 2026 -> @mon should be NEXT Monday (Nov 30, 2026)
assert.strictEqual(logic.getNextWeekdayKey(1, fixedToday), "2026-11-30", "Target weekday on same day must return +7");
const cap2 = logic.parseQuickCapture("Sync with Ana @mon #w", fixedToday);
assert.strictEqual(cap2.title, "Sync with Ana");
assert.strictEqual(cap2.area, "work");
assert.strictEqual(cap2.dueDate, "2026-11-30");

const cap3 = logic.parseQuickCapture("Quarterly plan @+1w", fixedToday);
assert.strictEqual(cap3.dueDate, "2026-11-30");

// 10. Fading ink freshness (7d fresh, 14d stale, snooze inclusive & smooth >21d milestone crossing)
const freshTask = logic.normalizeTask({ title: "Fresh", touchedAt: fixedToday.getTime() - 3 * 86400000 }, fixedToday);
assert.strictEqual(logic.getTaskFreshness(freshTask, fixedToday).opacity, 1);
assert.strictEqual(logic.getTaskFreshness(freshTask, fixedToday).isStale, false);

const midFade = logic.normalizeTask({ title: "Mid", touchedAt: fixedToday.getTime() - 10 * 86400000 }, fixedToday);
const midInfo = logic.getTaskFreshness(midFade, fixedToday);
assert.strictEqual(midInfo.isFading, true);
assert.strictEqual(midInfo.isStale, false);
assert.ok(midInfo.opacity < 1 && midInfo.opacity > 0.68);

const staleTask = logic.normalizeTask({ title: "Stale", touchedAt: fixedToday.getTime() - 16 * 86400000 }, fixedToday);
assert.strictEqual(logic.getTaskFreshness(staleTask, fixedToday).isStale, true);
assert.strictEqual(logic.getTaskFreshness(staleTask, fixedToday).opacity, 0.68);

const snoozedThroughToday = logic.normalizeTask(
  { title: "Snoozed today", touchedAt: fixedToday.getTime() - 20 * 86400000, snoozedUntil: "2026-11-23" },
  fixedToday
);
assert.strictEqual(
  logic.getTaskFreshness(snoozedThroughToday, fixedToday).isFading,
  false,
  "Task snoozed until today stays hidden through today (inclusive)"
);

const snoozeExpired = logic.normalizeTask(
  { title: "Snooze ended", touchedAt: fixedToday.getTime() - 20 * 86400000, snoozedUntil: "2026-11-22" },
  fixedToday
);
assert.strictEqual(logic.getTaskFreshness(snoozeExpired, fixedToday).isStale, true);

const farMilestone = logic.normalizeTask(
  { title: "Q1 milestone", dueDate: "2027-01-15", touchedAt: fixedToday.getTime() - 20 * 86400000 },
  fixedToday
);
assert.strictEqual(
  logic.getTaskFreshness(farMilestone, fixedToday).isFading,
  false,
  "Milestones >21d out must not falsely fade as stale"
);

// Crossing 21d -> 20d out should NOT drop straight to stale overnight (age starts from dueDate - 21d)
const justEnteredWindow = logic.normalizeTask(
  { title: "Crossing 21d", dueDate: "2026-12-13", touchedAt: fixedToday.getTime() - 30 * 86400000 },
  fixedToday
);
assert.strictEqual(
  logic.getTaskFreshness(justEnteredWindow, fixedToday).isFading,
  false,
  "Milestone just entering 21d window starts fresh instead of dropping abruptly"
);

// 11. Morning check-in summary & card ordering (started -> dueSoon -> waiting -> fading)
const checkinTasks = [
  staleTask,
  logic.normalizeTask({ id: "w1", title: "Wait", stage: "waiting", waitingOn: "Ana" }, fixedToday),
  logic.normalizeTask({ id: "d1", title: "Due soon", dueDate: "2026-11-26" }, fixedToday),
  logic.normalizeTask({ id: "s1", title: "Started", stage: "started", nextStep: "Finish slide 4" }, fixedToday),
];
const checkin = logic.getMorningCheckinData(checkinTasks, fixedToday);
assert.deepStrictEqual(checkin.counts, { started: 1, waiting: 1, dueSoon: 1, fading: 1 });
assert.deepStrictEqual(
  checkin.cards.map((c) => c.kind),
  ["started", "dueSoon", "waiting", "fading"]
);

// 12. Weekly momentum (tasks + milestone subtask steps, rolling 7d & Monday lastWeek)
const momentumTasks = [
  {
    list: "done",
    completedAt: "2026-11-23", // Mon today
    subtasks: [{ id: "s1", title: "Step A", done: true, completedAt: "2026-11-23" }],
  },
  {
    list: "today",
    stage: "started",
    subtasks: [
      { id: "s2", title: "Step B", done: true, completedAt: "2026-11-20" }, // last Friday
      { id: "s3", title: "Step C", done: false, completedAt: null },
      { id: "s4", title: "Old step", done: true, completedAt: "2026-11-10" },
    ],
  },
  {
    list: "done",
    completedAt: "2026-11-18", // last Wednesday
  },
  {
    list: "done",
    completedAt: "2026-11-19",
    deleted: true, // deleted must be excluded
  },
];
// Rolling 7 days [Nov 17..Nov 23]: 2 done tasks + 2 done steps
assert.deepStrictEqual(logic.getWeeklyMomentum(momentumTasks, fixedToday, { lastWeek: false }), {
  tasksDone: 2,
  stepsDone: 2,
});
// Previous 7 days for Monday Nov 23 [Nov 16..Nov 22]: 1 done task (Nov 18) + 1 done step (Nov 20)
assert.deepStrictEqual(logic.getWeeklyMomentum(momentumTasks, fixedToday, { lastWeek: true }), {
  tasksDone: 1,
  stepsDone: 1,
});

// 13. Safe note link tokenization (only http/https, trims trailing punctuation, ignores javascript:)
const tokens = logic.tokenizeNotes("Check https://example.com/doc_(v2). Also javascript:alert(1) and http://foo.bar/baz, thanks!");
assert.deepStrictEqual(tokens, [
  { type: "text", value: "Check " },
  { type: "link", href: "https://example.com/doc_(v2)", label: "https://example.com/doc_(v2)" },
  { type: "text", value: ". Also javascript:alert(1) and " },
  { type: "link", href: "http://foo.bar/baz", label: "http://foo.bar/baz" },
  { type: "text", value: ", thanks!" },
]);

// Subtask normalization stamps completedAt on transition & deduplicates repeated IDs
const withSub = logic.applyTaskTransition(
  logic.createTask({ title: "Big project", list: "today" }, fixedToday),
  {
    subtasks: [
      { id: "dup", title: "Draft", done: true },
      { id: "dup", title: "Review", done: false },
    ],
  },
  fixedToday
);
assert.strictEqual(withSub.subtasks[0].completedAt, "2026-11-23");
assert.notStrictEqual(withSub.subtasks[0].id, withSub.subtasks[1].id, "Duplicate subtask IDs must be deduplicated");

// 14. Custom horizon days, headings & adaptive Option B timeline axis
assert.strictEqual(logic.parseHorizonDays(14), 14);
assert.strictEqual(logic.parseHorizonDays("14"), 14);
assert.strictEqual(logic.parseHorizonDays(" 365d "), 365);
assert.strictEqual(logic.parseHorizonDays(1), 1);
assert.strictEqual(logic.parseHorizonDays(9999), logic.MAX_HORIZON_DAYS);
assert.strictEqual(logic.parseHorizonDays(0, 30), 30);
assert.strictEqual(logic.parseHorizonDays(-5, 30), 30);
assert.strictEqual(logic.parseHorizonDays("bad", 14), 14);
assert.strictEqual(logic.parseHorizonDays(null), logic.HORIZON_DAYS);

assert.strictEqual(logic.getHorizonHeadingText(1), "1-Day Horizon");
assert.strictEqual(logic.getHorizonHeadingText(7), "1-Week Horizon");
assert.strictEqual(logic.getHorizonHeadingText(14), "2-Week Horizon");
assert.strictEqual(logic.getHorizonHeadingText(21), "3-Week Horizon");
assert.strictEqual(logic.getHorizonHeadingText(30), "30-Day Horizon");
assert.strictEqual(logic.getHorizonHeadingText(45), "45-Day Horizon");
assert.strictEqual(logic.getHorizonHeadingText(90), "3-Month Horizon");
assert.strictEqual(logic.getHorizonHeadingText(180), "6-Month Horizon");
assert.strictEqual(logic.getHorizonHeadingText(365), "1-Year Horizon");
assert.strictEqual(logic.getHorizonHeadingText(730), "2-Year Horizon");

// Width scaling across custom horizons
assert.strictEqual(logic.getTimelineWidthPercent(7, 14), 50);
assert.strictEqual(logic.getTimelineWidthPercent(15, 30), 50);
assert.strictEqual(logic.getTimelineWidthPercent(180, 180), 100);
assert.strictEqual(logic.getTimelineWidthPercent(500, 365), 100);
assert.strictEqual(logic.getTimelineWidthPercent(1, 365), 2.5);

// Contrast across work & personal for 14d / 30d / 90d / 180d / 365d
const paperBg = [253, 250, 244];
for (const horizon of [14, 30, 90, 180, 365]) {
  for (const area of ["work", "personal"]) {
    for (const d of [-5, 0, 2, 10, 20, 35, 60, 90]) {
      const style = logic.getGradientStyle(d, area, horizon);
      const ratio = contrastRatio(parseRgb(style.badgeColor), paperBg);
      assert.ok(ratio >= 4.5, `Badge contrast (${area}, d=${d}, h=${horizon}) = ${ratio.toFixed(2)}`);
    }
    assert.strictEqual(logic.getGradientStyle(0, area, horizon).textColor, "#fdfaf4");
  }
  const midBar = logic.getGradientStyle(Math.min(12, Math.floor(horizon / 2)), "work", horizon);
  if (horizon >= 14) {
    assert.strictEqual(midBar.textColor, "#231e18", `Mid bar at h=${horizon} must use dark ink`);
  }
}

const nov25 = new Date(2026, 10, 25); // Wed Nov 25, 2026
for (const dSpan of [1, 7, 14, 21, 30, 90, 180, 365, 730]) {
  const startDt = dSpan === 30 ? new Date(2026, 11, 2) : nov25;
  const ax = logic.getTimelineAxis(startDt, dSpan);
  assert.strictEqual(ax.markers[0].label, "Today");
  assert.strictEqual(ax.markers[0].percent, 0);
  for (let i = 1; i < ax.markers.length; i++) {
    assert.ok(
      ax.markers[i].percent > ax.markers[i - 1].percent,
      `Axis markers must increase monotonically for ${dSpan}d`
    );
  }
  if (dSpan === 1) {
    assert.strictEqual(ax.markers.length, 1);
    assert.strictEqual(ax.gridLines.length, 0);
  } else if (dSpan <= 21) {
    assert.strictEqual(ax.gridLines.length, dSpan - 1);
    assert.ok(ax.markers.length >= 3, `${dSpan}d should have Today + landmarks`);
    for (let i = 1; i < ax.markers.length; i++) {
      assert.ok(ax.markers[i].percent - ax.markers[i - 1].percent >= 15);
    }
  } else if (dSpan === 30) {
    assert.ok(ax.markers.length >= 3, "30d starting mid-month should still show landmarks");
    for (let i = 1; i < ax.markers.length; i++) {
      assert.ok(ax.markers[i].percent - ax.markers[i - 1].percent >= 16);
    }
  } else if (dSpan === 365) {
    assert.ok(ax.markers.some((m) => m.label === "Jan '27"));
    assert.strictEqual(ax.gridLines.length, 12);
    for (let i = 1; i < ax.markers.length; i++) {
      assert.ok(ax.markers[i].percent - ax.markers[i - 1].percent >= 7.5);
    }
  } else if (dSpan === 730) {
    assert.ok(ax.markers.some((m) => m.label === "Jan '28"));
    assert.strictEqual(ax.gridLines.length, 24);
    for (let i = 1; i < ax.markers.length; i++) {
      assert.ok(ax.markers[i].percent - ax.markers[i - 1].percent >= 7.5);
    }
  }
}

const ax14 = logic.getTimelineAxis(nov25, 14);
assert.ok(ax14.markers.some((m) => m.label === "Dec 1" && m.isAccent));
assert.ok(ax14.markers.some((m) => m.label === "Mon 7" && m.isAccent));

const ax90 = logic.getTimelineAxis(fixedToday, 90);
assert.deepStrictEqual(
  ax90.markers.map((m) => m.label),
  logic.getMonthMarkers(fixedToday, 90).map((m) => m.label)
);

// 15. Recurrence math (clamping, leap years, overdue catch-up) & spawnNextRecurrence
assert.deepStrictEqual(logic.VALID_RECURRENCES, ["", "weekly", "monthly", "quarterly", "yearly"]);
assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "weekly", fixedToday), "2026-12-07");
assert.strictEqual(logic.getNextRecurrenceDate("2026-11-25", "monthly", fixedToday), "2026-12-25");
assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "quarterly", fixedToday), "2027-02-28");
assert.strictEqual(logic.getNextRecurrenceDate("2026-01-31", "monthly", new Date(2026, 0, 15)), "2026-02-28");
assert.strictEqual(logic.getNextRecurrenceDate("2028-01-31", "monthly", new Date(2028, 0, 15)), "2028-02-29");
assert.strictEqual(logic.getNextRecurrenceDate("2026-01-31", "monthly", new Date(2026, 1, 28)), "2026-03-31");
assert.strictEqual(logic.getNextRecurrenceDate("2026-10-01", "weekly", fixedToday), "2026-11-26");
assert.strictEqual(logic.getNextRecurrenceDate("2026-11-23", "monthly", fixedToday), "2026-12-23");
assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "daily", fixedToday), "");

const recSource = logic.normalizeTask(
  {
    id: "rec-1",
    title: "Pay power bill #home",
    area: "personal",
    list: "today",
    dueDate: "2026-11-25",
    recurrence: "monthly",
    notes: "Account 123",
    subtasks: [{ id: "st-a", title: "Check meter", done: true, completedAt: "2026-11-23" }],
  },
  fixedToday
);
const doneRec = logic.applyTaskTransition(recSource, { list: "done" }, fixedToday);
const spawn1 = logic.spawnNextRecurrence(doneRec, [doneRec], fixedToday);
assert.ok(spawn1);
assert.strictEqual(spawn1.spawnedTask.dueDate, "2026-12-25");
assert.strictEqual(spawn1.spawnedTask.list, "later");
assert.strictEqual(spawn1.spawnedTask.area, "personal");
assert.strictEqual(spawn1.spawnedTask.recurrence, "monthly");
assert.strictEqual(spawn1.spawnedTask.subtasks.length, 1);
assert.strictEqual(spawn1.spawnedTask.subtasks[0].done, false);
assert.notStrictEqual(spawn1.spawnedTask.subtasks[0].id, "st-a");
assert.strictEqual(spawn1.updatedCompleted.recurrenceSpawnedId, spawn1.spawnedTask.id);

// No duplicate when spawned task already exists live; respawns if spawned task was deleted
assert.strictEqual(
  logic.spawnNextRecurrence(spawn1.updatedCompleted, [spawn1.updatedCompleted, spawn1.spawnedTask], fixedToday),
  null
);
const deletedSpawn = { ...spawn1.spawnedTask, deleted: true, deletedAt: fixedToday.getTime() };
const spawn2 = logic.spawnNextRecurrence(spawn1.updatedCompleted, [spawn1.updatedCompleted, deletedSpawn], fixedToday);
assert.ok(spawn2 && spawn2.spawnedTask.id !== spawn1.spawnedTask.id);

// 16. Migration of local da6518d tasks (previousStatus, subtasks[].text, recurrence)
const da6518dDoc = logic.parseTaskDocument(
  [
    {
      id: "legacy-local-1",
      title: "Book dentist #health",
      status: "inbox",
      previousStatus: "today",
      dueDate: "2026-12-04",
      recurrence: "quarterly",
      subtasks: [{ id: "st-legacy", text: "Call clinic", done: true }],
      createdAt: 1000,
    },
  ],
  fixedToday
);
assert.strictEqual(da6518dDoc.wasV1, true);
assert.strictEqual(da6518dDoc.tasks[0].list, "later");
assert.strictEqual(da6518dDoc.tasks[0].prevList, "today");
assert.strictEqual(da6518dDoc.tasks[0].previousStatus, undefined);
assert.strictEqual(da6518dDoc.tasks[0].recurrence, "quarterly");
assert.deepStrictEqual(da6518dDoc.tasks[0].subtasks, [
  { id: "st-legacy", title: "Call clinic", done: true, completedAt: null },
]);

// 17. #Tag extraction & generalized @+Nd / @+Nw / @+Nm quick capture
assert.deepStrictEqual(logic.extractTags("Pay #Home bill #personal #work #HEALTH #home"), ["home", "health"]);
assert.deepStrictEqual(
  logic.getAllTags([
    { list: "later", title: "Call #zeta", notes: "see #NotesTag", deleted: false },
    { list: "today", title: "Pay #Home #alpha", deleted: false },
    { list: "done", title: "Done #hidden", deleted: false },
    { list: "later", title: "Deleted #gone", deleted: true },
  ]),
  ["alpha", "home", "notestag", "zeta"]
);

const capRelD = logic.parseQuickCapture("Renew #home @+3d", fixedToday);
assert.strictEqual(capRelD.title, "Renew #home");
assert.strictEqual(capRelD.dueDate, "2026-11-26");
const capRelW = logic.parseQuickCapture("Review @+2w", fixedToday);
assert.strictEqual(capRelW.dueDate, "2026-12-07");
const capRelM = logic.parseQuickCapture("Clamped @+1m", new Date(2027, 0, 31));
assert.strictEqual(capRelM.dueDate, "2027-02-28");

console.log("ALL LOGIC TESTS PASSED!");
