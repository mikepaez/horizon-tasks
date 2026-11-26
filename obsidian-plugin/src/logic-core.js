/**
 * logic-core.js — Horizon LifeOS Pure Domain Engine
 *
 * Pure, dependency-free functions (no DOM, no Obsidian I/O, no Node fs).
 * Shared by the Obsidian plugin bundle and Node automated tests.
 */

const HORIZON_DAYS = 90;
const MIN_HORIZON_DAYS = 1;
const MAX_HORIZON_DAYS = 730;
const HORIZON_PRESETS = [7, 14, 30, 90, 180, 365];
const DEFAULT_TODAY_CAP = 3;
const FRESH_DAYS = 7;
const STALE_DAYS = 14;
const MILESTONE_SAFE_DAYS = 21;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const URL_TOKEN_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

const CONTROL_TAGS = new Set(["today", "waiting", "someday", "next", "sample"]);
const AREA_SHORTCUT_TAGS = new Map([
  ["work", "Work"],
  ["w", "Work"],
  ["personal", "Personal"],
  ["p", "Personal"],
  ["health", "Health"],
  ["finance", "Finance"],
]);

const AREA_RAMPS = {
  warm: {
    // Work default: sage -> ochre -> burnt sienna -> terracotta -> crimson
    overdue: [168, 38, 32],
    urgent: [185, 58, 46],
    soon: [196, 108, 43],
    mid: [168, 134, 58],
    far: [92, 118, 106],
  },
  slate: {
    // Cool slate-blue ramp (Personal)
    overdue: [155, 52, 58],
    urgent: [62, 95, 132],
    soon: [74, 110, 140],
    mid: [88, 120, 138],
    far: [104, 128, 138],
  },
  forest: {
    // Deep sage / spruce ramp (Health / Home)
    overdue: [158, 55, 48],
    urgent: [49, 104, 82],
    soon: [64, 118, 92],
    mid: [84, 128, 102],
    far: [106, 136, 118],
  },
  plum: {
    // Muted mineral plum-ochre ramp (Finance / Custom)
    overdue: [162, 48, 56],
    urgent: [122, 76, 116],
    soon: [132, 88, 118],
    mid: [136, 102, 120],
    far: [128, 110, 126],
  },
};

// ============================================================================
// 1. DST-Safe Date Arithmetic
// ============================================================================

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateKey(dateKey) {
  if (!dateKey) return null;
  if (dateKey instanceof Date && !Number.isNaN(dateKey.getTime())) {
    return new Date(dateKey.getFullYear(), dateKey.getMonth(), dateKey.getDate());
  }
  if (typeof dateKey !== "string") return null;
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

function normalizeDateValue(raw) {
  if (!raw) return "";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return toDateKey(raw);
  }
  const s = String(raw).trim();
  const parsed = parseDateKey(s);
  return parsed ? toDateKey(parsed) : "";
}

function addDaysKey(base, deltaDays) {
  const d = typeof base === "string" ? parseDateKey(base) : new Date(base.getTime());
  if (!d) return "";
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays));
}

function addMonthsClamped(year, monthIndex, anchorDay, months) {
  const total = year * 12 + monthIndex + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(ny, nm + 1, 0).getDate();
  return new Date(ny, nm, Math.min(anchorDay, lastDay));
}

function getNextWeekdayKey(targetDow, today = new Date()) {
  const diff = (targetDow - today.getDay() + 7) % 7 || 7;
  return addDaysKey(today, diff);
}

function daysUntil(dueDateKey, today = new Date()) {
  const due = parseDateKey(dueDateKey);
  if (!due) return null;
  const dueUtc = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const todayRef = parseDateKey(today) || today;
  const todayUtc = Date.UTC(todayRef.getFullYear(), todayRef.getMonth(), todayRef.getDate());
  return Math.round((dueUtc - todayUtc) / 86400000);
}

function daysBetweenKeys(startKey, endKey) {
  const a = parseDateKey(startKey);
  const b = parseDateKey(endKey);
  if (!a || !b) return null;
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
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
// 2. Simple Built-in Recurrence (Fallback when Tasks plugin is not enabled)
// ============================================================================

function parseSimpleRecurrenceKind(ruleText) {
  if (!ruleText || typeof ruleText !== "string") return "";
  const clean = ruleText.trim().toLowerCase();
  if (clean === "weekly" || clean === "every week" || clean === "every 1 week") return "weekly";
  if (clean === "monthly" || clean === "every month" || clean === "every 1 month") return "monthly";
  if (clean === "quarterly" || clean === "every 3 months" || clean === "every quarter") return "quarterly";
  if (clean === "yearly" || clean === "every year" || clean === "every 1 year" || clean === "annually") return "yearly";
  return "";
}

function formatSimpleRecurrenceRule(kind) {
  if (kind === "weekly") return "every week";
  if (kind === "monthly") return "every month";
  if (kind === "quarterly") return "every 3 months";
  if (kind === "yearly") return "every year";
  return "";
}

function computeSimpleNextDate(baseDateKey, recurrenceRule, today = new Date()) {
  const kind = parseSimpleRecurrenceKind(recurrenceRule);
  if (!kind) return null;
  const base = parseDateKey(baseDateKey || toDateKey(today));
  if (!base) return null;
  const todayKey = toDateKey(today);
  const anchorDay = base.getDate();

  const step = (n) => {
    if (kind === "weekly") {
      return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * n);
    }
    const monthsPerStep = kind === "monthly" ? 1 : kind === "quarterly" ? 3 : 12;
    return addMonthsClamped(base.getFullYear(), base.getMonth(), anchorDay, monthsPerStep * n);
  };

  let n = 1;
  let next = toDateKey(step(n));
  while (next <= todayKey && n < 200000) {
    n += 1;
    next = toDateKey(step(n));
  }
  return next;
}

// ============================================================================
// 3. Quick Capture Parser & Multi-Area Discovery
// ============================================================================

function cleanAreaName(raw, fallback = "Work") {
  if (!raw || typeof raw !== "string") return fallback;
  const stripped = raw
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .split("/")
    .pop()
    .trim();
  return stripped || fallback;
}

/**
 * Parse lightweight quick-capture tokens from capture input:
 *   !today, !inbox, +project / !project, #someday, #waiting,
 *   #work/#w, #personal/#p, #health, #finance, @<AreaName>,
 *   @today, @tom/@tomorrow, @+Nd/@+Nw/@+Nm, @mon..@sun
 */
