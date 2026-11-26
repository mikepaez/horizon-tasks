/**
 * plugin.test.js — Automated Test Suite for Horizon LifeOS Obsidian Plugin
 *
 * Tests:
 *   1. Golden lossless Markdown round-trips & surgical line patching (30+ cases)
 *   2. Project body & frontmatter parsing (code fences, nextStep single source of truth)
 *   3. Cross-platform filename sanitizer (Windows reserved names, NFC, collisions)
 *   4. Logic core: multi-Area gradients, Fading Ink (#someday exempt), Weekly Review, Anonymized Audit
 *   5. End-to-end integration of compiled main.js against an in-memory mock `obsidian` API
 *      (optimistic conflict abort, Inbox clarification, Tasks recurrence delegation,
 *       append-only archive, tasks.json import, strict audit privacy check)
 *
 * Run with: node obsidian-plugin/test/plugin.test.js
 */

const assert = require("assert");
const Module = require("module");
const path = require("path");

const logic = require("../src/logic-core.js");
const codec = require("../src/markdown-codec.js");

const fixedToday = new Date(2026, 10, 25); // Nov 25, 2026
const todayKey = "2026-11-25";

// ============================================================================
// 1. Golden Markdown Round-Trips & Surgical Line Patching (32+ lines)
// ============================================================================

const goldenLines = [
  "- [ ] Simple task",
  "* [ ] Asterisk bullet task",
  "+ [ ] Plus bullet task",
  "  - [ ] Indented task",
  "\t- [ ] Tab-indented task",
  "> - [ ] Callout task",
  ">   - [/] Nested quote started task",
  "- [x] Completed task ✅ 2026-11-20",
  "- [X] Uppercase X done task ✅ 2026-11-19",
  "- [-] Dropped task ❌ 2026-11-21",
  "- [?] Question custom checkbox preserved",
  "- [!] Important custom checkbox preserved",
  "- [ ] Task with priority and scheduling ⏫ ⏳ 2026-11-28 🛫 2026-12-01 📅 2026-12-05 ➕ 2026-11-10",
  "- [ ] Complex recurrence 🔁 every 2 weeks on Monday, Thursday 📅 2026-12-07 ➕ 2026-11-01",
  "- [ ] Last Friday recurrence 🔁 every month on the last Friday 📅 2026-11-27",
  "- [ ] Task with [[Project WikiLink]] and #custom/tag #today ^hz-ab12cd",
  "- [ ] Task with external block id ^custom99",
  "- [ ] Task with 🆔 id123 ⛔ id001 🔼 #waiting",
  "- [ ] Task with #someday and URL https://example.com/path?a=1&b=2",
  "- [ ] Call [[Ana (Legal)]] about renewal #context/calls 📅 2026-12-02",
  "- [/] Draft vendor deck ⏫ 📅 2026-11-27 ➕ 2026-11-20 ^hz-98zyx1",
  "- [ ] Buy groceries #errands #personal ^blk-7",
  "- [ ] Track blood pressure 🔁 every week 📅 2026-11-29 ➕ 2026-11-22",
  "- [x] Archived item ✅ 2026-11-18 [Area:: Finance]",
  "- [-] Dropped archived item ❌ 2026-11-15 [Area:: Health]",
  "- [ ] Unicode café résumé naïve task 📅 2026-12-10",
  "- [ ] Inline parens (see note 2) and quotes \"alpha\" 📅 2026-12-01",
  "- [ ] Multiple tags #alpha #beta-1 #next #today",
  "- [ ] Snoozed task 🛫 2026-12-09 📅 2026-12-20 ➕ 2026-11-05",
  "- [ ] Sample flagged task ➕ 2026-11-01 #sample",
  "> > - [ ] Double blockquote task 📅 2026-12-03",
  "- [ ] Trailing spaces preserved in empty patch   ",
];

for (const raw of goldenLines) {
  const parsed = codec.parseTaskLine(raw, 0);
  assert.ok(parsed, `Must parse golden line: ${raw}`);
  assert.strictEqual(
    codec.patchTaskLine(raw, {}, todayKey),
    raw,
    `No-op patchTaskLine must return byte-for-byte identical line: ${raw}`
  );
}

