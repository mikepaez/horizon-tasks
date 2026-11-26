/**
 * markdown-codec.js — Lossless Surgical Markdown Codec
 *
 * Pure parser and single-line patcher for Obsidian Tasks-compatible lines,
 * indented child bullets (◐ next step / ◷ waiting on), Project bodies,
 * Inbox bullets, and cross-platform filename sanitization.
 *
 * Invariant: patchTaskLine(rawLine, {}) === rawLine for every valid line.
 */

const logic = require("./logic-core");

const TASK_LINE_RE = /^((?:\s*>\s*)*\s*[-*+]\s+\[)(.)(\]\s+)(.*)$/;
const PLAIN_BULLET_RE = /^((?:\s*>\s*)*\s*[-*+]\s+)(.*)$/;
const CHILD_NEXT_STEP_RE = /^(\s+[-*+]\s*◐\s*)(.+)$/;
const CHILD_WAITING_RE = /^(\s+[-*+]\s*◷\s*)(.+)$/;
const TRAILING_BLOCK_ID_RE = /\s+(\^[A-Za-z0-9-]+)\s*$/;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function generateBlockId(seed = "") {
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
  const h = logic.hashString32(`${Date.now()}:${seed}:${rand}`).toString(36).slice(0, 6);
  return `hz-${h}`;
}

function extractEmojiDate(text, emoji) {
  const re = new RegExp(`(?:^|\\s)${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})(?=\\s|$)`);
  const m = re.exec(text);
  if (!m) return "";
  return logic.parseDateKey(m[1]) ? m[1] : "";
}