function parseQuickCapture(rawText, knownAreas = ["Work", "Personal", "Health", "Finance"], today = new Date()) {
  const dowMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const areaLookup = new Map();
  for (const area of knownAreas || []) {
    if (area && typeof area === "string") {
      areaLookup.set(area.trim().toLowerCase(), area.trim());
    }
  }

  let isToday = false;
  let forceInbox = false;
  let forceProject = false;
  let isSomeday = false;
  let isWaiting = false;
  let area = null;
  let dueDate = null;
  const kept = [];

  for (const token of String(rawText || "").trim().split(/\s+/)) {
    if (!token) continue;
    const low = token.toLowerCase();
    if (low === "!today") {
      isToday = true;
      continue;
    }
    if (low === "!inbox") {
      forceInbox = true;
      continue;
    }
    if (low === "!project" || low === "+project") {
      forceProject = true;
      continue;
    }
    if (low === "#someday") {
      isSomeday = true;
      continue;
    }
    if (low === "#waiting") {
      isWaiting = true;
      continue;
    }
    if (low.startsWith("#")) {
      const bare = low.slice(1);
      if (AREA_SHORTCUT_TAGS.has(bare)) {
        area = AREA_SHORTCUT_TAGS.get(bare);
        continue;
      }
      if (areaLookup.has(bare)) {
        area = areaLookup.get(bare);
        continue;
      }
    }
    if (low === "@today") {
      dueDate = toDateKey(today);
      continue;
    }
    if (low === "@tom" || low === "@tomorrow") {
      dueDate = addDaysKey(today, 1);
      continue;
    }
    const rel = /^@\+(\d{1,4})([dwm])$/i.exec(low);
    if (rel) {
      const amount = parseInt(rel[1], 10);
      const unit = rel[2];
      if (unit === "m") {
        dueDate = toDateKey(
          addMonthsClamped(today.getFullYear(), today.getMonth(), today.getDate(), amount)
        );
      } else {
        const days = unit === "w" ? amount * 7 : amount;
        dueDate = addDaysKey(today, days);
      }
      continue;
    }
    if (low.startsWith("@") && Object.prototype.hasOwnProperty.call(dowMap, low.slice(1))) {
      dueDate = getNextWeekdayKey(dowMap[low.slice(1)], today);
      continue;
    }
    if (low.startsWith("@") && areaLookup.has(low.slice(1))) {
      area = areaLookup.get(low.slice(1));
      continue;
    }
    kept.push(token);
  }

  return {
    title: kept.join(" ").trim(),
    isToday,
    forceInbox,
    forceProject,
    isSomeday,
    isWaiting,
    area,
    dueDate,
  };
}

function extractCustomTags(text) {
  if (typeof text !== "string") return [];
  const re = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]{0,39})/gu;
  const seen = new Set();
  const tags = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const tag = match[1].toLowerCase();
    if (CONTROL_TAGS.has(tag) || AREA_SHORTCUT_TAGS.has(tag)) continue;
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function getAllCustomTags(items) {
  const all = new Set();
  for (const item of items || []) {
    if (!item || item.status === "done" || item.status === "dropped") continue;
    for (const tag of item.tags || []) {
      if (!CONTROL_TAGS.has(tag) && !AREA_SHORTCUT_TAGS.has(tag)) {
        all.add(tag);
      }
    }
  }
  return [...all].sort();
}

// ============================================================================
// 4. Multi-Area Watercolor Ramps & Timeline Math
// ============================================================================

function hashString32(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function resolveAreaRampName(area, rampOverrides = null) {
  const key = cleanAreaName(area, "Work").toLowerCase();
  if (rampOverrides && typeof rampOverrides[key] === "string" && AREA_RAMPS[rampOverrides[key]]) {
    return rampOverrides[key];
  }
  if (key === "work") return "warm";
  if (key === "personal") return "slate";
  if (key === "health") return "forest";
  if (key === "finance") return "plum";
  const choices = ["slate", "forest", "plum"];
  return choices[hashString32(key) % choices.length];
}

function getAreaGradientStyle(daysLeft, area = "Work", horizonDays = HORIZON_DAYS, isDark = false, rampOverrides = null) {
  const rampName = resolveAreaRampName(area, rampOverrides);
  const ramp = AREA_RAMPS[rampName] || AREA_RAMPS.warm;

  if (daysLeft === null || daysLeft === undefined || Number.isNaN(daysLeft)) {
    const fallbackRgb = isDark ? [170, 156, 136] : [110, 97, 80];
    const [r, g, b] = fallbackRgb;
    return {
      rampName,
      closeness: 0,
      startAlpha: 0.08,
      endAlpha: 0.22,
      background: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0.08) 0%, rgba(${r}, ${g}, ${b}, 0.22) 100%)`,
      borderColor: `rgb(${r}, ${g}, ${b})`,
      textColor: isDark ? "#f2ebe0" : "#231e18",
      badgeBg: `rgba(${r}, ${g}, ${b}, 0.16)`,
      badgeColor: isDark ? "#dfd4c3" : "rgb(80, 67, 50)",
    };
  }

  const horizon = parseHorizonDays(horizonDays, HORIZON_DAYS);
  const clamped = Math.max(0, Math.min(horizon, daysLeft));
  const closeness = 1 - clamped / horizon;

  let rgb;
  if (daysLeft < 0) rgb = ramp.overdue;
  else if (daysLeft <= 3) rgb = ramp.urgent;
  else if (daysLeft <= 14) rgb = ramp.soon;
  else if (daysLeft <= 35) rgb = ramp.mid;
  else rgb = ramp.far;

  const [r, g, b] = rgb;
  const startAlpha = Number((0.04 + closeness * 0.34).toFixed(2));
  const endAlpha = Number((0.28 + closeness * 0.72).toFixed(2));
  const useLightText = isDark || (daysLeft <= 3 && closeness >= 0.85);
  const badgeDarken = rampName === "warm" && daysLeft > 14 && daysLeft <= 35 ? 54 : 30;
  const badgeLighten = 65;

  return {
    rampName,
    closeness: Number(closeness.toFixed(3)),
    startAlpha,
    endAlpha,
    background: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, ${startAlpha}) 0%, rgba(${r}, ${g}, ${b}, ${endAlpha}) 100%)`,
    borderColor: `rgb(${r}, ${g}, ${b})`,
    textColor: useLightText ? "#fdfaf4" : "#231e18",
    badgeBg: `rgba(${r}, ${g}, ${b}, ${Number(((isDark ? 0.22 : 0.12) + closeness * 0.2).toFixed(2))})`,
    badgeColor: isDark
      ? `rgb(${Math.min(250, r + badgeLighten)}, ${Math.min(246, g + badgeLighten)}, ${Math.min(240, b + badgeLighten)})`
      : `rgb(${Math.max(0, r - badgeDarken)}, ${Math.max(0, g - badgeDarken)}, ${Math.max(0, b - badgeDarken)})`,
  };
}