// Verify surgical patch preserves unknown emojis, complex recurrence, WikiLinks, and ^block-ids
const complexLine =
  "> - [ ] Review [[Vendor Contract]] ⏫ ⏳ 2026-11-28 🔁 every 2 weeks 📅 2026-12-05 #legal ^hz-1234";
const snoozed = codec.patchTaskLine(complexLine, { snoozedUntil: "2026-12-01" }, todayKey);
assert.ok(snoozed.startsWith("> - [ ] Review [[Vendor Contract]] ⏫ ⏳ 2026-11-28 🔁 every 2 weeks"));
assert.ok(snoozed.includes("🛫 2026-12-01"));
assert.ok(snoozed.includes("📅 2026-12-05"));
assert.ok(snoozed.includes("#legal"));
assert.ok(snoozed.endsWith("^hz-1234"));

const droppedComplex = codec.patchTaskLine(complexLine, { statusChar: "-", droppedDate: "2026-11-25" }, todayKey);
assert.ok(droppedComplex.startsWith("> - [-] "));
assert.ok(droppedComplex.includes("❌ 2026-11-25"));
assert.ok(droppedComplex.endsWith("^hz-1234"));

// Verify child bullet ◐ / ◷ patching leaves unrelated user child bullets untouched
const blockLines = [
  "- [/] Prepare quarterly deck 📅 2026-12-01 ^hz-p1",
  "\t- ◐ Finish slide 4 chart",
  "\t- Reference link: https://example.com",
];
const blockRes = codec.applyTaskWithChildrenPatch(
  blockLines,
  0,
  { nextStep: "Send to Sarah for feedback" },
  todayKey
);
assert.deepStrictEqual(blockRes.lines, [
  "- [/] Prepare quarterly deck 📅 2026-12-01 ^hz-p1",
  "\t- ◐ Send to Sarah for feedback",
  "\t- Reference link: https://example.com",
]);

// ============================================================================
// 2. Project Body & Frontmatter Parsing (Code fences + Single Source of Truth)
// ============================================================================

const projectMd = [
  "---",
  "type: project",
  "status: active",
  'area: "[[Health]]"',
  "due: 2026-12-20",
  "created: 2026-11-01",
  "---",
  "",
  "# Half Marathon Training",
  "",
  "```markdown",
  "- [ ] Fake checkbox inside code block must be ignored",
  "```",
  "",
  "## Steps",
  "- [x] Buy running shoes ✅ 2026-11-05",
  "- [ ] Run 5k tempo #next",
  "- [ ] Run 10k long run",
].join("\n");

const parsedProj = codec.parseProjectMarkdown(
  projectMd,
  "10_Projects/Half Marathon Training.md",
  { type: "project", status: "active", area: "[[Health]]", due: "2026-12-20", created: "2026-11-01" },
  fixedToday.getTime()
);
assert.strictEqual(parsedProj.area, "Health");
assert.strictEqual(parsedProj.steps.length, 3, "Code block checkbox must be ignored");
assert.strictEqual(parsedProj.nextStep, "Run 5k tempo", "nextStep comes from #next step");
assert.strictEqual(parsedProj.needsNextStep, false);
assert.strictEqual(logic.getItemProgressRatio(parsedProj), 1 / 3);

// ============================================================================
// 3. Cross-Platform Filename Sanitizer
// ============================================================================

assert.strictEqual(codec.sanitizeVaultFileName("CON", "10_Projects"), "Note - CON.md");
assert.strictEqual(codec.sanitizeVaultFileName("nul", "10_Projects"), "Note - nul.md");
assert.strictEqual(codec.sanitizeVaultFileName('Q1: Review / "Alpha"? #1 * [Draft]', "10_Projects"), "Q1 Review Alpha 1 Draft.md");
assert.strictEqual(
  codec.sanitizeVaultFileName("Vendor Proposal", "10_Projects", new Set(["10_projects/vendor proposal.md"])),
  "Vendor Proposal 2.md",
  "Collision check must be case-insensitive for NTFS/APFS/OneDrive"
);

// ============================================================================
// 4. Logic Core: Multi-Area Ramps, Fading Ink, Weekly Review & Anonymized Audit
// ============================================================================

