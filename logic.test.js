/**
 * logic.test.js — Automated sanity checks for logic.js
 * Run with: node logic.test.js
 */
const assert = require("assert");
const logic = require("./logic.js");

const fixedToday = new Date(2026, 10, 23); // Nov 23, 2026

// 1. Date parsing & day counting
assert.strictEqual(logic.toDateKey(fixedToday), "2026-11-23");
assert.strictEqual(logic.daysUntil("2026-11-23", fixedToday), 0);
assert.strictEqual(logic.daysUntil("2026-11-25", fixedToday), 2);
assert.strictEqual(logic.daysUntil("2026-11-21", fixedToday), -2);

// 2. Human-friendly labels
assert.strictEqual(logic.formatDaysLabel(0), "Today");
assert.strictEqual(logic.formatDaysLabel(1), "Tomorrow");
assert.strictEqual(logic.formatDaysLabel(15), "In 15d");
assert.strictEqual(logic.formatDaysLabel(-3), "3d overdue");

// 3. Transparent -> full color block gradient progression
const far = logic.getGradientStyle(85);
const mid = logic.getGradientStyle(30);
const close = logic.getGradientStyle(2);
const dueToday = logic.getGradientStyle(0);

assert.ok(far.startAlpha < mid.startAlpha && mid.startAlpha < close.startAlpha,
  "Start opacity should increase as deadline approaches");
assert.ok(far.endAlpha < mid.endAlpha && mid.endAlpha < close.endAlpha,
  "End block opacity should grow from faint to full color as deadline approaches");
assert.strictEqual(dueToday.endAlpha, 1, "Tasks due today should hit full 1.0 solid color block");
assert.strictEqual(dueToday.textColor, "#fdfaf4", "Solid vivid blocks should switch to light cream text");

// 4. Timeline width scaling across 90 days
assert.strictEqual(logic.getTimelineWidthPercent(90), 100);
assert.strictEqual(logic.getTimelineWidthPercent(45), 50);
assert.strictEqual(logic.getTimelineWidthPercent(1), 2.5, "Very near tasks keep exact narrow block width");

// 5. Month markers across 3 months
const markers = logic.getMonthMarkers(fixedToday);
assert.ok(markers.length >= 3, "Should include Today plus upcoming month boundaries");
assert.strictEqual(markers[0].isToday, true);

// 6. Sorting by urgency
const sorted = logic.sortTasksByUrgency(
  [
    { id: "no-date", dueDate: "", createdAt: 10 },
    { id: "far", dueDate: "2027-01-20", createdAt: 20 },
    { id: "soon", dueDate: "2026-11-25", createdAt: 5 },
  ],
  fixedToday
);
assert.deepStrictEqual(
  sorted.map((t) => t.id),
  ["soon", "far", "no-date"]
);

// 7. Weekly wins counter
const wins = logic.countCompletedThisWeek(
  [
    { status: "done", completedAt: "2026-11-23" },
    { status: "done", completedAt: "2026-11-18" },
    { status: "done", completedAt: "2026-11-01" }, // older than 7 days
    { status: "today", completedAt: null },
  ],
  fixedToday
);
assert.strictEqual(wins, 2);

console.log("ALL 7 LOGIC TESTS PASSED!");