function parseHorizonDays(raw, fallback = HORIZON_DAYS) {
  const safeFallback =
    typeof fallback === "number" && Number.isFinite(fallback) && fallback >= MIN_HORIZON_DAYS
      ? Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, Math.round(fallback)))
      : HORIZON_DAYS;

  let parsed = NaN;
  if (typeof raw === "number") {
    parsed = Number.isFinite(raw) ? Math.round(raw) : NaN;
  } else if (typeof raw === "string") {
    const match = /^\s*(\d+)\s*d?\s*$/i.exec(raw);
    if (match) parsed = parseInt(match[1], 10);
  }

  if (!Number.isFinite(parsed) || parsed < MIN_HORIZON_DAYS) return safeFallback;
  return Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, parsed));
}

function getHorizonHeadingText(days) {
  const d = parseHorizonDays(days, HORIZON_DAYS);
  if (d === 1) return "1-Day Horizon";
  if (d === 7) return "1-Week Horizon";
  if (d === 14) return "2-Week Horizon";
  if (d === 21) return "3-Week Horizon";
  if (d === 90) return "3-Month Horizon";
  if (d === 180) return "6-Month Horizon";
  if (d === 365) return "1-Year Horizon";
  if (d === 730) return "2-Year Horizon";
  return `${d}-Day Horizon`;
}

function getTimelineWidthPercent(daysLeft, horizonDays = HORIZON_DAYS) {
  if (daysLeft === null || daysLeft === undefined || Number.isNaN(daysLeft) || daysLeft <= 0) {
    return 2.5;
  }
  const horizon = parseHorizonDays(horizonDays, HORIZON_DAYS);
  const clamped = Math.min(horizon, daysLeft);
  const rawPercent = (clamped / horizon) * 100;
  return Math.min(100, Math.max(2.5, Number(rawPercent.toFixed(2))));
}

function getItemProgressRatio(item) {
  if (!item) return 0;
  const steps = Array.isArray(item.steps) ? item.steps : [];
  if (item.isProject && steps.length > 0) {
    const activeSteps = steps.filter((s) => !s.dropped);
    if (activeSteps.length > 0) {
      const done = activeSteps.filter((s) => s.done).length;
      if (done > 0 || item.stage === "started") {
        return Math.max(0.08, done / activeSteps.length);
      }
    }
  }
  if (item.stage === "started") return 0.08;
  return 0;
}

function getMonthMarkers(today = new Date(), horizonDays = HORIZON_DAYS) {
  const horizon = parseHorizonDays(horizonDays, HORIZON_DAYS);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const markers = [{ label: "Today", percent: 0, isToday: true }];

  for (let offset = 1; offset <= horizon; offset++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (d.getDate() === 1) {
      const percent = Number(((offset / horizon) * 100).toFixed(2));
      if (percent >= 8 && percent <= 94) {
        const label =
          d.getMonth() === 0 ? `${SHORT_MONTHS[0]} ${d.getFullYear()}` : SHORT_MONTHS[d.getMonth()];
        markers.push({ label, percent, isToday: false });
      }
    }
  }
  return markers;
}