const workStyle = logic.getAreaGradientStyle(5, "Work", 90, false);
const healthStyle = logic.getAreaGradientStyle(5, "Health", 90, false);
const financeStyle = logic.getAreaGradientStyle(5, "Finance", 90, false);
assert.notStrictEqual(workStyle.borderColor, healthStyle.borderColor);
assert.notStrictEqual(healthStyle.borderColor, financeStyle.borderColor);

// Someday and snoozed tasks must never fade
assert.strictEqual(
  logic.getItemFreshness({ status: "someday", isSomeday: true, createdDate: "2026-01-01" }, fixedToday).isStale,
  false
);
assert.strictEqual(
  logic.getItemFreshness({ status: "active", snoozedUntil: "2026-12-01", createdDate: "2026-01-01" }, fixedToday).isStale,
  false
);
// Undated active task untouched 16 days must be stale
assert.strictEqual(
  logic.getItemFreshness({ status: "active", createdDate: "2026-11-09" }, fixedToday).isStale,
  true
);

// ============================================================================
// 5. End-to-End Integration Test of Compiled Bundle (main.js) + Mock Obsidian
// ============================================================================

function createMockObsidianEnvironment() {
  const files = new Map(); // path -> { path, basename, name, stat: { mtime }, content }
  const folders = new Set();
  const notices = [];
  let persistedPluginData = {};

  function normalizePath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  }

  function makeFileObj(p, content = "") {
    const np = normalizePath(p);
    const name = np.split("/").pop();
    const basename = name.replace(/\.md$/i, "");
    return { path: np, name, basename, stat: { mtime: fixedToday.getTime() }, content };
  }

  function parseSimpleYaml(content) {
    const lines = String(content || "").split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return null;
    const end = lines.indexOf("---", 1);
    if (end === -1) return null;
    const fm = {};
    for (let i = 1; i < end; i++) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val === "true") fm[m[1]] = true;
      else if (val === "false") fm[m[1]] = false;
      else fm[m[1]] = val;
    }
    return { fm, end, lines };
  }

  function serializeFrontMatter(fm, bodyLines) {
    const out = ["---"];
    for (const [k, v] of Object.entries(fm)) {
      if (typeof v === "boolean") out.push(`${k}: ${v}`);
      else if (v === undefined || v === null || v === "") out.push(`${k}: ""`);
      else if (/[:[\]#]/.test(String(v))) out.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
      else out.push(`${k}: ${v}`);
    }
    out.push("---", ...bodyLines);
    return out.join("\n");
  }

  const vault = {
    getAbstractFileByPath(p) {
      const np = normalizePath(p);
      if (files.has(np)) return files.get(np);
      if (folders.has(np)) return { path: np, children: [] };
      return null;
    },
    getMarkdownFiles() {
      return Array.from(files.values()).filter((f) => f.path.endsWith(".md"));
    },
    getFiles() {
      return Array.from(files.values());
    },
    getAllLoadedFiles() {
      return [
        ...Array.from(folders).map((p) => ({ path: p })),
        ...Array.from(files.values()),
      ];
    },
    async createFolder(p) {
      folders.add(normalizePath(p));
    },
    async create(p, content) {
      const np = normalizePath(p);
      const parts = np.split("/");
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
      const f = makeFileObj(np, content);
      files.set(np, f);
      return f;
    },
    async cachedRead(f) {
      return files.get(f.path)?.content ?? "";
    },
    async modify(f, content) {
      const target = files.get(f.path);
      if (target) {
        target.content = content;
        target.stat.mtime = Date.now();
      }
    },
    async process(f, fn) {
      const target = files.get(f.path);
      if (!target) throw new Error("Missing file");
      const next = fn(target.content);
      target.content = next;
      target.stat.mtime = Date.now();
      return next;
    },
    async trash(f) {
      files.delete(f.path);
    },
    on() {
      return { id: "vault-ev" };
    },
  };

  const fileManager = {
    async processFrontMatter(f, fn) {
      const target = files.get(f.path);
      const parsed = parseSimpleYaml(target.content);
      const fm = parsed ? { ...parsed.fm } : {};
      const bodyLines = parsed ? parsed.lines.slice(parsed.end + 1) : target.content.split(/\r?\n/);
      fn(fm);
      target.content = serializeFrontMatter(fm, bodyLines);
      target.stat.mtime = Date.now();
    },
    async renameFile(f, newPath) {
      const np = normalizePath(newPath);
      const target = files.get(f.path);
      files.delete(f.path);
      target.path = np;
      target.name = np.split("/").pop();
      target.basename = target.name.replace(/\.md$/i, "");
      files.set(np, target);
    },
  };

  const metadataCache = {
    getFileCache(f) {
      const target = files.get(f.path);
      if (!target) return null;
      const parsed = parseSimpleYaml(target.content);
      return parsed ? { frontmatter: parsed.fm } : {};
    },
    on() {
      return { id: "meta-ev" };
    },
  };

  let tasksApiToggleCalls = 0;
  const app = {
    vault,
    fileManager,
    metadataCache,
    plugins: {
      plugins: {
        "obsidian-tasks-plugin": {
          apiV1: {
            executeToggleTaskDoneCommand(line) {
              tasksApiToggleCalls += 1;
              const completed = line.replace("- [ ]", "- [x]") + " ✅ 2026-11-25";
              const nextOcc = line.replace("📅 2026-11-25", "📅 2026-12-09");
              return `${completed}\n${nextOcc}`;
            },
          },
        },
      },
    },
    workspace: {
      onLayoutReady(fn) {
        fn();
      },
      getActiveViewOfType() {
        return null;
      },
      getLeavesOfType() {
        return [];
      },
      getLeaf() {
        return { async openFile() {} };
      },
      revealLeaf() {},
    },
  };

  class Plugin {
    constructor() {
      this.app = app;
    }
    async loadData() {
      return persistedPluginData;
    }
    async saveData(d) {
      persistedPluginData = JSON.parse(JSON.stringify(d));
    }
    __setExternalData(d) {
      persistedPluginData = JSON.parse(JSON.stringify(d));
    }
    registerView() {}
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
    registerInterval() {}
  }
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.contentEl = {};
    }
  }
  class Modal {
    constructor(a) {
      this.app = a;
      this.contentEl = {};
    }
  }
  class PluginSettingTab {
    constructor(a, p) {
      this.app = a;
      this.plugin = p;
    }
  }
  class MarkdownView {}
  class Notice {
    constructor(msg) {
      notices.push(msg);
    }
  }

  return {
    obsidianMock: { Plugin, ItemView, Modal, PluginSettingTab, MarkdownView, Notice, Platform: { isMobile: false }, normalizePath },
    files,
    notices,
    getTasksToggleCalls: () => tasksApiToggleCalls,
  };
}

