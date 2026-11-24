/**
 * logic.test.js — Automated tests for logic.js (dates, v2 schema, migration, merge, timeline)
 * Run with: node logic.test.js
 */
const assert = require("assert");
const logic = require("./logic.js");

const fixedToday = new Date(2026, 10, 23); // Nov 23, 2026

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

console.log("ALL LOGIC TESTS PASSED!");