function getTimelineAxis(today = new Date(), horizonDays = HORIZON_DAYS) {
  const horizon = parseHorizonDays(horizonDays, HORIZON_DAYS);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const toPercent = (offset) => Number(((offset / horizon) * 100).toFixed(2));
  const dateAt = (offset) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);

  const markers = [{ label: "Today", percent: 0, isToday: true, isMajor: true, isAccent: false }];
  const gridLines = [];

  if (horizon <= 21) {
    const minGapPct = 15;
    const maxPct = 92;
    const minDayGap = Math.max(1, Math.ceil((minGapPct / 100) * horizon));
    const picked = [{ offset: 0, percent: 0 }];

    const canPlace = (pct) =>
      pct >= minGapPct &&
      pct <= maxPct &&
      picked.every((p) => Math.abs(p.percent - pct) >= minGapPct);

    const formatShortLabel = (dt) =>
      dt.getDate() === 1
        ? `${SHORT_MONTHS[dt.getMonth()]} 1`
        : `${SHORT_WEEKDAYS[dt.getDay()]} ${dt.getDate()}`;

    for (let d = 1; d < horizon; d++) {
      const dt = dateAt(d);
      gridLines.push({ percent: toPercent(d), isMajor: dt.getDate() === 1 || dt.getDay() === 1 });
    }
    for (let d = 1; d < horizon; d++) {
      const dt = dateAt(d);
      const pct = toPercent(d);
      if (dt.getDate() === 1 && canPlace(pct)) {
        picked.push({ offset: d, percent: pct, label: formatShortLabel(dt), isMajor: true, isAccent: true });
      }
    }
    for (let d = 1; d < horizon; d++) {
      const dt = dateAt(d);
      const pct = toPercent(d);
      if (dt.getDay() === 1 && canPlace(pct)) {
        picked.push({ offset: d, percent: pct, label: formatShortLabel(dt), isMajor: true, isAccent: true });
      }
    }

    picked.sort((a, b) => a.offset - b.offset);
    const anchors = [...picked, { offset: horizon, percent: 100 }];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      const spanPct = b.percent - a.percent;
      const spanDays = b.offset - a.offset;
      if (spanPct < minGapPct * 2 || spanDays < minDayGap * 2) continue;

      const maxPossible = Math.floor(spanDays / minDayGap) - 1;
      const desired = Math.max(1, Math.round(spanPct / 22) - 1);
      const count = Math.min(desired, maxPossible);
      if (count <= 0) continue;

      for (let k = 1; k <= count; k++) {
        const d = Math.round(a.offset + (spanDays * k) / (count + 1));
        if (d <= a.offset || d >= b.offset || d >= horizon) continue;
        const pct = toPercent(d);
        if (canPlace(pct)) {
          picked.push({ offset: d, percent: pct, label: formatShortLabel(dateAt(d)), isMajor: false, isAccent: false });
        }
      }
    }

    picked
      .filter((p) => p.offset > 0)
      .sort((a, b) => a.offset - b.offset)
      .forEach((p) => {
        markers.push({ label: p.label, percent: p.percent, isToday: false, isMajor: p.isMajor, isAccent: p.isAccent });
      });

    return { markers, gridLines };
  }

  if (horizon <= 45) {
    const minGapPct = 16;
    const maxPct = 92;
    const minDayGap = Math.max(1, Math.ceil((minGapPct / 100) * horizon));
    const majorOffsets = new Set();
    const picked = [{ offset: 0, percent: 0 }];

    const canPlace = (pct) =>
      pct >= minGapPct &&
      pct <= maxPct &&
      picked.every((p) => Math.abs(p.percent - pct) >= minGapPct);

    for (let d = 1; d < horizon; d++) {
      const dt = dateAt(d);
      if (dt.getDate() === 1) {
        const pct = toPercent(d);
        majorOffsets.add(d);
        gridLines.push({ percent: pct, isMajor: true });
        if (canPlace(pct)) {
          const label = dt.getMonth() === 0 ? `${SHORT_MONTHS[0]} ${dt.getFullYear()}` : SHORT_MONTHS[dt.getMonth()];
          picked.push({ offset: d, percent: pct, label, isMajor: true, isAccent: true });
        }
      }
    }

    for (let d = 7; d < horizon; d += 7) {
      if (!majorOffsets.has(d)) gridLines.push({ percent: toPercent(d), isMajor: false });
    }
    gridLines.sort((a, b) => a.percent - b.percent);

    picked.sort((a, b) => a.offset - b.offset);
    const anchors = [...picked, { offset: horizon, percent: 100 }];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      const spanPct = b.percent - a.percent;
      const spanDays = b.offset - a.offset;
      if (spanPct < minGapPct * 2 || spanDays < minDayGap * 2) continue;
      const maxPossible = Math.floor(spanDays / minDayGap) - 1;
      const desired = Math.max(1, Math.round(spanPct / 26) - 1);
      const count = Math.min(desired, maxPossible);
      if (count <= 0) continue;

      for (let k = 1; k <= count; k++) {
        let d = Math.round(a.offset + (spanDays * k) / (count + 1));
        for (const delta of [0, -1, 1, -2, 2]) {
          const cand = d + delta;
          if (cand > a.offset && cand < b.offset && cand < horizon) {
            if (dateAt(cand).getDay() === 1 && canPlace(toPercent(cand))) {
              d = cand;
              break;
            }
          }
        }
        if (d <= a.offset || d >= b.offset || d >= horizon) continue;
        const pct = toPercent(d);
        if (canPlace(pct)) {
          const dt = dateAt(d);
          picked.push({
            offset: d,
            percent: pct,
            label: `${SHORT_MONTHS[dt.getMonth()]} ${dt.getDate()}`,
            isMajor: false,
            isAccent: false,
          });
        }
      }
    }

    picked
      .filter((p) => p.offset > 0)
      .sort((a, b) => a.offset - b.offset)
      .forEach((p) => {
        markers.push({ label: p.label, percent: p.percent, isToday: false, isMajor: p.isMajor, isAccent: p.isAccent });
      });

    return { markers, gridLines };
  }

  if (horizon <= 240) {
    const monthMarkers = getMonthMarkers(start, horizon);
    monthMarkers.forEach((m) => {
      if (!m.isToday) {
        markers.push({ label: m.label, percent: m.percent, isToday: false, isMajor: true, isAccent: false });
        gridLines.push({ percent: m.percent, isMajor: true });
      }
    });
    const tickStep = horizon > 90 ? 14 : 7;
    for (let d = tickStep; d < horizon; d += tickStep) {
      gridLines.push({ percent: toPercent(d), isMajor: false });
    }
    gridLines.sort((a, b) => a.percent - b.percent);
    return { markers, gridLines };
  }

  const minGapPct = 7.5;
  const maxPct = 94;
  const monthStarts = [];
  for (let d = 1; d < horizon; d++) {
    const dt = dateAt(d);
    if (dt.getDate() === 1) {
      const pct = toPercent(d);
      const isJan = dt.getMonth() === 0;
      const shortYear = String(dt.getFullYear()).slice(-2);
      const label = isJan ? `${SHORT_MONTHS[0]} '${shortYear}` : SHORT_MONTHS[dt.getMonth()];
      monthStarts.push({ offset: d, percent: pct, isJan, label });
    }
  }

  const picked = [{ offset: 0, percent: 0 }];
  const canPlace = (pct) =>
    pct >= minGapPct &&
    pct <= maxPct &&
    picked.every((p) => Math.abs(p.percent - pct) >= minGapPct);

  monthStarts.forEach((m) => {
    if (m.isJan && canPlace(m.percent)) picked.push({ ...m, isMajor: true, isAccent: true });
  });
  monthStarts.forEach((m) => {
    if (!m.isJan && canPlace(m.percent)) picked.push({ ...m, isMajor: true, isAccent: false });
  });

  const labeledOffsets = new Set(picked.filter((p) => p.offset > 0).map((p) => p.offset));
  monthStarts.forEach((m) => {
    gridLines.push({ percent: m.percent, isMajor: m.isJan || labeledOffsets.has(m.offset) });
  });

  picked
    .filter((p) => p.offset > 0)
    .sort((a, b) => a.offset - b.offset)
    .forEach((p) => {
      markers.push({ label: p.label, percent: p.percent, isToday: false, isMajor: true, isAccent: p.isAccent });
    });

  return { markers, gridLines };
}

// ============================================================================
// 5. Fading Ink Freshness, Sorting, Check-in & Weekly Review
// ============================================================================

/**
 * Compute ink freshness for an active item.
 * Exempts done, dropped, waiting, someday, inbox, snoozed items (🛫 >= today), and milestones >21d away.
 * Reference date uses touchedAt -> createdDate -> fileMtime.
 */
