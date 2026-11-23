/**
 * logic.js — "The Kitchen"
 * Pure functions that handle dates, the 3-month timeline position,
 * and the transparent-to-solid urgency gradient math.
 *
 * Notice there is NO button or HTML code here — just clear rules
 * (Input -> Logic -> Output) so it is easy to read and test.
 */

const HORIZON_DAYS = 90; // 3 months zoomed out

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
 * - "closeness" goes smoothly from 0 (90+ days away) to 1 (due today or overdue).
 * - Far-away tasks start almost transparent and peak softly.
 * - Close tasks ramp into a rich, full solid color block so they naturally stand out.
 */
function getGradientStyle(daysLeft) {
  // Clamp daysLeft between 0 and HORIZON_DAYS for smooth scaling
  const clamped = Math.max(0, Math.min(HORIZON_DAYS, daysLeft));
  const closeness = 1 - clamped / HORIZON_DAYS; // 0 = far away, 1 = due right now

  // Paper Desk watercolor palette:
  // Far (calm sage) -> Mid (warm ochre) -> Approaching (burnt sienna) -> Imminent (terracotta crimson)
  let rgb;
  if (daysLeft < 0) {
    rgb = [168, 38, 32]; // Overdue deep brick
  } else if (daysLeft <= 3) {
    rgb = [185, 58, 46]; // Imminent terracotta red
  } else if (daysLeft <= 14) {
    rgb = [196, 108, 43]; // Approaching burnt sienna
  } else if (daysLeft <= 35) {
    rgb = [168, 134, 58]; // Mid-term warm ochre
  } else {
    rgb = [92, 118, 106]; // Long-term calm sage
  }

  const [r, g, b] = rgb;

  // Left edge of the bar: near-transparent watercolor wash; right edge: solid color cap
  const startAlpha = Number((0.03 + closeness * 0.34).toFixed(2));
  const endAlpha = Number((0.26 + closeness * 0.74).toFixed(2));

  // Keep dark ink on pale/mid washes; white text only on vivid close-deadline solid blocks
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

/**
 * True calendar width percentage (2.5..100) for a task bar stretching from Today
 * to its exact deadline on the 90-day horizon.
 */
function getTimelineWidthPercent(daysLeft) {
  if (daysLeft <= 0) return 2.5; // Crisp solid block right on Today
  const clamped = Math.min(HORIZON_DAYS, daysLeft);
  const rawPercent = (clamped / HORIZON_DAYS) * 100;
  return Math.max(2.5, Number(rawPercent.toFixed(2)));
}

/**
 * Build the month markers along the 90-day strip (Today + each upcoming month's 1st).
 */
function getMonthMarkers(today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const markers = [
    {
      label: "Today",
      percent: 0,
      isToday: true,
    },
  ];

  for (let offset = 1; offset <= HORIZON_DAYS; offset++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (d.getDate() === 1) {
      const percent = Number(((offset / HORIZON_DAYS) * 100).toFixed(2));
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
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
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

// Export for Node.js tests if running in a test environment, while staying simple in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    HORIZON_DAYS,
    toDateKey,
    parseDateKey,
    daysUntil,
    formatDaysLabel,
    formatShortDate,
    getGradientStyle,
    getTimelineWidthPercent,
    getMonthMarkers,
    countCompletedThisWeek,
    sortTasksByUrgency,
  };
}