async function runBundleIntegrationTests() {
  const env = createMockObsidianEnvironment();
  const origLoad = Module._load;
  const origWindow = global.window;
  global.window = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} };
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return env.obsidianMock;
    return origLoad.apply(this, arguments);
  };

  let PluginClass;
  try {
    const bundlePath = path.resolve(__dirname, "../horizon-lifeos/main.js");
    PluginClass = require(bundlePath);
  } finally {
    Module._load = origLoad;
  }

  try {
    const plugin = new PluginClass();
    await plugin.onload();
    const adapter = plugin.adapter;

    // A. Scaffold PARA vault without samples then test capture + inbox triage
    const scaffoldRes = await adapter.scaffoldParaVault({ includeSamples: false });
    assert.ok(scaffoldRes.createdFiles >= 6);
    assert.ok(env.files.has("20_Areas/Work.md"));
    assert.ok(env.files.has("20_Areas/Finance.md"));

    // B. Per-file capture to 00_Inbox & clarify to Task + Project + Resource
    await adapter.captureNewItem({ mode: "inbox", title: "Secret Client Contract Negotiation" });
    await adapter.captureNewItem({ mode: "inbox", title: "Health Insurance Deductible Reference" });
    let snap = await adapter.scanVault();
    assert.strictEqual(snap.inboxItems.length, 2);

    const contractInbox = snap.inboxItems.find((i) => i.title.includes("Secret Client"));
    const refInbox = snap.inboxItems.find((i) => i.title.includes("Insurance Deductible"));
    await adapter.clarifyInboxItem(contractInbox, { action: "project", area: "Work", dueDate: "2026-12-10", today: true });
    await adapter.clarifyInboxItem(refInbox, { action: "resource" });

    snap = await adapter.scanVault();
    assert.strictEqual(snap.inboxItems.length, 0, "Inbox Zero reached");
    assert.ok(env.files.has("10_Projects/Secret Client Contract Negotiation.md"));
    assert.ok(env.files.has("30_Resources/Health Insurance Deductible Reference.md"));

    // C. Add task to Finance with sensitive title + Waiting On person name
    await adapter.captureNewItem({
      mode: "task",
      title: "Pay Invoice #9988 to Acme Corp",
      area: "Finance",
      dueDate: "2026-11-30",
      waitingOn: "Jonathan Doe",
    });

    // D. Recurring task delegation to obsidian-tasks-plugin apiV1
    await adapter.captureNewItem({
      mode: "task",
      title: "Submit timesheet",
      area: "Work",
      dueDate: "2026-11-25",
    });
    const workFile = env.files.get("20_Areas/Work.md");
    workFile.content = workFile.content.replace("Submit timesheet", "Submit timesheet 🔁 every 2 weeks");
    snap = await adapter.scanVault();
    const recTask = snap.items.find((i) => i.title.includes("Submit timesheet"));
    assert.ok(recTask && recTask.recurrence === "every 2 weeks");
    await adapter.toggleItemDone(recTask);
    assert.strictEqual(env.getTasksToggleCalls(), 1, "Must delegate recurring task completion to Tasks plugin apiV1");
    assert.ok(workFile.content.includes("📅 2026-12-09"), "Tasks plugin spawned occurrence must be written");

    // E. Optimistic line verification abort when file changes behind Horizon's back
    snap = await adapter.scanVault();
    const financeTask = snap.items.find((i) => i.title.includes("Pay Invoice #9988"));
    const finFile = env.files.get("20_Areas/Finance.md");
    finFile.content = finFile.content.replace("Pay Invoice #9988 to Acme Corp", "Edited externally in Markdown");
    const abortedRes = await adapter.mutateTaskBlock(
      financeTask.filePath,
      financeTask.lineNumber,
      financeTask.rawLine,
      financeTask.blockId,
      { linePatch: { statusChar: "x" } },
      todayKey
    );
    assert.strictEqual(abortedRes.aborted, true, "Must abort mutation if line changed externally");
    assert.ok(finFile.content.includes("Edited externally in Markdown"), "External edit must never be overwritten");
    assert.ok(env.notices.some((n) => n.includes("File changed externally")));

    // F. Complete project & archive into 40_Archives/
    const projItem = snap.items.find((i) => i.isProject);
    await adapter.toggleItemDone(projItem);
    const archRes = await adapter.archiveCompletedItems();
    assert.strictEqual(archRes.archivedProjects, 1);
    assert.strictEqual(archRes.archivedTasks, 1);
    assert.ok(env.files.has("40_Archives/Secret Client Contract Negotiation.md"));
    const completedLog = env.files.get("40_Archives/Completed Tasks.md").content;
    assert.ok(completedLog.includes("Submit timesheet"));
    assert.ok(completedLog.includes("[Area:: Work]"));

    // G. Import standalone Horizon tasks.json (dryRun + actual import)
    const sampleStandalone = JSON.stringify({
      schema: 2,
      tasks: [
        {
          id: "t-old-1",
          title: "Confidential Merger Brief",
          area: "work",
          list: "today",
          stage: "started",
          dueDate: "2026-12-04",
          nextStep: "Ask Bob Smith for slides",
          subtasks: [{ id: "s1", title: "Draft outline", done: true, completedAt: "2026-11-24" }],
          createdAt: new Date(2026, 10, 20).getTime(),
        },
        {
          id: "t-old-2",
          title: "Buy vitamins",
          area: "personal",
          list: "done",
          completedAt: "2026-11-24",
          createdAt: new Date(2026, 10, 21).getTime(),
        },
      ],
    });
    const dry = adapter.importStandaloneHorizonJson(sampleStandalone, { dryRun: true });
    assert.strictEqual(dry.projectsCount, 1);
    assert.strictEqual(dry.archivedCount, 1);
    const imp = await adapter.importStandaloneHorizonJson(sampleStandalone, { dryRun: false });
    assert.strictEqual(imp.projectsCount, 1);
    assert.ok(env.files.has("10_Projects/Confidential Merger Brief.md"));

    // H. Anonymized Audit Privacy Assertion (STRICT: zero titles, zero person names, zero notes)
    const auditRes = await adapter.exportAnonymizedAudit();
    assert.ok(auditRes.summary.totalItems >= 4);
    const auditText = [
      env.files.get(auditRes.mdPath).content,
      env.files.get(auditRes.jsonPath).content,
      env.files.get(auditRes.csvPath).content,
    ].join("\n");

    const forbiddenStrings = [
      "Secret Client",
      "Contract Negotiation",
      "Acme Corp",
      "Jonathan Doe",
      "Invoice",
      "Confidential Merger",
      "Bob Smith",
      "Submit timesheet",
      "Buy vitamins",
      "Edited externally",
    ];
    for (const secret of forbiddenStrings) {
      assert.strictEqual(
        auditText.includes(secret),
        false,
        `Anonymized audit MUST NOT leak sensitive text: "${secret}"`
      );
    }
    assert.ok(auditText.includes("hz_"), "Anonymized audit must use irreversible hz_ hash IDs");

    // I. Regression checks from Opus code review:
    // I1. External settings sync (Remotely Save updating data.json) applies disk values over stale local defaults
    plugin.__setExternalData({
      settings: { horizonDays: 180, todayCap: 5 },
      prefs: { laterFilter: "projects" },
      touchedMap: {},
    });
    await plugin.onExternalSettingsChange();
    assert.strictEqual(adapter.getSettings().horizonDays, 180, "Synced horizonDays must override stale local setting");
    assert.strictEqual(adapter.getSettings().todayCap, 5, "Synced todayCap must override stale local setting");
    assert.strictEqual(adapter.getPrefs().laterFilter, "projects");

    // I2. Multi-line Inbox capture note clarified -> Task preserves body in 30_Resources/ and links it without "..."
    await adapter.captureNewItem({
      mode: "inbox",
      title: "Call CPA about quarterly estimated tax deductions for home office equipment before year end\nBring W-2, 1099-NEC, and desk invoice",
    });
    snap = await adapter.scanVault();
    const multiInbox = snap.inboxItems.find((i) => i.title.includes("Call CPA"));
    assert.ok(multiInbox && !multiInbox.title.endsWith("..."), "Inbox note title must not truncate with '...'");
    assert.strictEqual(multiInbox.hasExtraBody, true);
    await adapter.clarifyInboxItem(multiInbox, { action: "task", area: "Finance" });
    assert.ok(
      env.files.get("20_Areas/Finance.md").content.includes("([[Call CPA about quarterly"),
      "Multi-line inbox note must be linked in Finance.md instead of trashed"
    );

    // I3. promoteTaskToProject must validate source BEFORE creating a duplicate project file
    const finSnap = (await adapter.scanVault()).items.find((i) => i.area === "Finance" && !i.isProject && i.title.includes("Call CPA"));
    env.files.get("20_Areas/Finance.md").content = env.files
      .get("20_Areas/Finance.md")
      .content.replace("Call CPA", "Modified Call CPA");
    const abortedProj = await adapter.promoteTaskToProject(finSnap);
    assert.strictEqual(abortedProj, null, "Must abort promotion cleanly when source line changed");
    assert.strictEqual(
      Array.from(env.files.keys()).some((p) => p.startsWith("10_Projects/Call CPA")),
      false,
      "Must NOT leave a duplicate project file on conflict"
    );

    // I4. waiting_on backslashes and quotes must escape safely in Project YAML
    const slashProjFile = await adapter.createProjectFile({
      title: "Access Control Review",
      area: "Work",
      waitingOn: 'DOMAIN\\User "Legal"',
    });
    const slashYaml = env.files.get(slashProjFile.path).content;
    assert.ok(slashYaml.includes('waiting_on: "DOMAIN\\\\User \\"Legal\\""'));

    // J. Behavior Event Log & Rich Anonymized Behavioral Patterns
    // Push a task due date forward twice (+7d each) then mark started, pin to Today, bump, snooze, and complete
    await adapter.captureNewItem({
      mode: "task",
      title: "Sensitive Audit Budget Forecast with CFO Alice",
      area: "Finance",
      dueDate: "2026-11-26",
      today: true,
    });
    let finItems = (await adapter.scanVault()).items.filter((i) => i.title.includes("Sensitive Audit Budget"));
    let budgetTask = finItems[0];
    assert.ok(budgetTask);

    await adapter.updateItemMeta(budgetTask, { dueDate: "2026-12-03" }); // +7d
    budgetTask = (await adapter.scanVault()).items.find((i) => i.id === budgetTask.id);
    await adapter.updateItemMeta(budgetTask, { dueDate: "2026-12-10" }); // +7d (14d total pushed)
    budgetTask = (await adapter.scanVault()).items.find((i) => i.id === budgetTask.id);
    await adapter.updateItemMeta(budgetTask, { today: false, stage: "started", nextStep: "Check Q4 row with Alice" });
    budgetTask = (await adapter.scanVault()).items.find((i) => i.id === budgetTask.id);
    await adapter.updateItemMeta(budgetTask, { snoozedUntil: "2026-12-09" });
    budgetTask = (await adapter.scanVault()).items.find((i) => i.id === budgetTask.id);
    await adapter.toggleItemDone(budgetTask);

    await adapter.recordReviewCompleted("checkin_complete");
    await adapter.recordReviewCompleted("weekly_review_complete");

    const richAudit = await adapter.exportAnonymizedAudit();
    const budgetRec = richAudit.summary.behavior;
    assert.ok(budgetRec.totalEvents >= 10, "Behavior event shards must be written and aggregated");
    assert.ok(budgetRec.duePushCount >= 2 && budgetRec.totalPushedDays >= 14, "Due pushes must accumulate (+14d)");
    assert.ok(budgetRec.todayPins >= 1 && budgetRec.todayBumps >= 1, "Today pin and bump counts must track");
    assert.ok(budgetRec.snoozeCount >= 1, "Snooze count must track");
    assert.ok(budgetRec.inboxClarifiedCount >= 3, "Inbox clarifications must track");
    assert.strictEqual(budgetRec.checkinsCompleted, 1);
    assert.strictEqual(budgetRec.weeklyReviewsCompleted, 1);

    const budgetRow = JSON.parse(env.files.get(richAudit.jsonPath).content).records.find(
      (r) => r.rescheduleCount === 2
    );
    assert.ok(budgetRow, "Per-item row must include rescheduleCount=2");
    assert.strictEqual(budgetRow.totalPushedDays, 14);
    assert.strictEqual(budgetRow.snoozeCount, 1);
    assert.strictEqual(budgetRow.wasSnoozed, true);

    // Strict privacy check across BOTH event shards and exported audit files
    const shardTexts = Array.from(env.files.values())
      .filter((f) => f.path.includes("Exports/Events/events-"))
      .map((f) => f.content);
    assert.ok(shardTexts.length >= 1, "At least one monthly device shard JSONL must exist");
    const combinedAuditAndShards = [
      ...shardTexts,
      env.files.get(richAudit.mdPath).content,
      env.files.get(richAudit.jsonPath).content,
      env.files.get(richAudit.csvPath).content,
    ].join("\n");

    for (const secret of [
      "Sensitive Audit Budget",
      "CFO Alice",
      "Check Q4 row",
      "Access Control Review",
      "DOMAIN",
      "Call CPA",
      "Secret Client",
      "Jonathan Doe",
      "Acme Corp",
    ]) {
      assert.strictEqual(
        combinedAuditAndShards.includes(secret),
        false,
        `Event shards and exports MUST NOT leak sensitive text: "${secret}"`
      );
    }
  } finally {
    global.window = origWindow;
  }
}

runBundleIntegrationTests()
  .then(() => {
    console.log("All Horizon LifeOS Obsidian plugin tests passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