function getItemFreshness(item, today = new Date()) {
  if (
    !item ||
    item.status === "done" ||
    item.status === "dropped" ||
    item.stage === "waiting" ||
    item.isSomeday ||
    item.kind === "inbox-line" ||
    item.kind === "inbox-note"
  ) {
    return { daysUntouched: 0, opacity: 1, isFading: false, isStale: false };
  }

  if (item.snoozedUntil) {
    const snoozeDays = daysUntil(item.snoozedUntil, today);
    if (snoozeDays !== null && snoozeDays >= 0) {
      return { daysUntouched: 0, opacity: 1, isFading: false, isStale: false };
    }
  }

  let refMs = Number(item.touchedAt);
  if (!Number.isFinite(refMs) || refMs <= 0) {
    const createdParsed = parseDateKey(item.createdDate);
    refMs = createdParsed ? createdParsed.getTime() : Number(item.fileMtime) || today.getTime();
  }
  let refDate = new Date(refMs);

  if (item.dueDate) {
    const dueDays = daysUntil(item.dueDate, today);
    if (dueDays !== null && dueDays > MILESTONE_SAFE_DAYS) {
      return { daysUntouched: 0, opacity: 1, isFading: false, isStale: false };
    }
    if (dueDays !== null) {
      const windowStart = parseDateKey(addDaysKey(item.dueDate, -MILESTONE_SAFE_DAYS));
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

function sortItemsByUrgency(items, today = new Date()) {
  const stageRank = { started: 0, todo: 1, waiting: 2 };
  return [...(items || [])].sort((a, b) => {
    const da = a.dueDate ? daysUntil(a.dueDate, today) : null;
    const db = b.dueDate ? daysUntil(b.dueDate, today) : null;
    const va = da === null ? Infinity : da;
    const vb = db === null ? Infinity : db;
    if (va !== vb) return va - vb;
    if (Boolean(a.isProject) !== Boolean(b.isProject)) {
      return a.isProject ? -1 : 1;
    }
    const sa = stageRank[a.stage] ?? 1;
    const sb = stageRank[b.stage] ?? 1;
    if (sa !== sb) return sa - sb;
    return (b.touchedAt || 0) - (a.touchedAt || 0);
  });
}

function getMorningCheckinDeck(items, inboxItems = [], today = new Date()) {
  const active = (items || []).filter((t) => t && t.status !== "done" && t.status !== "dropped" && !t.isSomeday);
  const started = sortItemsByUrgency(active.filter((t) => t.stage === "started"), today);
  const missingNext = sortItemsByUrgency(active.filter((t) => t.needsNextStep), today);
  const waiting = sortItemsByUrgency(active.filter((t) => t.stage === "waiting"), today);
  const dueSoon = sortItemsByUrgency(
    active.filter((t) => {
      if (t.stage === "waiting" || !t.dueDate) return false;
      const d = daysUntil(t.dueDate, today);
      return d !== null && d <= 7;
    }),
    today
  );
  const fading = sortItemsByUrgency(
    active.filter((t) => getItemFreshness(t, today).isStale),
    today
  );

  const cards = [];
  for (const inb of inboxItems || []) {
    cards.push({ kind: "inbox", item: inb });
  }

  const seen = new Set();
  const pushItem = (item, kind) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    cards.push({ kind, item });
  };

  started.forEach((t) => pushItem(t, "started"));
  missingNext.forEach((t) => pushItem(t, "missingNext"));
  dueSoon.forEach((t) => pushItem(t, "dueSoon"));
  waiting.forEach((t) => pushItem(t, "waiting"));
  fading.forEach((t) => pushItem(t, "fading"));

  return {
    counts: {
      inbox: (inboxItems || []).length,
      started: started.length,
      missingNext: missingNext.length,
      dueSoon: dueSoon.length,
      waiting: waiting.length,
      fading: fading.length,
    },
    cards,
  };
}

/**
 * 4-stage GTD Weekly Review deck:
 *   1. Inbox Zero
 *   2. Active Projects (verify next step & clean up done)
 *   3. Waiting On follow-ups
 *   4. Someday/Maybe scan & Archive Ready
 */
function getWeeklyReviewDeck(items, inboxItems = [], today = new Date()) {
  const all = items || [];
  const activeProjects = sortItemsByUrgency(
    all.filter((t) => t.isProject && t.status !== "done" && t.status !== "dropped" && !t.isSomeday),
    today
  );
  const waiting = sortItemsByUrgency(
    all.filter((t) => t.stage === "waiting" && t.status !== "done" && t.status !== "dropped"),
    today
  );
  const someday = sortItemsByUrgency(
    all.filter((t) => t.isSomeday && t.status !== "done" && t.status !== "dropped"),
    today
  );
  const doneItems = all.filter((t) => t.status === "done" || t.status === "dropped");

  const cards = [];
  for (const inb of inboxItems || []) {
    cards.push({ step: 1, stepLabel: "1/4 · Inbox Zero", kind: "inbox", item: inb });
  }
  for (const proj of activeProjects) {
    cards.push({ step: 2, stepLabel: "2/4 · Active Projects", kind: "projectReview", item: proj });
  }
  for (const w of waiting) {
    cards.push({ step: 3, stepLabel: "3/4 · Waiting On", kind: "waiting", item: w });
  }
  for (const sd of someday) {
    cards.push({ step: 4, stepLabel: "4/4 · Someday/Maybe", kind: "somedayReview", item: sd });
  }
  if (doneItems.length > 0) {
    cards.push({
      step: 4,
      stepLabel: "4/4 · Archive Done",
      kind: "archiveSummary",
      doneCount: doneItems.length,
      item: null,
    });
  }

  return {
    counts: {
      inbox: (inboxItems || []).length,
      projects: activeProjects.length,
      waiting: waiting.length,
      someday: someday.length,
      archivable: doneItems.length,
    },
    cards,
  };
}

function getWeeklyMomentum(items, archivedItems = [], today = new Date(), { lastWeek = false } = {}) {
  const endDate = lastWeek
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 6);

  let tasksDone = 0;
  let stepsDone = 0;
  const seenIds = new Set();

  for (const t of [...(items || []), ...(archivedItems || [])]) {
    if (!t || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    if (t.status === "done" && t.completedDate) {
      const d = parseDateKey(t.completedDate);
      if (d && d >= startDate && d <= endDate) tasksDone += 1;
    }
    if (Array.isArray(t.steps)) {
      for (const s of t.steps) {
        if (s && s.done && s.completedDate) {
          const sd = parseDateKey(s.completedDate);
          if (sd && sd >= startDate && sd <= endDate) stepsDone += 1;
        }
      }
    }
  }
  return { tasksDone, stepsDone };
}

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

// ============================================================================
// 6. Anonymized Long-Term Audit Engine (Zero Titles, Zero Names, Zero Tags)
// ============================================================================

function computeAnonHashId(seedStr) {
  const h1 = hashString32(seedStr);
  const h2 = hashString32(`hz-salt:${seedStr}:${h1}`);
  return `hz_${(h1 ^ h2).toString(16).padStart(8, "0")}`;
}

/**
 * Derive an irreversible, path-move-stable anonymized ID (hz_xxxxxxxx).
 * Projects hash basename + createdDate so moving 10_Projects/ -> 40_Archives/ preserves identity.
 * Tasks hash blockId (when present) + createdDate so line moves / archiving preserve identity.
 */
function getItemAnonHashId(item) {
  if (!item || typeof item !== "object") return computeAnonHashId("unknown");
  const createdDate = normalizeDateValue(item.createdDate) || "";
  if (item.isProject) {
    const fileName = String(item.filePath || item.id || "")
      .split("/")
      .pop();
    return computeAnonHashId(`proj:${fileName}|${createdDate}`);
  }
  const baseKey = item.blockId ? `blk:${item.blockId}` : String(item.id || "");
  return computeAnonHashId(`${baseKey}|${createdDate}`);
}

const VALID_BEHAVIOR_EVENTS = new Set([
  "capture",
  "inbox_clarify",
  "today_pin",
  "today_bump",
  "started",
  "waiting",
  "due_push",
  "snooze_2w",
  "keep_stale",
  "step_done",
  "promote_project",
  "done",
  "dropped",
  "checkin_complete",
  "weekly_review_complete",
]);

function sanitizeEventMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== "object") return {};
  const out = {};
  if (typeof rawMeta.deltaDays === "number" && Number.isFinite(rawMeta.deltaDays)) {
    out.deltaDays = Math.round(rawMeta.deltaDays);
  }
  if (typeof rawMeta.lagDays === "number" && Number.isFinite(rawMeta.lagDays)) {
    out.lagDays = Math.max(0, Math.round(rawMeta.lagDays));
  }
  if (typeof rawMeta.stepCount === "number" && Number.isFinite(rawMeta.stepCount)) {
    out.stepCount = Math.max(0, Math.round(rawMeta.stepCount));
  }
  if (typeof rawMeta.wasToday === "boolean") {
    out.wasToday = rawMeta.wasToday;
  }
  if (typeof rawMeta.action === "string" && ["task", "project", "someday", "resource", "drop"].includes(rawMeta.action)) {
    out.action = rawMeta.action;
  }
  if (typeof rawMeta.mode === "string" && ["task", "inbox", "project"].includes(rawMeta.mode)) {
    out.mode = rawMeta.mode;
  }
  return out;
}