function extractRecurrenceRule(text) {
  const m = /(?:^|\s)🔁\s*([^📅🛫➕✅❌^#\n]+?)(?=\s*(?:[📅🛫➕✅❌⏫🔼🔽⏬⏳]|#|\^|$))/.exec(text);
  return m ? m[1].trim() : "";
}

function extractAreaAnnotation(text) {
  const m = /\[Area::\s*([^\]]+)\]/i.exec(text);
  return m ? logic.cleanAreaName(m[1], "") : "";
}

function hasControlTag(text, tagName) {
  const re = new RegExp(`(?:^|\\s)#${tagName}(?=\\s|$)`, "i");
  return re.test(text);
}

function stripMetadataForTitle(text) {
  return String(text || "")
    .replace(/\s+\^[A-Za-z0-9-]+\s*$/, "")
    .replace(/\[Area::\s*[^\]]+\]/gi, " ")
    .replace(/(?:^|\s)[📅🛫➕✅❌]\s*\d{4}-\d{2}-\d{2}(?=\s|$)/g, " ")
    .replace(/(?:^|\s)🔁\s*[^📅🛫➕✅❌^#\n]+?(?=\s*(?:[📅🛫➕✅❌⏫🔼🔽⏬⏳]|#|\^|$))/g, " ")
    .replace(/(?:^|\s)#(?:today|waiting|someday|next|sample)(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a single Markdown checkbox line into a structured view-model while
 * retaining the verbatim rawLine. Returns null if not a checkbox line.
 */
function parseTaskLine(rawLine, lineNumber = 0) {
  const m = TASK_LINE_RE.exec(rawLine);
  if (!m) return null;

  const statusChar = m[2];
  const rest = m[4];

  let blockId = null;
  const blkMatch = TRAILING_BLOCK_ID_RE.exec(rest);
  if (blkMatch && blkMatch[1].startsWith("^")) {
    blockId = blkMatch[1].slice(1);
  }

  const dueDate = extractEmojiDate(rest, "📅");
  const snoozedUntil = extractEmojiDate(rest, "🛫");
  const createdDate = extractEmojiDate(rest, "➕");
  const completedDate = extractEmojiDate(rest, "✅");
  const droppedDate = extractEmojiDate(rest, "❌");
  const recurrence = extractRecurrenceRule(rest);
  const inlineArea = extractAreaAnnotation(rest);

  const isToday = hasControlTag(rest, "today");
  const isWaitingTag = hasControlTag(rest, "waiting");
  const isSomeday = hasControlTag(rest, "someday");
  const isNext = hasControlTag(rest, "next");
  const isSample = hasControlTag(rest, "sample");

  const done = statusChar === "x" || statusChar === "X";
  const dropped = statusChar === "-";
  const started = statusChar === "/";

  const stage = isWaitingTag ? "waiting" : started ? "started" : "todo";
  const status = done ? "done" : dropped ? "dropped" : isWaitingTag ? "waiting" : isSomeday ? "someday" : "active";

  const title = stripMetadataForTitle(rest);
  const tags = logic.extractCustomTags(rest);

  return {
    lineNumber,
    rawLine,
    statusChar,
    done,
    dropped,
    started,
    stage,
    status,
    isToday,
    isWaitingTag,
    isSomeday,
    isNext,
    isSample,
    dueDate,
    snoozedUntil,
    createdDate,
    completedDate,
    droppedDate,
    recurrence,
    inlineArea,
    blockId,
    title,
    tags,
  };
}

function isBlankPatch(patch) {
  if (!patch || typeof patch !== "object") return true;
  return Object.keys(patch).every((k) => patch[k] === undefined);
}

function removeTokenMatches(body, re) {
  return body.replace(re, " ").replace(/ {2,}/g, " ").trim();
}

function upsertEmojiDate(body, emoji, value) {
  const tokenRe = new RegExp(`(?:^|\\s)${emoji}\\s*\\d{4}-\\d{2}-\\d{2}(?=\\s|$)`, "g");
  if (!value) {
    return removeTokenMatches(body, tokenRe);
  }
  const clean = `${emoji} ${value}`;
  if (tokenRe.test(body)) {
    tokenRe.lastIndex = 0;
    let replaced = false;
    return body
      .replace(tokenRe, (full) => {
        if (replaced) return "";
        replaced = true;
        const lead = /^\s/.test(full) ? " " : "";
        return `${lead}${clean}`;
      })
      .replace(/ {2,}/g, " ")
      .trim();
  }
  return body ? `${body} ${clean}` : clean;
}

function upsertControlTag(body, tagName, enabled) {
  const tagRe = new RegExp(`(?:^|\\s)#${tagName}(?=\\s|$)`, "gi");
  if (!enabled) {
    return removeTokenMatches(body, tagRe);
  }
  if (tagRe.test(body)) return body;
  return body ? `${body} #${tagName}` : `#${tagName}`;
}

function upsertRecurrenceToken(body, rule) {
  const recRe = /(?:^|\s)🔁\s*[^📅🛫➕✅❌^#\n]+?(?=\s*(?:[📅🛫➕✅❌⏫🔼🔽⏬⏳]|#|\^|$))/g;
  if (!rule) {
    return removeTokenMatches(body, recRe);
  }
  const clean = `🔁 ${rule.trim()}`;
  if (recRe.test(body)) {
    recRe.lastIndex = 0;
    let replaced = false;
    return body
      .replace(recRe, (full) => {
        if (replaced) return "";
        replaced = true;
        const lead = /^\s/.test(full) ? " " : "";
        return `${lead}${clean}`;
      })
      .replace(/ {2,}/g, " ")
      .trim();
  }
  return body ? `${body} ${clean}` : clean;
}

/**
 * Surgically patch a single Markdown checkbox line in-place while preserving
 * leading prefix/callout, unknown emojis, custom #tags, and ^block-ids.
 */
function patchTaskLine(rawLine, patch = {}, todayKey = logic.toDateKey(new Date())) {
  if (isBlankPatch(patch)) return rawLine;
  const m = TASK_LINE_RE.exec(rawLine);
  if (!m) return rawLine;

  const prefixOpen = m[1];
  let statusChar = m[2];
  const prefixClose = m[3];
  const rest = m[4];

  let blockSuffix = "";
  let body = rest;
  const blkMatch = TRAILING_BLOCK_ID_RE.exec(rest);
  if (blkMatch) {
    blockSuffix = ` ${blkMatch[1]}`;
    body = rest.slice(0, blkMatch.index);
  }

  let changed = false;

  if (patch.statusChar !== undefined && patch.statusChar !== statusChar) {
    statusChar = patch.statusChar;
    changed = true;
  }

  if (patch.title !== undefined && typeof patch.title === "string") {
    const cleanNewTitle = patch.title.trim();
    const oldCleanTitle = stripMetadataForTitle(body);
    if (cleanNewTitle && cleanNewTitle !== oldCleanTitle) {
      // Preserve existing structured metadata tokens after the description
      const preserved = [];
      const rec = extractRecurrenceRule(body);
      if (rec) preserved.push(`🔁 ${rec}`);
      const snooze = extractEmojiDate(body, "🛫");
      if (snooze) preserved.push(`🛫 ${snooze}`);
      const due = extractEmojiDate(body, "📅");
      if (due) preserved.push(`📅 ${due}`);
      const created = extractEmojiDate(body, "➕");
      if (created) preserved.push(`➕ ${created}`);
      const comp = extractEmojiDate(body, "✅");
      if (comp) preserved.push(`✅ ${comp}`);
      const drop = extractEmojiDate(body, "❌");
      if (drop) preserved.push(`❌ ${drop}`);
      for (const ct of ["today", "waiting", "someday", "next", "sample"]) {
        if (hasControlTag(body, ct)) preserved.push(`#${ct}`);
      }
      body = [cleanNewTitle, ...preserved].join(" ").trim();
      changed = true;
    }
  }

  if (patch.recurrence !== undefined) {
    const nextBody = upsertRecurrenceToken(body, patch.recurrence);
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }
  if (patch.snoozedUntil !== undefined) {
    const val = logic.normalizeDateValue(patch.snoozedUntil);
    const nextBody = upsertEmojiDate(body, "🛫", val);
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }
  if (patch.dueDate !== undefined) {
    const val = logic.normalizeDateValue(patch.dueDate);
    const nextBody = upsertEmojiDate(body, "📅", val);
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }
  if (patch.createdDate !== undefined) {
    const val = logic.normalizeDateValue(patch.createdDate);
    const nextBody = upsertEmojiDate(body, "➕", val);
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }
  if (patch.completedDate !== undefined) {
    const val = logic.normalizeDateValue(patch.completedDate);
    const nextBody = upsertEmojiDate(body, "✅", val);
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }
  if (patch.droppedDate !== undefined) {
    const val = logic.normalizeDateValue(patch.droppedDate);
    const nextBody = upsertEmojiDate(body, "❌", val);
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }

  for (const [prop, tag] of [
    ["today", "today"],
    ["waiting", "waiting"],
    ["someday", "someday"],
    ["next", "next"],
    ["sample", "sample"],
  ]) {
    if (patch[prop] !== undefined) {
      const nextBody = upsertControlTag(body, tag, Boolean(patch[prop]));
      if (nextBody !== body) {
        body = nextBody;
        changed = true;
      }
    }
  }

  if (patch.areaAnnotation !== undefined) {
    const cleaned = body.replace(/\s*\[Area::\s*[^\]]+\]/gi, "").replace(/ {2,}/g, " ").trim();
    const nextBody = patch.areaAnnotation ? `${cleaned} [Area:: ${patch.areaAnnotation}]` : cleaned;
    if (nextBody !== body) {
      body = nextBody;
      changed = true;
    }
  }

  if (patch.ensureBlockId && !blockSuffix) {
    const idVal = typeof patch.ensureBlockId === "string" ? patch.ensureBlockId : generateBlockId(body + todayKey);
    blockSuffix = ` ^${idVal.replace(/^\^/, "")}`;
    changed = true;
  }

  if (!changed) return rawLine;
  return `${prefixOpen}${statusChar}${prefixClose}${body}${blockSuffix}`;
}

/**
 * Inspect indented child bullets right beneath parentIndex for ◐ (next step) and ◷ (waiting on).
 */
function parseChildMetadataLines(lines, parentIndex) {
  const parentLine = lines[parentIndex] || "";
  const parentIndentMatch = /^((?:\s*>\s*)*\s*)/.exec(parentLine);
  const parentIndentLen = parentIndentMatch ? parentIndentMatch[1].length : 0;

  let endIndex = parentIndex;
  let nextStep = "";
  let waitingOn = "";
  const rawChildren = [];

  for (let i = parentIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const indentMatch = /^((?:\s*>\s*)*\s*)/.exec(line);
    const indentLen = indentMatch ? indentMatch[1].length : 0;
    if (indentLen <= parentIndentLen) break;
    endIndex = i;
    rawChildren.push(line);

    const nm = CHILD_NEXT_STEP_RE.exec(line);
    if (nm && !nextStep) nextStep = nm[2].trim();
    const wm = CHILD_WAITING_RE.exec(line);
    if (wm && !waitingOn) waitingOn = wm[2].trim();
  }

  return { endIndex, nextStep, waitingOn, rawChildren };
}

/**
 * Update a task line and its ◐ / ◷ child bullets inside an array of file lines.
 * Preserves all non-metadata child bullets beneath the task.
 */
function applyTaskWithChildrenPatch(lines, parentIndex, { linePatch = {}, nextStep, waitingOn }, todayKey) {
  const parentLine = lines[parentIndex];
  const indentMatch = /^((?:\s*>\s*)*)(\s*)/.exec(parentLine);
  const quotePrefix = indentMatch ? indentMatch[1] : "";
  const baseIndent = indentMatch ? indentMatch[2] : "";
  const childPrefix = `${quotePrefix}${baseIndent}\t- `;

  const { endIndex } = parseChildMetadataLines(lines, parentIndex);
  const existingChildren = lines.slice(parentIndex + 1, endIndex + 1);

  const patchedParent = patchTaskLine(parentLine, linePatch, todayKey);
  const keptChildren = [];

  for (const child of existingChildren) {
    const isNextLine = CHILD_NEXT_STEP_RE.test(child);
    const isWaitLine = CHILD_WAITING_RE.test(child);
    if (isNextLine && nextStep !== undefined) continue;
    if (isWaitLine && waitingOn !== undefined) continue;
    keptChildren.push(child);
  }

  const inserted = [];
  if (waitingOn !== undefined) {
    const cleanW = String(waitingOn || "").trim();
    if (cleanW) inserted.push(`${childPrefix}◷ ${cleanW}`);
  }
  if (nextStep !== undefined) {
    const cleanN = String(nextStep || "").trim();
    if (cleanN) inserted.push(`${childPrefix}◐ ${cleanN}`);
  }

  const nextChildren = [...inserted, ...keptChildren];
  const updated = [
    ...lines.slice(0, parentIndex),
    patchedParent,
    ...nextChildren,
    ...lines.slice(endIndex + 1),
  ];

  return { lines: updated, patchedParent, nextChildren };
}

function getFrontmatterEndIndex(lines) {
  if (!lines.length || lines[0].trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") {
      return i;
    }
  }
  return -1;
}

/**
 * Scan a Markdown file body skipping YAML frontmatter and fenced code blocks.
 * Yields { lineNumber, rawLine, task, plainBullet } for each candidate line.
 */
function scanMarkdownBodyLines(content) {
  const lines = String(content || "").split(/\r?\n/);
  const fmEnd = getFrontmatterEndIndex(lines);
  let inFence = false;
  let fenceChar = "";
  const results = [];

  for (let i = fmEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;

    const task = parseTaskLine(line, i);
    if (task) {
      results.push({ lineNumber: i, rawLine: line, task, plainBullet: null });
      continue;
    }
    const pm = PLAIN_BULLET_RE.exec(line);
    if (pm && !/^\s+/.test(line)) {
      results.push({ lineNumber: i, rawLine: line, task: null, plainBullet: pm[2].trim() });
    }
  }

  return { lines, fmEnd, entries: results };
}

/**
 * Parse a 10_Projects/*.md file into a unified multi-step Project item.
 * Never truncates steps; derives nextStep strictly from checkboxes:
 *   1st open #next step -> else 1st [/] started step -> else 1st [ ] open step.
 */
function parseProjectMarkdown(content, filePath, frontmatter = {}, fileMtime = Date.now()) {
  const fm = frontmatter && typeof frontmatter === "object" ? frontmatter : {};
  const { lines, fmEnd, entries } = scanMarkdownBodyLines(content);

  const rawStatus = typeof fm.status === "string" ? fm.status.trim().toLowerCase() : "active";
  const status = ["active", "waiting", "someday", "done", "dropped"].includes(rawStatus)
    ? rawStatus
    : "active";

  const baseName = filePath.split("/").pop().replace(/\.md$/i, "");
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : baseName;
  const area = logic.cleanAreaName(typeof fm.area === "string" ? fm.area : "", "Work");
  const dueDate = logic.normalizeDateValue(fm.due);
  const snoozedUntil = logic.normalizeDateValue(fm.snoozed_until);
  const createdDate = logic.normalizeDateValue(fm.created);
  const closedVal = logic.normalizeDateValue(fm.closed || fm.completed);
  const completedDate = status === "done" ? closedVal : "";
  const droppedDate = status === "dropped" ? closedVal : "";
  const waitingOn = typeof fm.waiting_on === "string" ? fm.waiting_on.trim() : "";
  const isToday = Boolean(fm.today) && status !== "waiting" && status !== "done" && status !== "dropped" && status !== "someday";
  const isSample = Boolean(fm.sample);

  const steps = entries
    .filter((e) => e.task)
    .map((e, idx) => ({
      id: e.task.blockId || `step-${e.lineNumber}-${idx}`,
      lineNumber: e.lineNumber,
      rawLine: e.rawLine,
      title: e.task.title,
      statusChar: e.task.statusChar,
      done: e.task.done,
      started: e.task.started,
      dropped: e.task.dropped,
      completedDate: e.task.completedDate,
      isNext: e.task.isNext,
      blockId: e.task.blockId,
    }));

  const openSteps = steps.filter((s) => !s.done && !s.dropped);
  const nextCandidate =
    openSteps.find((s) => s.isNext) ||
    openSteps.find((s) => s.started) ||
    openSteps[0] ||
    null;

  const nextStep = nextCandidate ? nextCandidate.title : "";
  const needsNextStep = status === "active" && openSteps.length === 0;
  const stage =
    status === "waiting"
      ? "waiting"
      : openSteps.some((s) => s.started) || steps.some((s) => s.done)
      ? "started"
      : "todo";

  const bodyLines = lines.slice(fmEnd + 1);
  const proseLines = bodyLines.filter((l) => !TASK_LINE_RE.test(l) && l.trim() && !l.trim().startsWith("#"));
  const notesPreview = proseLines.slice(0, 6).join("\n").trim();

  const tags = Array.isArray(fm.tags)
    ? fm.tags.map((t) => String(t).replace(/^#/, "").toLowerCase()).filter((t) => t && !logic.CONTROL_TAGS.has(t))
    : typeof fm.tags === "string"
    ? fm.tags
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, "").toLowerCase())
        .filter((t) => t && !logic.CONTROL_TAGS.has(t))
    : [];

  return {
    id: `proj:${filePath}`,
    kind: "project",
    isProject: true,
    filePath,
    lineNumber: null,
    rawLine: null,
    rawChildren: [],
    blockId: null,
    title,
    area,
    status,
    list: status === "done" || status === "dropped" ? "done" : isToday ? "today" : "later",
    stage,
    isToday,
    isSomeday: status === "someday",
    dueDate,
    snoozedUntil,
    createdDate,
    completedDate,
    droppedDate,
    recurrence: "",
    nextStep,
    waitingOn,
    steps,
    needsNextStep,
    tags,
    notesPreview,
    touchedAt: Number(fileMtime) || Date.now(),
    fileMtime: Number(fileMtime) || Date.now(),
    isSample,
  };
}

/**
 * Parse a standalone Area Markdown file (e.g. 20_Areas/Work.md) into task view-models.
 * Top-level (non-indented or quote-level) task lines become tasks; indented child bullets
 * feed ◐ nextStep and ◷ waitingOn without flattening child bullets into separate tasks.
 */
function parseAreaTasksMarkdown(content, filePath, defaultArea, fileMtime = Date.now()) {
  const { lines, entries } = scanMarkdownBodyLines(content);
  const items = [];
  const occCounts = new Map();

  for (const entry of entries) {
    if (!entry.task) continue;
    // Skip indented child lines (sub-bullets inside another task)
    const indentCheck = /^(?:\s*>\s*)*(\s*)/.exec(entry.rawLine);
    if (indentCheck && indentCheck[1].length > 0) continue;

    const t = entry.task;
    const { nextStep, waitingOn, rawChildren } = parseChildMetadataLines(lines, entry.lineNumber);
    const effectiveArea = t.inlineArea || logic.cleanAreaName(defaultArea, "Work");
    const hasWaiting = t.isWaitingTag || Boolean(waitingOn);
    const effectiveStage = hasWaiting ? "waiting" : t.started || Boolean(nextStep) ? "started" : "todo";
    const status = t.done ? "done" : t.dropped ? "dropped" : hasWaiting ? "waiting" : t.isSomeday ? "someday" : "active";
    const isToday = Boolean(t.isToday && status !== "done" && status !== "dropped" && status !== "waiting" && !t.isSomeday);

    const descKey = `${filePath}|${t.title.toLowerCase()}`;
    const occ = (occCounts.get(descKey) || 0) + 1;
    occCounts.set(descKey, occ);
    const stableId = t.blockId
      ? `blk:${t.blockId}`
      : `task:${logic.hashString32(descKey).toString(36)}:${occ}`;

    items.push({
      id: stableId,
      kind: "task",
      isProject: false,
      filePath,
      lineNumber: entry.lineNumber,
      rawLine: entry.rawLine,
      rawChildren,
      blockId: t.blockId,
      title: t.title || "(untitled)",
      area: effectiveArea,
      status,
      list: status === "done" || status === "dropped" ? "done" : isToday ? "today" : "later",
      stage: effectiveStage,
      isToday,
      isSomeday: t.isSomeday,
      dueDate: t.dueDate,
      snoozedUntil: t.snoozedUntil,
      createdDate: t.createdDate,
      completedDate: t.completedDate,
      droppedDate: t.droppedDate,
      recurrence: t.recurrence,
      nextStep,
      waitingOn,
      steps: [],
      needsNextStep: false,
      tags: t.tags,
      notesPreview: "",
      touchedAt: 0,
      fileMtime: Number(fileMtime) || Date.now(),
      isSample: t.isSample,
    });
  }

  return items;
}

/**
 * Parse 00_Inbox/*.md files into Inbox capture entries.
 * - Multi-line notes like "Quick Inbox.md" emit one inbox-line entry per bullet/task.
 * - Dedicated capture notes (e.g., "Capture 20261125-2100.md") emit one inbox-note entry.
 */
function parseInboxMarkdown(content, filePath, frontmatter = {}, fileMtime = Date.now()) {
  const baseName = filePath.split("/").pop().replace(/\.md$/i, "");
  const isQuickInbox = /^quick inbox$/i.test(baseName);
  const { lines, fmEnd, entries } = scanMarkdownBodyLines(content);
  const fm = frontmatter && typeof frontmatter === "object" ? frontmatter : {};
  const fallbackCreated =
    logic.normalizeDateValue(fm.created) || logic.toDateKey(new Date(Number(fileMtime) || Date.now()));

  if (isQuickInbox) {
    const items = [];
    for (const entry of entries) {
      if (entry.task) {
        if (entry.task.done || entry.task.dropped) continue;
        const indentCheck = /^(?:\s*>\s*)*(\s*)/.exec(entry.rawLine);
        if (indentCheck && indentCheck[1].length > 0) continue;
        items.push({
          id: `inbox-line:${filePath}:${entry.lineNumber}:${logic.hashString32(entry.rawLine).toString(36)}`,
          kind: "inbox-line",
          filePath,
          lineNumber: entry.lineNumber,
          rawLine: entry.rawLine,
          title: entry.task.title || "(empty item)",
          body: "",
          createdDate: entry.task.createdDate || fallbackCreated,
          fileMtime,
          suggestedArea: null,
          isSample: entry.task.isSample,
        });
      } else if (entry.plainBullet) {
        const cleanTitle = stripMetadataForTitle(entry.plainBullet);
        if (!cleanTitle) continue;
        items.push({
          id: `inbox-line:${filePath}:${entry.lineNumber}:${logic.hashString32(entry.rawLine).toString(36)}`,
          kind: "inbox-line",
          filePath,
          lineNumber: entry.lineNumber,
          rawLine: entry.rawLine,
          title: cleanTitle,
          body: "",
          createdDate: fallbackCreated,
          fileMtime,
          suggestedArea: null,
          isSample: hasControlTag(entry.plainBullet, "sample"),
        });
      }
    }
    return items;
  }

  const bodyLines = lines.slice(fmEnd + 1);
  const body = bodyLines.join("\n").trim();
  const nonEmptyLines = bodyLines
    .map((l) => l.replace(/^[-*+]\s+\[[ xX/-]\]\s+/, "").replace(/^[-*+#>\s]+/, "").trim())
    .filter(Boolean);
  const firstMeaningful = nonEmptyLines[0] || "";

  let title = baseName;
  if (/^capture[\s_-]+\d+/i.test(baseName) && firstMeaningful) {
    title = firstMeaningful;
  }
  const hasExtraBody = nonEmptyLines.length > 1;

  if (!body && /^capture/i.test(baseName)) return [];

  return [
    {
      id: `inbox-note:${filePath}`,
      kind: "inbox-note",
      filePath,
      lineNumber: null,
      rawLine: null,
      title,
      body,
      hasExtraBody,
      createdDate: fallbackCreated,
      fileMtime,
      suggestedArea: fm.area ? logic.cleanAreaName(fm.area, "") : null,
      isSample: Boolean(fm.sample) || hasControlTag(body, "sample"),
    },
  ];
}

/**
 * Sanitize a project or resource title into a safe Windows + iOS + OneDrive filename.
 * Resolves collisions case-insensitively against existingLowerPathsSet.
 */
function sanitizeVaultFileName(rawTitle, folderPrefix = "", existingLowerPathsSet = new Set()) {
  let clean = String(rawTitle || "Untitled")
    .normalize("NFC")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|#^\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[._\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();

  if (!clean) clean = "Untitled";

  if (RESERVED_WINDOWS_NAMES.has(clean.toUpperCase())) {
    clean = `Note - ${clean}`;
  }

  if (clean.length > 80) {
    clean = clean.slice(0, 80).replace(/[.\s]+$/, "").trim() || "Untitled";
  }

  const prefix = folderPrefix ? `${folderPrefix.replace(/\/+$/, "")}/` : "";
  const lowerExisting = new Set(Array.from(existingLowerPathsSet || []).map((p) => String(p).toLowerCase()));

  let candidate = clean;
  let suffix = 2;
  while (lowerExisting.has(`${prefix}${candidate}.md`.toLowerCase())) {
    const tail = ` ${suffix}`;
    const stem = clean.length + tail.length > 80 ? clean.slice(0, 80 - tail.length).trim() : clean;
    candidate = `${stem}${tail}`;
    suffix += 1;
  }

  return `${candidate}.md`;
}

module.exports = {
  TASK_LINE_RE,
  PLAIN_BULLET_RE,
  CHILD_NEXT_STEP_RE,
  CHILD_WAITING_RE,
  generateBlockId,
  stripMetadataForTitle,
  parseTaskLine,
  patchTaskLine,
  parseChildMetadataLines,
  applyTaskWithChildrenPatch,
  getFrontmatterEndIndex,
  scanMarkdownBodyLines,
  parseProjectMarkdown,
  parseAreaTasksMarkdown,
  parseInboxMarkdown,
  sanitizeVaultFileName,
};
