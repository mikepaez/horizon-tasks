/**
 * logic.test.js — Automated sanity checks for logic.js
 * Run with: node logic.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const logic = require("./logic.js");

const fixedToday = new Date(2026, 10, 23); // Nov 23, 2026
let count = 0;
function section(name, fn) {
  fn();
  count += 1;
  console.log(`  ok - ${name}`);
}

// Relative luminance / contrast helpers for the badge readability check
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
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

section("date parsing & day counting", () => {
  assert.strictEqual(logic.toDateKey(fixedToday), "2026-11-23");
  assert.strictEqual(logic.daysUntil("2026-11-23", fixedToday), 0);
  assert.strictEqual(logic.daysUntil("2026-11-25", fixedToday), 2);
  assert.strictEqual(logic.daysUntil("2026-11-21", fixedToday), -2);
  assert.strictEqual(logic.daysUntil("", fixedToday), null);
});

section("addDaysToKey", () => {
  assert.strictEqual(logic.addDaysToKey("2026-11-23", 1), "2026-11-24");
  assert.strictEqual(logic.addDaysToKey("2026-11-30", 1), "2026-12-01");
  assert.strictEqual(logic.addDaysToKey("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(logic.addDaysToKey("2026-03-01", -1), "2026-02-28");
  assert.strictEqual(logic.addDaysToKey("nope", 3), "");
  assert.strictEqual(logic.addDaysToKey("", 3), "");
});

section("human-friendly labels", () => {
  assert.strictEqual(logic.formatDaysLabel(0), "Today");
  assert.strictEqual(logic.formatDaysLabel(1), "Tomorrow");
  assert.strictEqual(logic.formatDaysLabel(15), "In 15d");
  assert.strictEqual(logic.formatDaysLabel(-3), "3d overdue");
});

section("transparent -> full color block gradient progression", () => {
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
});

section("Paper Desk palette is preserved", () => {
  assert.strictEqual(logic.getGradientStyle(-1).borderColor, "rgb(168, 38, 32)");
  assert.strictEqual(logic.getGradientStyle(2).borderColor, "rgb(185, 58, 46)");
  assert.strictEqual(logic.getGradientStyle(10).borderColor, "rgb(196, 108, 43)");
  assert.strictEqual(logic.getGradientStyle(20).borderColor, "rgb(168, 134, 58)");
  assert.strictEqual(logic.getGradientStyle(60).borderColor, "rgb(92, 118, 106)");
});

section("badge text has strong contrast on the paper background", () => {
  const paper = [253, 250, 244];
  [-5, 0, 2, 10, 20, 35, 60, 90].forEach((days) => {
    const ratio = contrast(parseRgb(logic.getGradientStyle(days).badgeColor), paper);
    assert.ok(ratio >= 4.5, `badge contrast for ${days}d is only ${ratio.toFixed(2)}`);
  });
});

section("bar text contrast across 30d / 90d / 180d zoom", () => {
  // On 30d zoom, a 11–14d task renders wide enough (>= 34%) for inside-bar text:
  // it must use dark ink (#231e18), never white-on-peach.
  [11, 12, 14].forEach((d) => {
    const s30 = logic.getGradientStyle(d, 30);
    assert.strictEqual(s30.textColor, "#231e18", `${d}d on 30d zoom must use dark ink`);
  });
  assert.strictEqual(logic.getGradientStyle(0, 30).textColor, "#fdfaf4");
  assert.strictEqual(logic.getGradientStyle(0, 90).textColor, "#fdfaf4");
  assert.strictEqual(logic.getGradientStyle(0, 180).textColor, "#fdfaf4");
});

section("timeline width scaling across 90 days (default)", () => {
  assert.strictEqual(logic.HORIZON_DAYS, 90);
  assert.strictEqual(logic.getTimelineWidthPercent(90), 100);
  assert.strictEqual(logic.getTimelineWidthPercent(45), 50);
  assert.strictEqual(logic.getTimelineWidthPercent(1), 2.5, "Very near tasks keep exact narrow block width");
  assert.strictEqual(logic.getTimelineWidthPercent(-4), 2.5);
  assert.strictEqual(logic.getTimelineWidthPercent(500), 100);
});

section("horizon zoom: 30 / 90 / 180 days", () => {
  // Width scales with the horizon
  assert.strictEqual(logic.getTimelineWidthPercent(15, 30), 50);
  assert.strictEqual(logic.getTimelineWidthPercent(45, 90), 50);
  assert.strictEqual(logic.getTimelineWidthPercent(90, 180), 50);
  assert.strictEqual(logic.getTimelineWidthPercent(30, 30), 100);
  assert.strictEqual(logic.getTimelineWidthPercent(200, 180), 100);
  assert.strictEqual(logic.getTimelineWidthPercent(1, 180), 2.5);

  // Closeness scales with the horizon
  assert.strictEqual(logic.getGradientStyle(15, 30).closeness, 0.5);
  assert.strictEqual(logic.getGradientStyle(45).closeness, 0.5);
  assert.strictEqual(logic.getGradientStyle(90, 180).closeness, 0.5);
  assert.strictEqual(logic.getGradientStyle(45, 30).closeness, 0, "Beyond the horizon is fully faded");
  assert.ok(logic.getGradientStyle(45, 30).closeness < logic.getGradientStyle(45, 180).closeness);
  assert.strictEqual(logic.getGradientStyle(0, 180).closeness, 1);

  // Month markers cover the whole horizon
  const m30 = logic.getMonthMarkers(fixedToday, 30);
  assert.deepStrictEqual(m30.map((m) => m.label), ["Today", "Dec"]);
  assert.strictEqual(m30[1].percent, 26.67);

  const m90 = logic.getMonthMarkers(fixedToday, 90);
  assert.deepStrictEqual(m90.map((m) => m.label), ["Today", "Dec", "Jan 2027", "Feb"]);
  assert.deepStrictEqual(m90.map((m) => m.label), logic.getMonthMarkers(fixedToday).map((m) => m.label));

  const m180 = logic.getMonthMarkers(fixedToday, 180);
  assert.deepStrictEqual(m180.map((m) => m.label), ["Today", "Jan 2027", "Feb", "Mar", "Apr", "May"]);
  assert.ok(m180.every((m) => m.percent <= 94));
});

section("month markers across 3 months", () => {
  const markers = logic.getMonthMarkers(fixedToday);
  assert.ok(markers.length >= 3, "Should include Today plus upcoming month boundaries");
  assert.strictEqual(markers[0].isToday, true);
});

section("parseHorizonDays and custom horizon headings", () => {
  assert.strictEqual(logic.parseHorizonDays(14), 14);
  assert.strictEqual(logic.parseHorizonDays("14"), 14);
  assert.strictEqual(logic.parseHorizonDays(" 365d "), 365);
  assert.strictEqual(logic.parseHorizonDays(1), 1);
  assert.strictEqual(logic.parseHorizonDays(9999), logic.MAX_HORIZON_DAYS);
  assert.strictEqual(logic.parseHorizonDays(0, 30), 30);
  assert.strictEqual(logic.parseHorizonDays(-5, 30), 30);
  assert.strictEqual(logic.parseHorizonDays("abc", 14), 14);
  assert.strictEqual(logic.parseHorizonDays("", 90), 90);
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
});

section("adaptive timeline axis across short, medium, classic, and long custom ranges", () => {
  const nov25 = new Date(2026, 10, 25); // Wed Nov 25, 2026

  // 14-day (2-week) view: daily grid lines + non-overlapping Option B landmarks
  const ax14 = logic.getTimelineAxis(nov25, 14);
  assert.strictEqual(ax14.gridLines.length, 13, "14d should have a subtle grid line for every intermediate day");
  assert.strictEqual(ax14.markers[0].label, "Today");
  assert.ok(ax14.markers.some((m) => m.label === "Dec 1" && m.isAccent), "1st of month should be accented");
  assert.ok(ax14.markers.some((m) => m.label === "Mon 7" && m.isAccent), "Monday landmark should be accented");
  assert.ok(ax14.markers.length >= 4 && ax14.markers.length <= 6, "14d Option B should stay light and balanced");
  for (let i = 1; i < ax14.markers.length; i++) {
    assert.ok(
      ax14.markers[i].percent - ax14.markers[i - 1].percent >= 15,
      `14d labels must stay >= 15% apart: ${JSON.stringify(ax14.markers)}`
    );
  }

  // 7-day (1-week) view: daily grid + spaced landmarks
  const ax7 = logic.getTimelineAxis(nov25, 7);
  assert.strictEqual(ax7.gridLines.length, 6);
  assert.ok(ax7.markers.length >= 3, "7d should show Today plus intermediate day landmarks");
  for (let i = 1; i < ax7.markers.length; i++) {
    assert.ok(ax7.markers[i].percent - ax7.markers[i - 1].percent >= 15);
  }

  // Edge case: 1-day view works cleanly without division errors
  const ax1 = logic.getTimelineAxis(nov25, 1);
  assert.deepStrictEqual(ax1.markers.map((m) => m.label), ["Today"]);
  assert.strictEqual(ax1.gridLines.length, 0);

  // 30-day view starting mid-month (no 1st of month inside 1..29) still shows helpful date landmarks
  const dec2 = new Date(2026, 11, 2);
  const ax30NoMonth = logic.getTimelineAxis(dec2, 30);
  assert.ok(ax30NoMonth.markers.length >= 3, "30d without a month boundary should still show date landmarks");
  for (let i = 1; i < ax30NoMonth.markers.length; i++) {
    assert.ok(ax30NoMonth.markers[i].percent - ax30NoMonth.markers[i - 1].percent >= 16);
  }

  // 90-day classic view matches getMonthMarkers
  const ax90 = logic.getTimelineAxis(fixedToday, 90);
  assert.deepStrictEqual(
    ax90.markers.map((m) => m.label),
    logic.getMonthMarkers(fixedToday, 90).map((m) => m.label)
  );

  // 365-day (1-year) view: compact month labels with Jan '27 and no overlap
  const ax365 = logic.getTimelineAxis(nov25, 365);
  assert.ok(ax365.markers.some((m) => m.label === "Jan '27"), "1-year view should label Jan '27 compactly");
  assert.ok(ax365.markers.length >= 10, "1-year view should display ~11 upcoming months");
  assert.strictEqual(ax365.gridLines.length, 12, "1-year view should have 12 monthly grid lines");
  for (let i = 1; i < ax365.markers.length; i++) {
    assert.ok(ax365.markers[i].percent - ax365.markers[i - 1].percent >= 7.5);
  }

  // 730-day (2-year) view: auto-thins labels to avoid crowding while keeping monthly grid lines
  const ax730 = logic.getTimelineAxis(nov25, 730);
  assert.ok(ax730.markers.some((m) => m.label === "Jan '28"), "2-year view should anchor Jan '28");
  assert.strictEqual(ax730.gridLines.length, 24, "2-year view should keep all 24 monthly grid lines");
  for (let i = 1; i < ax730.markers.length; i++) {
    assert.ok(ax730.markers[i].percent - ax730.markers[i - 1].percent >= 7.5);
  }

  // Short-horizon bar text contrast (7d, 14d, 365d)
  [5, 9, 13].forEach((d) => {
    assert.strictEqual(logic.getGradientStyle(d, 14).textColor, "#231e18", `${d}d on 14d must use dark ink`);
  });
  assert.strictEqual(logic.getGradientStyle(0, 14).textColor, "#fdfaf4");
  assert.strictEqual(logic.getGradientStyle(0, 365).textColor, "#fdfaf4");
});

section("sorting by urgency", () => {
  const sorted = logic.sortTasksByUrgency(
    [
      { id: "no-date", dueDate: "", createdAt: 10 },
      { id: "far", dueDate: "2027-01-20", createdAt: 20 },
      { id: "soon", dueDate: "2026-11-25", createdAt: 5 },
    ],
    fixedToday
  );
  assert.deepStrictEqual(sorted.map((t) => t.id), ["soon", "far", "no-date"]);
});

section("weekly wins counter", () => {
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
});

section("recurrence: weekly / monthly / quarterly / yearly", () => {
  assert.deepStrictEqual(logic.VALID_RECURRENCES, ["", "weekly", "monthly", "quarterly", "yearly"]);
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "weekly", fixedToday), "2026-12-07");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-25", "monthly", fixedToday), "2026-12-25");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "quarterly", fixedToday), "2027-02-28");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-12-01", "quarterly", fixedToday), "2027-03-01");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-12-01", "yearly", fixedToday), "2027-12-01");
  // Year rollover
  assert.strictEqual(logic.getNextRecurrenceDate("2026-12-15", "monthly", fixedToday), "2027-01-15");
});

section("recurrence: month-end clamping without drift", () => {
  const jan15 = new Date(2026, 0, 15);
  assert.strictEqual(logic.getNextRecurrenceDate("2026-01-31", "monthly", jan15), "2026-02-28");
  assert.strictEqual(
    logic.getNextRecurrenceDate("2028-01-31", "monthly", new Date(2028, 0, 15)),
    "2028-02-29",
    "leap year"
  );
  // Catching up past February must return to the 31st, not drift to the 28th
  assert.strictEqual(logic.getNextRecurrenceDate("2026-01-31", "monthly", new Date(2026, 1, 28)), "2026-03-31");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-01-31", "monthly", new Date(2026, 2, 31)), "2026-04-30");
  assert.strictEqual(logic.getNextRecurrenceDate("2027-02-28", "yearly", new Date(2027, 5, 1)), "2028-02-28");
  assert.strictEqual(logic.getNextRecurrenceDate("2028-02-29", "yearly", new Date(2028, 5, 1)), "2029-02-28");
  assert.strictEqual(logic.getNextRecurrenceDate("2025-11-30", "quarterly", new Date(2026, 0, 1)), "2026-02-28");
});

section("recurrence: overdue catch-up lands strictly after today", () => {
  // Weekly: Oct 1 + 7n -> first date after Nov 23 is Nov 26
  assert.strictEqual(logic.getNextRecurrenceDate("2026-10-01", "weekly", fixedToday), "2026-11-26");
  // Monthly: Aug 15 -> Dec 15
  assert.strictEqual(logic.getNextRecurrenceDate("2026-08-15", "monthly", fixedToday), "2026-12-15");
  // Quarterly: Jan 10 2026 -> Apr, Jul, Oct, then Jan 10 2027
  assert.strictEqual(logic.getNextRecurrenceDate("2026-01-10", "quarterly", fixedToday), "2027-01-10");
  // Yearly: 2020 -> 2027
  assert.strictEqual(logic.getNextRecurrenceDate("2020-03-05", "yearly", fixedToday), "2027-03-05");
  // Due today advances, never returns today
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-23", "monthly", fixedToday), "2026-12-23");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-23", "weekly", fixedToday), "2026-11-30");
  // Future base still advances one interval from the base
  assert.strictEqual(logic.getNextRecurrenceDate("2027-05-01", "weekly", fixedToday), "2027-05-08");
});

section("recurrence: invalid input", () => {
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "", fixedToday), "");
  assert.strictEqual(logic.getNextRecurrenceDate("2026-11-30", "daily", fixedToday), "");
  assert.strictEqual(logic.getNextRecurrenceDate("", "weekly", fixedToday), "");
  assert.strictEqual(logic.getNextRecurrenceDate("garbage", "weekly", fixedToday), "");
});

section("tags: extractTags", () => {
  assert.deepStrictEqual(logic.extractTags("Pay bill #home"), ["home"]);
  assert.deepStrictEqual(logic.extractTags("#Home call #HEALTH and #home"), ["home", "health"]);
  assert.deepStrictEqual(logic.extractTags("#work-2 #a_b"), ["work-2", "a_b"]);
  assert.deepStrictEqual(logic.extractTags("Plan #café #日本語"), ["café", "日本語"]);
  assert.deepStrictEqual(logic.extractTags("issue#12 not a tag"), [], "must be whitespace-bounded");
  assert.deepStrictEqual(logic.extractTags("# alone and #-bad"), []);
  assert.deepStrictEqual(logic.extractTags(""), []);
  assert.deepStrictEqual(logic.extractTags(undefined), []);
  const long = "#" + "a".repeat(40);
  assert.deepStrictEqual(logic.extractTags(long), ["a".repeat(30)], "tags are capped at 30 chars");
});

section("tags: getAllTags scans titles and notes on active tasks only", () => {
  const tags = logic.getAllTags([
    { status: "inbox", title: "Call #zeta", notes: "see #notesTag" },
    { status: "today", title: "Pay #Home bill #alpha" },
    { status: "done", title: "Old #secret", notes: "#hidden" },
    { status: "inbox", title: "No tags" },
    { status: "inbox", title: "Again #home" },
  ]);
  assert.deepStrictEqual(tags, ["alpha", "home", "notestag", "zeta"]);
  assert.deepStrictEqual(logic.getAllTags([]), []);
});

section("parseQuickCapture", () => {
  const plain = logic.parseQuickCapture("Buy milk", fixedToday);
  assert.deepStrictEqual(plain, { title: "Buy milk", dueDate: "", putInToday: false });

  const today = logic.parseQuickCapture("Call bank @today", fixedToday);
  assert.deepStrictEqual(today, { title: "Call bank", dueDate: "", putInToday: true });

  assert.deepStrictEqual(
    logic.parseQuickCapture("@TOM   Send   report", fixedToday),
    { title: "Send report", dueDate: "2026-11-24", putInToday: false }
  );
  assert.strictEqual(logic.parseQuickCapture("Send report @tomorrow", fixedToday).dueDate, "2026-11-24");
  assert.strictEqual(logic.parseQuickCapture("Rent @+7d", fixedToday).dueDate, "2026-11-30");
  assert.strictEqual(logic.parseQuickCapture("Rent @+2w", fixedToday).dueDate, "2026-12-07");
  assert.strictEqual(logic.parseQuickCapture("Rent @+1m", fixedToday).dueDate, "2026-12-23");
  assert.strictEqual(logic.parseQuickCapture("Rent @+10D", fixedToday).dueDate, "2026-12-03");
  assert.strictEqual(
    logic.parseQuickCapture("Rent @+1m", new Date(2027, 0, 31)).dueDate,
    "2027-02-28",
    "month math clamps to month end"
  );

  const combo = logic.parseQuickCapture("Pay rent #home @today @+1w", fixedToday);
  assert.deepStrictEqual(combo, { title: "Pay rent #home", dueDate: "2026-11-30", putInToday: true });

  // Tokens inside words are not tokens
  assert.deepStrictEqual(
    logic.parseQuickCapture("email me@today.com about it", fixedToday),
    { title: "email me@today.com about it", dueDate: "", putInToday: false }
  );
  assert.strictEqual(logic.parseQuickCapture("Thing @+5x", fixedToday).title, "Thing @+5x");
  assert.deepStrictEqual(
    logic.parseQuickCapture("Huge @+999999999d", fixedToday),
    { title: "Huge @+999999999d", dueDate: "", putInToday: false },
    "oversized relative offsets are ignored safely"
  );
  assert.deepStrictEqual(logic.parseQuickCapture("  @today  ", fixedToday), { title: "", dueDate: "", putInToday: true });
});

section("normalizeTask", () => {
  assert.strictEqual(logic.normalizeTask(null), null);
  assert.strictEqual(logic.normalizeTask("nope"), null);
  assert.strictEqual(logic.normalizeTask([]), null);

  // Legacy task from the old tasks.json
  const legacy = logic.normalizeTask({
    id: "t-1",
    title: "  Old task  ",
    dueDate: "2026-12-01",
    status: "inbox",
    createdAt: 1000,
    completedAt: null,
  });
  assert.deepStrictEqual(legacy, {
    id: "t-1",
    title: "Old task",
    dueDate: "2026-12-01",
    status: "inbox",
    previousStatus: "inbox",
    notes: "",
    subtasks: [],
    recurrence: "",
    recurrenceSpawnedId: null,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
  });

  // Undated Today tasks stay undated (no phantom deadline)
  const undatedToday = logic.normalizeTask({ id: "t-2", title: "Do it", dueDate: "", status: "today" });
  assert.strictEqual(undatedToday.dueDate, "");
  assert.strictEqual(undatedToday.status, "today");
  assert.strictEqual(undatedToday.previousStatus, "today");

  // Garbage is sanitized
  const messy = logic.normalizeTask({
    title: "",
    dueDate: "tomorrow",
    status: "bogus",
    previousStatus: "done",
    recurrence: "daily",
    recurrenceSpawnedId: 5,
    notes: 42,
    subtasks: [{ text: " ok ", done: true }, { text: "   " }, "str", null, { id: "st-keep", text: "keep", done: "yes" }],
    createdAt: "x",
    completedAt: "2026-11-01",
    isSample: true,
  });
  assert.ok(typeof messy.id === "string" && messy.id.startsWith("t-"));
  assert.strictEqual(messy.title, "Untitled task");
  assert.strictEqual(messy.dueDate, "");
  assert.strictEqual(messy.status, "inbox");
  assert.strictEqual(messy.previousStatus, "inbox");
  assert.strictEqual(messy.recurrence, "");
  assert.strictEqual(messy.recurrenceSpawnedId, null);
  assert.strictEqual(messy.notes, "");
  assert.strictEqual(messy.completedAt, null, "completedAt only survives on done tasks");
  assert.strictEqual(messy.isSample, true);
  assert.ok(Number.isInteger(messy.createdAt) && messy.updatedAt === messy.createdAt);
  assert.strictEqual(messy.subtasks.length, 2);
  assert.ok(messy.subtasks[0].id.startsWith("st-"));
  assert.deepStrictEqual(
    { text: messy.subtasks[0].text, done: messy.subtasks[0].done },
    { text: "ok", done: true }
  );
  assert.deepStrictEqual(messy.subtasks[1], { id: "st-keep", text: "keep", done: false });

  // Done tasks keep completion info and previousStatus
  const done = logic.normalizeTask({
    id: "t-3",
    title: "Finished",
    status: "done",
    previousStatus: "today",
    completedAt: "2026-11-20",
    recurrence: "monthly",
    recurrenceSpawnedId: "t-9",
    createdAt: 5,
    updatedAt: 9,
  });
  assert.strictEqual(done.completedAt, "2026-11-20");
  assert.strictEqual(done.previousStatus, "today");
  assert.strictEqual(done.recurrence, "monthly");
  assert.strictEqual(done.recurrenceSpawnedId, "t-9");
  assert.strictEqual(done.updatedAt, 9);
  assert.ok(!("isSample" in done));

  // Normalizing twice changes nothing
  assert.deepStrictEqual(logic.normalizeTask(done), done);
});

section("cross-language shared normalize fixture", () => {
  const fixturePath = path.join(__dirname, "test_normalize_fixture.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  fixture.nullCases.forEach((raw) => {
    assert.strictEqual(logic.normalizeTask(raw), null);
  });
  fixture.cases.forEach(({ name, input, expected }) => {
    assert.deepStrictEqual(logic.normalizeTask(input), expected, name);
  });
});

section("applyTaskPatch: validation, previousStatus, sample flag, and recurrence spawn", () => {
  const starter = [
    logic.normalizeTask({
      id: "t-rec",
      title: "Pay bill #home",
      dueDate: "2026-11-25",
      status: "today",
      recurrence: "monthly",
      notes: "Account 123",
      subtasks: [{ id: "st-1", text: "Check meter", done: true }],
      isSample: true,
      createdAt: 1000,
      updatedAt: 1000,
    }),
    logic.normalizeTask({
      id: "t-undated",
      title: "Sort desk",
      dueDate: "",
      status: "inbox",
      createdAt: 900,
      updatedAt: 900,
    }),
  ];

  // Invalid dueDate and recurrence are ignored; isSample cleared on edit; original array not mutated
  const edited = logic.applyTaskPatch(
    starter,
    "t-rec",
    { title: "  Pay power bill #home  ", dueDate: "2026-02-30", recurrence: "daily" },
    fixedToday,
    2000
  );
  assert.strictEqual(starter[0].title, "Pay bill #home", "input array must not be mutated");
  assert.strictEqual(edited.task.title, "Pay power bill #home");
  assert.strictEqual(edited.task.dueDate, "2026-11-25", "invalid date rejected");
  assert.strictEqual(edited.task.recurrence, "monthly", "invalid recurrence rejected");
  assert.ok(!("isSample" in edited.task), "editing a sample clears isSample");
  assert.strictEqual(edited.task.updatedAt, 2000);

  // Completing spawns next occurrence at top with unchecked cloned subtasks
  const completed = logic.applyTaskPatch(edited.tasks, "t-rec", { status: "done" }, fixedToday, 3000);
  assert.strictEqual(completed.task.status, "done");
  assert.strictEqual(completed.task.previousStatus, "today");
  assert.strictEqual(completed.task.completedAt, "2026-11-23");
  assert.ok(completed.spawnedTask, "recurring task spawns next copy");
  assert.strictEqual(completed.tasks[0].id, completed.spawnedTask.id);
  assert.strictEqual(completed.spawnedTask.dueDate, "2026-12-25");
  assert.strictEqual(completed.spawnedTask.status, "inbox");
  assert.strictEqual(completed.spawnedTask.subtasks.length, 1);
  assert.strictEqual(completed.spawnedTask.subtasks[0].done, false);
  assert.notStrictEqual(completed.spawnedTask.subtasks[0].id, "st-1");
  assert.strictEqual(completed.task.recurrenceSpawnedId, completed.spawnedTask.id);

  // Unchecking and re-checking does NOT spawn a duplicate while spawned copy exists
  const reopened = logic.applyTaskPatch(completed.tasks, "t-rec", { status: "today" }, fixedToday, 4000);
  const rechecked = logic.applyTaskPatch(reopened.tasks, "t-rec", { status: "done" }, fixedToday, 5000);
  assert.strictEqual(rechecked.spawnedTask, null);

  // Moving undated task into Today keeps dueDate empty
  const movedToday = logic.applyTaskPatch(starter, "t-undated", { status: "today" }, fixedToday, 6000);
  assert.strictEqual(movedToday.task.status, "today");
  assert.strictEqual(movedToday.task.dueDate, "");

  // Unknown id returns null
  assert.strictEqual(logic.applyTaskPatch(starter, "missing", { title: "x" }, fixedToday, 7000), null);
});

section("mergeTaskLists: parity with server.py merge", () => {
  const existing = [
    { id: "a", title: "A old", createdAt: 1, updatedAt: 100 },
    { id: "b", title: "B newer", createdAt: 1, updatedAt: 500 },
    { id: "c", title: "C tie existing", createdAt: 1, updatedAt: 300, isSample: true },
  ];
  const incoming = [
    { id: "a", title: "A updated", createdAt: 1, updatedAt: 200 },
    { id: "b", title: "B stale", createdAt: 1, updatedAt: 400 },
    { id: "c", title: "C tie incoming", createdAt: 1, updatedAt: 300 },
    { id: "d", title: "D new", createdAt: 1, updatedAt: 50 },
  ];
  const merged = logic.mergeTaskLists(existing, incoming);
  assert.deepStrictEqual(
    merged.map((t) => [t.id, t.title]),
    [
      ["a", "A updated"],
      ["b", "B newer"],
      ["c", "C tie existing"],
      ["d", "D new"],
    ]
  );
});

console.log(`ALL ${count} LOGIC TEST GROUPS PASSED!`);