/**
 * Create a strictly PII-free behavioral log entry (zero titles, zero notes, zero person names).
 */
function createBehaviorEvent({ item = null, hashId = "", kind = "task", area = "", event, meta = null, now = new Date() }) {
  if (!VALID_BEHAVIOR_EVENTS.has(event)) {
    throw new Error(`Invalid behavior event: ${event}`);
  }
  const dt = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const resolvedHash = hashId || (item ? getItemAnonHashId(item) : "");
  const resolvedKind = item ? (item.isProject ? "project" : "task") : ["project", "task", "inbox", "system"].includes(kind) ? kind : "task";
  const resolvedArea = resolvedKind === "system" ? "System" : cleanAreaName(area || item?.area || "", "Work");

  return {
    ts: dt.toISOString(),
    date: toDateKey(dt),
    dow: SHORT_WEEKDAYS[dt.getDay()],
    hour: dt.getHours(),
    hashId: resolvedHash,
    kind: resolvedKind,
    area: resolvedArea,
    event,
    meta: sanitizeEventMeta(meta),
  };
}

function csvEscape(val) {
  const s = val === null || val === undefined ? "" : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build a strictly anonymized GTD + PARA audit dataset across active + archived items + event log.
 * Emits NO titles, NO notes, NO waitingOn person names, NO custom tags, and NO file paths.
 */
function buildAnonymizedAudit(activeItems = [], archivedItems = [], today = new Date(), behaviorEvents = []) {
  const todayKey = toDateKey(today);
  const combined = [];
  const seen = new Set();

  for (const item of [...(activeItems || []), ...(archivedItems || [])]) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    combined.push(item);
  }

  // Deduplicate & index valid behavior events by hashId
  const dedupedEvents = [];
  const seenEventKeys = new Set();
  const byHash = new Map();

  for (const rawEv of behaviorEvents || []) {
    if (!rawEv || typeof rawEv !== "object" || !VALID_BEHAVIOR_EVENTS.has(rawEv.event)) continue;
    const ev = {
      ts: typeof rawEv.ts === "string" ? rawEv.ts : "",
      date: normalizeDateValue(rawEv.date) || "",
      dow: typeof rawEv.dow === "string" ? rawEv.dow : "",
      hour: typeof rawEv.hour === "number" ? rawEv.hour : null,
      hashId: typeof rawEv.hashId === "string" ? rawEv.hashId : "",
      kind: typeof rawEv.kind === "string" ? rawEv.kind : "task",
      area: typeof rawEv.area === "string" ? rawEv.area : "Work",
      event: rawEv.event,
      meta: sanitizeEventMeta(rawEv.meta),
    };
    const dedupKey = `${ev.ts}|${ev.hashId}|${ev.event}`;
    if (seenEventKeys.has(dedupKey)) continue;
    seenEventKeys.add(dedupKey);
    dedupedEvents.push(ev);

    if (ev.hashId) {
      if (!byHash.has(ev.hashId)) byHash.set(ev.hashId, []);
      byHash.get(ev.hashId).push(ev);
    }
  }

  const records = combined.map((item) => {
    const outcome = item.status === "done" ? "done" : item.status === "dropped" ? "dropped" : "open";
    const createdDate = normalizeDateValue(item.createdDate) || "";
    const dueDate = normalizeDateValue(item.dueDate) || "";
    const closedDate =
      outcome === "done"
        ? normalizeDateValue(item.completedDate) || ""
        : outcome === "dropped"
        ? normalizeDateValue(item.droppedDate || item.completedDate) || ""
        : "";

    const cycleDays =
      outcome !== "open" && createdDate && closedDate
        ? Math.max(0, daysBetweenKeys(createdDate, closedDate) ?? 0)
        : null;
    const ageDays =
      outcome === "open" && createdDate
        ? Math.max(0, daysBetweenKeys(createdDate, todayKey) ?? 0)
        : null;
    const dueSlipDays =
      outcome !== "open" && dueDate && closedDate
        ? daysBetweenKeys(dueDate, closedDate)
        : null;

    const steps = Array.isArray(item.steps) ? item.steps : [];
    const stepsDone = steps.filter((s) => s && s.done).length;
    const hashId = getItemAnonHashId(item);
    const evs = byHash.get(hashId) || [];

    let rescheduleCount = 0;
    let totalPushedDays = 0;
    let snoozeCount = 0;
    let keepCount = 0;
    let todayPinCount = 0;
    let todayBumpCount = 0;
    let waitingCount = 0;
    let firstStartDate = "";

    for (const ev of evs) {
      if (ev.event === "due_push") {
        rescheduleCount += 1;
        if (typeof ev.meta.deltaDays === "number" && ev.meta.deltaDays > 0) {
          totalPushedDays += ev.meta.deltaDays;
        }
      } else if (ev.event === "snooze_2w") {
        snoozeCount += 1;
      } else if (ev.event === "keep_stale") {
        keepCount += 1;
      } else if (ev.event === "today_pin") {
        todayPinCount += 1;
      } else if (ev.event === "today_bump") {
        todayBumpCount += 1;
      } else if (ev.event === "waiting") {
        waitingCount += 1;
      } else if ((ev.event === "started" || ev.event === "step_done") && ev.date) {
        if (!firstStartDate || ev.date < firstStartDate) firstStartDate = ev.date;
      }
    }

    const daysToStart =
      createdDate && firstStartDate
        ? Math.max(0, daysBetweenKeys(createdDate, firstStartDate) ?? 0)
        : null;

    return {
      hashId,
      kind: item.isProject ? "project" : "task",
      area: cleanAreaName(item.area, "Work"),
      status: item.status || (item.isSomeday ? "someday" : "active"),
      outcome,
      createdDate,
      dueDate,
      closedDate,
      cycleDays,
      ageDays,
      dueSlipDays,
      wasSnoozed: Boolean(item.snoozedUntil) || snoozeCount > 0,
      isRecurring: Boolean(item.recurrence),
      stepCount: steps.length,
      stepsDone,
      rescheduleCount,
      totalPushedDays,
      snoozeCount,
      keepCount,
      todayPinCount,
      todayBumpCount,
      daysToStart,
      waitingCount,
    };
  });

  // Global behavioral aggregates from event stream
  const todayPinDates = new Map();
  let todayPins = 0;
  let todayBumps = 0;
  let todayDoneSameDay = 0;
  let duePushCount = 0;
  let totalPushedDaysAll = 0;
  let snoozeCountAll = 0;
  let keepStaleCount = 0;
  let inboxClarifiedCount = 0;
  const inboxLagValues = [];
  const inboxOutcomes = { task: 0, project: 0, someday: 0, resource: 0, drop: 0 };
  let checkinsCompleted = 0;
  let weeklyReviewsCompleted = 0;
  const doneByWeekday = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };

  for (const ev of dedupedEvents) {
    if (ev.event === "today_pin") {
      todayPins += 1;
      if (ev.hashId && ev.date) {
        if (!todayPinDates.has(ev.hashId)) todayPinDates.set(ev.hashId, new Set());
        todayPinDates.get(ev.hashId).add(ev.date);
      }
    } else if (ev.event === "today_bump") {
      todayBumps += 1;
    } else if (ev.event === "due_push") {
      duePushCount += 1;
      if (typeof ev.meta.deltaDays === "number" && ev.meta.deltaDays > 0) {
        totalPushedDaysAll += ev.meta.deltaDays;
      }
    } else if (ev.event === "snooze_2w") {
      snoozeCountAll += 1;
    } else if (ev.event === "keep_stale") {
      keepStaleCount += 1;
    } else if (ev.event === "inbox_clarify") {
      inboxClarifiedCount += 1;
      if (ev.meta.action && Object.prototype.hasOwnProperty.call(inboxOutcomes, ev.meta.action)) {
        inboxOutcomes[ev.meta.action] += 1;
      }
      if (typeof ev.meta.lagDays === "number") inboxLagValues.push(ev.meta.lagDays);
    } else if (ev.event === "checkin_complete") {
      checkinsCompleted += 1;
    } else if (ev.event === "weekly_review_complete") {
      weeklyReviewsCompleted += 1;
    }
  }

  for (const ev of dedupedEvents) {
    if (ev.event === "done") {
      if (ev.dow && Object.prototype.hasOwnProperty.call(doneByWeekday, ev.dow)) {
        doneByWeekday[ev.dow] += 1;
      }
      const pinnedSameDay = Boolean(ev.hashId && ev.date && todayPinDates.get(ev.hashId)?.has(ev.date));
      if (ev.meta.wasToday || pinnedSameDay) {
        todayDoneSameDay += 1;
      }
    }
  }

  const todayHitRatePct =
    todayPins > 0
      ? Math.min(100, Number(((todayDoneSameDay / todayPins) * 100).toFixed(1)))
      : null;
  const avgInboxLagDays =
    inboxLagValues.length > 0
      ? Number((inboxLagValues.reduce((s, v) => s + v, 0) / inboxLagValues.length).toFixed(1))
      : null;

  const behavior = {
    totalEvents: dedupedEvents.length,
    todayPins,
    todayBumps,
    todayDoneSameDay,
    todayHitRatePct,
    duePushCount,
    totalPushedDays: totalPushedDaysAll,
    snoozeCount: snoozeCountAll,
    keepStaleCount,
    inboxClarifiedCount,
    avgInboxLagDays,
    inboxOutcomes,
    checkinsCompleted,
    weeklyReviewsCompleted,
    doneByWeekday,
  };

  const closedRecords = records.filter((r) => r.outcome !== "open");
  const doneCount = records.filter((r) => r.outcome === "done").length;
  const droppedCount = records.filter((r) => r.outcome === "dropped").length;
  const openCount = records.filter((r) => r.outcome === "open").length;

  const cycleValues = closedRecords.map((r) => r.cycleDays).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const avgCycleDays =
    cycleValues.length > 0
      ? Number((cycleValues.reduce((s, v) => s + v, 0) / cycleValues.length).toFixed(1))
      : null;
  const medianCycleDays =
    cycleValues.length > 0
      ? cycleValues[Math.floor(cycleValues.length / 2)]
      : null;

  const slipValues = closedRecords.map((r) => r.dueSlipDays).filter((v) => typeof v === "number");
  const onTimeOrEarly = slipValues.filter((v) => v <= 0).length;
  const overdueClosed = slipValues.filter((v) => v > 0).length;

  const byArea = {};
  for (const r of records) {
    if (!byArea[r.area]) {
      byArea[r.area] = { total: 0, open: 0, done: 0, dropped: 0, snoozed: 0 };
    }
    byArea[r.area].total += 1;
    byArea[r.area][r.outcome] += 1;
    if (r.wasSnoozed) byArea[r.area].snoozed += 1;
  }

  const summary = {
    generatedDate: todayKey,
    totalItems: records.length,
    openCount,
    doneCount,
    droppedCount,
    completionRatePct:
      doneCount + droppedCount > 0
        ? Number(((doneCount / (doneCount + droppedCount)) * 100).toFixed(1))
        : null,
    avgCycleDays,
    medianCycleDays,
    datedClosedCount: slipValues.length,
    onTimeOrEarly,
    overdueClosed,
    byArea,
    behavior,
  };

  const csvHeaders = [
    "hashId",
    "kind",
    "area",
    "status",
    "outcome",
    "createdDate",
    "dueDate",
    "closedDate",
    "cycleDays",
    "ageDays",
    "dueSlipDays",
    "wasSnoozed",
    "isRecurring",
    "stepCount",
    "stepsDone",
    "rescheduleCount",
    "totalPushedDays",
    "snoozeCount",
    "keepCount",
    "todayPinCount",
    "todayBumpCount",
    "daysToStart",
    "waitingCount",
  ];
  const csvLines = [csvHeaders.join(",")];
  for (const r of records) {
    csvLines.push(csvHeaders.map((k) => csvEscape(r[k])).join(","));
  }
  const csv = csvLines.join("\n") + "\n";

  const weekdayLine = SHORT_WEEKDAYS.map((d) => `${d}: ${doneByWeekday[d]}`).join(" · ");
  const mdLines = [
    `# Anonymized GTD + PARA Trend Audit (${todayKey})`,
    "",
    "> Zero task titles, zero notes, zero person names, and zero tags are included in this report.",
    "",
    "## Summary",
    `- **Total tracked items:** ${summary.totalItems} (${openCount} open, ${doneCount} done, ${droppedCount} dropped)`,
    `- **Completion vs. drop rate:** ${summary.completionRatePct !== null ? `${summary.completionRatePct}%` : "n/a"}`,
    `- **Cycle time (created → closed):** avg ${avgCycleDays ?? "n/a"}d · median ${medianCycleDays ?? "n/a"}d`,
    `- **Deadline accuracy (closed with due date):** ${onTimeOrEarly} on-time/early vs. ${overdueClosed} overdue`,
    "",
    "## Behavioral Patterns (from Event Log)",
    `- **Logged behavioral events:** ${behavior.totalEvents}`,
    `- **Today-3 follow-through:** ${todayDoneSameDay}/${todayPins} (${todayHitRatePct !== null ? `${todayHitRatePct}%` : "n/a"}) · Bumped to Later: ${todayBumps}`,
    `- **Procrastination / Slippage:** ${duePushCount} due-date push(es) (+${totalPushedDaysAll}d total) · ${snoozeCountAll} snooze(s) · ${keepStaleCount} stale keep(s)`,
    `- **Inbox triage:** ${inboxClarifiedCount} clarified (avg lag ${avgInboxLagDays ?? "n/a"}d) — Task: ${inboxOutcomes.task}, Project: ${inboxOutcomes.project}, Someday: ${inboxOutcomes.someday}, Resource: ${inboxOutcomes.resource}, Drop: ${inboxOutcomes.drop}`,
    `- **Review cadence:** ${checkinsCompleted} Morning Check-in(s) · ${weeklyReviewsCompleted} Weekly Review(s)`,
    `- **Completions by weekday:** ${weekdayLine}`,
    "",
    "## Breakdown by PARA Area",
    "| Area | Total | Open | Done | Dropped | Snoozed |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  Object.keys(byArea)
    .sort()
    .forEach((area) => {
      const s = byArea[area];
      mdLines.push(`| ${area} | ${s.total} | ${s.open} | ${s.done} | ${s.dropped} | ${s.snoozed} |`);
    });
  mdLines.push("");

  return {
    generatedAt: today.toISOString(),
    summary,
    behavior,
    events: dedupedEvents,
    records,
    csv,
    markdown: mdLines.join("\n"),
  };
}

module.exports = {
  HORIZON_DAYS,
  MIN_HORIZON_DAYS,
  MAX_HORIZON_DAYS,
  HORIZON_PRESETS,
  DEFAULT_TODAY_CAP,
  FRESH_DAYS,
  STALE_DAYS,
  MILESTONE_SAFE_DAYS,
  CONTROL_TAGS,
  toDateKey,
  parseDateKey,
  normalizeDateValue,
  addDaysKey,
  addMonthsClamped,
  getNextWeekdayKey,
  daysUntil,
  daysBetweenKeys,
  formatDaysLabel,
  formatShortDate,
  parseSimpleRecurrenceKind,
  formatSimpleRecurrenceRule,
  computeSimpleNextDate,
  cleanAreaName,
  parseQuickCapture,
  extractCustomTags,
  getAllCustomTags,
  hashString32,
  resolveAreaRampName,
  getAreaGradientStyle,
  parseHorizonDays,
  getHorizonHeadingText,
  getTimelineWidthPercent,
  getItemProgressRatio,
  getMonthMarkers,
  getTimelineAxis,
  getItemFreshness,
  sortItemsByUrgency,
  getMorningCheckinDeck,
  getWeeklyReviewDeck,
  getWeeklyMomentum,
  tokenizeNotes,
  computeAnonHashId,
  getItemAnonHashId,
  createBehaviorEvent,
  buildAnonymizedAudit,
};
