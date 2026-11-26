/**
 * horizon-view.js — Scoped Obsidian ItemView for Horizon LifeOS (GTD + PARA)
 *
 * Completely scoped to this.contentEl (uses contentEl.ownerDocument for popout safety).
 * Defers incoming background sync re-renders while a user is typing in any Horizon input.
 */

const obsidian = require("obsidian");
const logic = require("./logic-core");

const VIEW_TYPE_HORIZON = "horizon-lifeos-view";

class HorizonItemView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.adapter = plugin.adapter;

    this.items = [];
    this.inboxItems = [];
    this.archivedItems = [];
    this.areas = ["Work", "Personal", "Health", "Finance"];
    this.vaultReady = true;

    this.searchVisible = false;
    this.searchQuery = "";
    this.activeTag = null;
    this.captureMode = "task"; // "task" | "inbox" | "project"
    this.captureArea = this.adapter.getSettings().lastUsedArea || "Work";
    this.inboxClarifyArea = this.adapter.getSettings().lastUsedArea || "Work";
    this.inboxClarifyToday = false;

    this.checkinMode = "auto"; // "auto" | "cards" | "weekly" | "hidden"
    this.checkinCards = [];
    this.checkinIndex = 0;

    this.inspectedItemId = null;
    this.expandedItemId = null;
    this.editingTitleId = null;
    this.editingStage = null; // { id, mode: "started"|"waiting", prompt?, draft?, endDayChain? }
    this.pendingSwap = null; // { kind: "add"|"move", ... }
    this.confirmingArchive = false;
    this.showAllDone = false;
    this.showAllTimeline = false;

    this.undoInfo = null;
    this.undoTimer = null;
    this.toastMessage = "";

    this.deferredRefresh = false;
    this.pendingFocus = null; // { itemId, key }
    this.lastRenderedDateKey = logic.toDateKey(new Date());
    this.horizonDays = logic.parseHorizonDays(this.adapter.getSettings().horizonDays, 90);
    this.horizonMenuOpen = false;
    this.actionBusy = false;
  }

  getViewType() {
    return VIEW_TYPE_HORIZON;
  }

  getDisplayText() {
    return "Horizon";
  }

  getIcon() {
    return "calendar-range";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("horizon-lifeos-root");
    this.contentEl.setAttribute("tabindex", "-1");

    this.scrollEl = this.contentEl.createDiv({ cls: "hz-scroll" });
    this.shellEl = this.scrollEl.createDiv({ cls: "hz-shell" });
    this.toastEl = this.contentEl.createDiv({ cls: "hz-toast hz-hidden" });

    this.registerDomEvent(this.contentEl, "focusout", () => {
      const doc = this.contentEl.ownerDocument;
      window.setTimeout(() => {
        if (this.deferredRefresh && !this.isTextControlFocused(doc)) {
          this.deferredRefresh = false;
          this.reloadAndRender();
        }
      }, 30);
    });

    this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleScopedKeydown(e));

    await this.reloadAndRender();
  }

  async onClose() {
    if (this.undoTimer) {
      window.clearTimeout(this.undoTimer);
      this.undoTimer = null;
    }
    this.contentEl.empty();
  }

  isTextControlFocused(doc) {
    const active = doc?.activeElement;
    if (!active || !this.contentEl.contains(active)) return false;
    const tag = active.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(active.type)) {
      return true;
    }
    return false;
  }

  isDarkTheme() {
    const doc = this.contentEl.ownerDocument;
    return Boolean(doc?.body?.classList?.contains("theme-dark"));
  }

  async handleExternalRefresh(opts = {}) {
    const todayKey = logic.toDateKey(new Date());
    if (opts.dateCheckOnly) {
      if (todayKey === this.lastRenderedDateKey) return;
      if (this.checkinMode === "hidden") this.checkinMode = "auto";
    }
    if (this.isTextControlFocused(this.contentEl.ownerDocument)) {
      this.deferredRefresh = true;
      return;
    }
    await this.reloadAndRender();
  }

  async reloadAndRender() {
    const snapshot = await this.adapter.scanVault();
    this.items = snapshot.items;
    this.inboxItems = snapshot.inboxItems;
    this.archivedItems = snapshot.archivedItems;
    this.areas = snapshot.areas;
    this.vaultReady = snapshot.vaultReady;

    if (!this.areas.some((a) => a.toLowerCase() === this.captureArea.toLowerCase())) {
      this.captureArea = this.areas[0] || "Work";
    }
    if (!this.areas.some((a) => a.toLowerCase() === this.inboxClarifyArea.toLowerCase())) {
      this.inboxClarifyArea = this.areas[0] || "Work";
    }
    if (!this.horizonMenuOpen) {
      this.horizonDays = logic.parseHorizonDays(this.adapter.getSettings().horizonDays, 90);
    }

    this.lastRenderedDateKey = logic.toDateKey(new Date());
    this.renderAll();
  }

  async runAction(fn, triggerEl = null) {
    if (this.actionBusy) return null;
    this.actionBusy = true;
    if (triggerEl) triggerEl.disabled = true;
    try {
      return await fn();
    } catch (err) {
      new obsidian.Notice(String(err?.message || err || "Action failed"));
      await this.reloadAndRender();
      return null;
    } finally {
      this.actionBusy = false;
      if (triggerEl && triggerEl.isConnected) triggerEl.disabled = false;
    }
  }

  showScopedToast(message, undoInfo = null) {
    if (this.undoTimer) window.clearTimeout(this.undoTimer);
    this.toastMessage = message || "";
    this.undoInfo = undoInfo || null;
    this.renderToast();

    this.undoTimer = window.setTimeout(() => {
      this.toastMessage = "";
      this.undoInfo = null;
      this.renderToast();
    }, 5500);
  }

  async performUndo() {
    if (!this.undoInfo) return;
    const info = this.undoInfo;
    if (this.undoTimer) window.clearTimeout(this.undoTimer);
    this.undoInfo = null;
    this.toastMessage = "";
    this.renderToast();

    const res = await this.adapter.applyInverseLineUndo(info);
    if (!res.aborted) {
      await this.reloadAndRender();
      new obsidian.Notice("Reverted last change");
    }
  }

  renderToast() {
    if (!this.toastEl) return;
    this.toastEl.empty();
    if (!this.toastMessage) {
      this.toastEl.addClass("hz-hidden");
      return;
    }
    this.toastEl.removeClass("hz-hidden");
    this.toastEl.createSpan({ text: this.toastMessage });
    if (this.undoInfo) {
      const undoBtn = this.toastEl.createEl("button", { text: "Undo", cls: "hz-toast-btn", type: "button" });
      undoBtn.addEventListener("click", () => this.performUndo());
    }
    const closeBtn = this.toastEl.createEl("button", { text: "×", cls: "hz-toast-close", type: "button" });
    closeBtn.addEventListener("click", () => {
      this.toastMessage = "";
      this.undoInfo = null;
      this.renderToast();
    });
  }

  handleScopedKeydown(e) {
    const doc = this.contentEl.ownerDocument;
    if (!this.contentEl.contains(doc.activeElement) && doc.activeElement !== this.contentEl) return;
    if (e.key === "Escape" && this.horizonMenuOpen) {
      this.horizonMenuOpen = false;
      this.renderAll();
      return;
    }
    const inText = this.isTextControlFocused(doc);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inText && this.undoInfo) {
      e.preventDefault();
      this.performUndo();
      return;
    }
    if (inText || e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if (key === "n") {
      e.preventDefault();
      const input = this.shellEl.querySelector(".hz-capture-input");
      if (input) input.focus();
    } else if (e.key === "/") {
      e.preventDefault();
      this.searchVisible = true;
      this.renderAll();
      const searchInput = this.shellEl.querySelector(".hz-search-input");
      if (searchInput) searchInput.focus();
    } else if (key === "s") {
      const rowEl = doc.activeElement?.closest?.("[data-item-id]");
      const itemId = rowEl?.dataset?.itemId;
      const item = itemId ? this.items.find((it) => it.id === itemId && it.list !== "done") : null;
      if (item) {
        e.preventDefault();
        this.editingStage = { id: item.id, mode: "started" };
        this.pendingFocus = { itemId: item.id, key: "stage-input" };
        if (item.stage !== "started" && !item.isProject) {
          this.adapter.updateItemMeta(item, { stage: "started" }).then(() => this.reloadAndRender());
        } else {
          this.renderAll();
        }
      }
    } else if (key === "e") {
      const rowEl = doc.activeElement?.closest?.("[data-item-id]");
      const itemId = rowEl?.dataset?.itemId;
      const item = itemId ? this.items.find((it) => it.id === itemId) : null;
      if (item) {
        e.preventDefault();
        this.expandedItemId = this.expandedItemId === item.id ? null : item.id;
        this.renderAll();
      }
    }
  }

  getFilteredItems() {
    const selectedArea = this.adapter.getPrefs().selectedArea || "all";
    const q = this.searchQuery.trim().toLowerCase();
    return this.items.filter((item) => {
      if (selectedArea !== "all" && item.area.toLowerCase() !== selectedArea.toLowerCase()) {
        return false;
      }
      if (this.activeTag && !(item.tags || []).includes(this.activeTag)) {
        return false;
      }
      if (!q) return true;
      const inSteps =
        Array.isArray(item.steps) && item.steps.some((s) => (s.title || "").toLowerCase().includes(q));
      return (
        (item.title || "").toLowerCase().includes(q) ||
        (item.nextStep || "").toLowerCase().includes(q) ||
        (item.waitingOn || "").toLowerCase().includes(q) ||
        (item.area || "").toLowerCase().includes(q) ||
        (item.notesPreview || "").toLowerCase().includes(q) ||
        inSteps
      );
    });
  }

  getTodayCap() {
    return Math.max(1, Number(this.adapter.getSettings().todayCap) || logic.DEFAULT_TODAY_CAP);
  }

  getTodayItems(list = this.items) {
    return list.filter((it) => it.list === "today");
  }

  async moveItemToToday(item, { forceToday = false } = {}) {
    const todayCap = this.getTodayCap();
    const currentToday = this.getTodayItems();
    if (!forceToday && !item.isToday && currentToday.length >= todayCap) {
      this.pendingSwap = { kind: "move", itemId: item.id };
      this.renderAll();
      return false;
    }
    const res = await this.adapter.updateItemMeta(item, { today: true, someday: false });
    this.pendingSwap = null;
    await this.reloadAndRender();
    if (res?.undoInfo) this.showScopedToast(`Added "${item.title}" to Today`, res.undoInfo);
    return true;
  }

  async moveItemToLater(item) {
    const promptNext = item.stage === "started" && !item.nextStep && !item.isProject;
    const res = await this.adapter.updateItemMeta(item, { today: false });
    if (promptNext) {
      this.editingStage = { id: item.id, mode: "started", prompt: "Where did you leave this?" };
      this.pendingFocus = { itemId: item.id, key: "stage-input" };
    }
    await this.reloadAndRender();
    if (res?.undoInfo) this.showScopedToast(`Moved "${item.title}" to Later`, res.undoInfo);
  }

  async executeSwap(swapOutId) {
    if (!this.pendingSwap) return;
    const info = this.pendingSwap;
    this.pendingSwap = null;

    const outItem = this.items.find((it) => it.id === swapOutId);
    if (outItem) {
      await this.adapter.updateItemMeta(outItem, { today: false });
      if (outItem.stage === "started" && !outItem.nextStep && !outItem.isProject) {
        this.editingStage = { id: outItem.id, mode: "started", prompt: "Where did you leave this?" };
        this.pendingFocus = { itemId: outItem.id, key: "stage-input" };
      }
    }

    if (info.kind === "add") {
      await this.adapter.captureNewItem({
        mode: info.mode,
        title: info.title,
        area: info.area,
        dueDate: info.dueDate,
        today: true,
        someday: info.someday,
      });
    } else if (info.kind === "move") {
      const inItem = this.items.find((it) => it.id === info.itemId);
      if (inItem) await this.adapter.updateItemMeta(inItem, { today: true, someday: false });
    }
    await this.reloadAndRender();
  }

  startCheckinCards() {
    const deck = logic.getMorningCheckinDeck(this.items, this.inboxItems, new Date());
    if (deck.cards.length === 0) {
      new obsidian.Notice("All clear — nothing pending for Morning Check-in.");
      return;
    }
    this.checkinCards = deck.cards;
    this.checkinIndex = 0;
    this.checkinMode = "cards";
    this.renderAll();
  }

  startWeeklyReviewCards() {
    const deck = logic.getWeeklyReviewDeck(this.items, this.inboxItems, new Date());
    if (deck.cards.length === 0) {
      new obsidian.Notice("Weekly Review is already clean!");
      return;
    }
    this.checkinCards = deck.cards;
    this.checkinIndex = 0;
    this.checkinMode = "weekly";
    this.renderAll();
  }

  async finishCheckin(toastText = null, { completed = false } = {}) {
    const finishedMode = this.checkinMode;
    this.checkinMode = "hidden";
    this.checkinCards = [];
    this.checkinIndex = 0;
    await this.adapter.updatePrefs({ lastCheckinDate: logic.toDateKey(new Date()) });
    if (completed) {
      const evKind = finishedMode === "weekly" ? "weekly_review_complete" : "checkin_complete";
      await this.adapter.recordReviewCompleted(evKind);
    }
    this.renderAll();
    if (toastText) new obsidian.Notice(toastText);
  }

  advanceDeck() {
    this.checkinIndex += 1;
    if (this.checkinIndex >= this.checkinCards.length) {
      const label = this.checkinMode === "weekly" ? "Weekly Review complete." : "Morning check-in complete.";
      this.finishCheckin(label, { completed: true });
    } else {
      this.renderAll();
    }
  }

  runEndDayRitual(fromChain = false) {
    const startedMissing = this.items.filter(
      (it) => it.list !== "done" && !it.isProject && it.stage === "started" && !it.nextStep
    );
    const nextItem = startedMissing[0];
    if (nextItem) {
      this.editingStage = {
        id: nextItem.id,
        mode: "started",
        prompt: `End day (${startedMissing.length} left) — where did you leave this?`,
        endDayChain: true,
      };
      this.pendingFocus = { itemId: nextItem.id, key: "stage-input" };
      this.renderAll();
      return;
    }
    new obsidian.Notice(
      fromChain ? "End day complete — every started task has a next step." : "All started tasks already have a next step."
    );
  }

  renderAll() {
    const doc = this.contentEl.ownerDocument;
    const focusedEl = doc.activeElement;
    const focusedItemId = focusedEl?.closest?.("[data-item-id]")?.dataset?.itemId || null;
    const focusedKey = focusedEl?.dataset?.focusKey || null;

    this.shellEl.empty();
    this.renderTopBar();
    this.renderAreaAndTagBar();
    this.renderSetupBanner();
    this.renderDeckBanner();
    this.renderInboxStrip();
    this.renderCaptureForm();
    if (this.searchVisible) this.renderSearchBar();
    this.renderTimeline();
    this.renderColumns();
    this.renderToast();

    const req = this.pendingFocus;
    this.pendingFocus = null;
    if (req) {
      const target = this.shellEl.querySelector(
        `[data-item-id="${CSS.escape(req.itemId)}"] [data-focus-key="${CSS.escape(req.key)}"]`
      );
      if (target) {
        target.focus();
        if (req.key === "title-input" && typeof target.select === "function") target.select();
      }
    } else if (focusedItemId && focusedKey) {
      const target = this.shellEl.querySelector(
        `[data-item-id="${CSS.escape(focusedItemId)}"] [data-focus-key="${CSS.escape(focusedKey)}"]`
      );
      if (target) target.focus();
    }
  }

  renderTopBar() {
    const bar = this.shellEl.createDiv({ cls: "hz-topbar" });
    const left = bar.createDiv({ cls: "hz-topbar-left" });
    left.createEl("h1", { text: "Horizon" });
    left.createSpan({ text: "/", cls: "hz-sep" });
    left.createSpan({
      text: new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      cls: "hz-meta-mono",
    });

    const right = bar.createDiv({ cls: "hz-topbar-right" });
    const checkinBtn = right.createEl("button", { text: "Check-in", cls: "hz-text-btn", type: "button" });
    checkinBtn.addEventListener("click", () => this.startCheckinCards());

    const reviewBtn = right.createEl("button", { text: "Weekly Review", cls: "hz-text-btn", type: "button" });
    reviewBtn.addEventListener("click", () => this.startWeeklyReviewCards());

    const auditBtn = right.createEl("button", {
      text: "Audit",
      cls: "hz-text-btn",
      type: "button",
      title: "Export anonymized GTD + PARA trend report (zero titles or names)",
    });
    auditBtn.addEventListener("click", async () => {
      const res = await this.adapter.exportAnonymizedAudit();
      new obsidian.Notice(`Saved anonymized audit (${res.summary.totalItems} items) to ${res.mdPath}`);
      await this.adapter.openNote(res.mdPath);
    });

    const hasSamples = this.items.some((i) => i.isSample) || this.inboxItems.some((i) => i.isSample);
    if (hasSamples) {
      const clearBtn = right.createEl("button", { text: "Clear samples", cls: "hz-text-btn", type: "button" });
      clearBtn.addEventListener("click", () =>
        this.runAction(async () => {
          const count = await this.adapter.clearSampleItems();
          await this.reloadAndRender();
          new obsidian.Notice(`Cleared ${count} sample item(s).`);
        }, clearBtn)
      );
    }
  }

  renderAreaAndTagBar() {
    const selectedArea = this.adapter.getPrefs().selectedArea || "all";
    const row = this.shellEl.createDiv({ cls: "hz-area-bar" });
    const pills = row.createDiv({ cls: "hz-area-pills" });

    const makeAreaPill = (label, value) => {
      const active = selectedArea.toLowerCase() === value.toLowerCase();
      const btn = pills.createEl("button", {
        text: label,
        cls: `hz-area-pill${active ? " is-active" : ""}`,
        type: "button",
      });
      btn.addEventListener("click", async () => {
        await this.adapter.updatePrefs({ selectedArea: value });
        this.renderAll();
      });
    };

    makeAreaPill("All Areas", "all");
    for (const a of this.areas) makeAreaPill(a, a);

    const tags = logic.getAllCustomTags(this.items);
    if (tags.length > 0) {
      const tagBar = this.shellEl.createDiv({ cls: "hz-tag-bar" });
      const chips = tagBar.createDiv({ cls: "hz-tag-chips" });
      for (const tag of tags) {
        const isActive = this.activeTag === tag;
        const btn = chips.createEl("button", {
          text: `#${tag}`,
          cls: `hz-tag-chip${isActive ? " active" : ""}`,
          type: "button",
        });
        btn.addEventListener("click", () => {
          this.activeTag = isActive ? null : tag;
          this.renderAll();
        });
      }
      if (this.activeTag) {
        const clr = tagBar.createEl("button", { text: "Clear tag", cls: "hz-text-btn", type: "button" });
        clr.addEventListener("click", () => {
          this.activeTag = null;
          this.renderAll();
        });
      }
    }
  }

  renderSetupBanner() {
    if (this.vaultReady) return;
    const banner = this.shellEl.createDiv({ cls: "hz-system-banner" });
    banner.createSpan({
      text: "PARA folders (00_Inbox, 10_Projects, 20_Areas...) are not initialized in this vault yet.",
    });
    const actions = banner.createDiv({ cls: "hz-banner-actions" });
    const initBtn = actions.createEl("button", {
      text: "Initialize PARA + GTD Vault",
      cls: "hz-banner-btn",
      type: "button",
    });
    initBtn.addEventListener("click", () =>
      this.runAction(async () => {
        await this.adapter.scaffoldParaVault({ includeSamples: true });
        await this.reloadAndRender();
        new obsidian.Notice("Created PARA + GTD folders and starter templates.");
      }, initBtn)
    );
  }

  renderDeckBanner() {
    if (this.checkinMode === "hidden") return;
    const now = new Date();
    const todayKey = logic.toDateKey(now);

    if (this.checkinMode === "auto") {
      if (this.adapter.getPrefs().lastCheckinDate === todayKey) return;
      const { counts, cards } = logic.getMorningCheckinDeck(this.items, this.inboxItems, now);
      const isMonday = now.getDay() === 1;
      const lastWeek = isMonday
        ? logic.getWeeklyMomentum(this.items, this.archivedItems, now, { lastWeek: true })
        : { tasksDone: 0, stepsDone: 0 };
      const hasMondayWins = isMonday && lastWeek.tasksDone + lastWeek.stepsDone > 0;
      if (cards.length === 0 && !hasMondayWins) return;

      const box = this.shellEl.createDiv({ cls: "hz-checkin-banner" });
      if (hasMondayWins) {
        box.createDiv({
          text: `Last week: ${lastWeek.tasksDone} done · ${lastWeek.stepsDone} step${lastWeek.stepsDone === 1 ? "" : "s"}`,
          cls: "hz-checkin-wins-line",
        });
      }
      const parts = [];
      if (counts.inbox) parts.push(`${counts.inbox} inbox`);
      if (counts.started) parts.push(`${counts.started} started`);
      if (counts.missingNext) parts.push(`${counts.missingNext} missing next step`);
      if (counts.dueSoon) parts.push(`${counts.dueSoon} due soon`);
      if (counts.waiting) parts.push(`${counts.waiting} waiting`);
      if (counts.fading) parts.push(`${counts.fading} fading`);

      const row = box.createDiv({ cls: "hz-checkin-summary-row" });
      const text = row.createSpan({ cls: "hz-checkin-summary-text" });
      text.createEl("strong", { text: "Morning" });
      text.appendText(parts.length ? ` · ${parts.join(" · ")}` : " · All clear");

      const actions = row.createDiv({ cls: "hz-banner-actions" });
      if (cards.length > 0) {
        const planBtn = actions.createEl("button", { text: "Plan today", cls: "hz-banner-btn", type: "button" });
        planBtn.addEventListener("click", () => this.startCheckinCards());
      }
      const skipBtn = actions.createEl("button", { text: "Skip", cls: "hz-row-btn", type: "button" });
      skipBtn.addEventListener("click", () => this.finishCheckin());
      return;
    }

    const entry = this.checkinCards[this.checkinIndex];
    if (!entry) {
      this.finishCheckin();
      return;
    }

    const isReview = this.checkinMode === "weekly";
    const box = this.shellEl.createDiv({ cls: `hz-checkin-banner${isReview ? " is-review" : ""}` });
    const card = box.createDiv({ cls: "hz-checkin-card" });
    const body = card.createDiv({ cls: "hz-checkin-card-body" });
    const actions = card.createDiv({ cls: "hz-checkin-card-actions" });

    if (entry.kind === "archiveSummary") {
      body.createSpan({
        text: `${this.checkinIndex + 1}/${this.checkinCards.length} · ${entry.stepLabel}`,
        cls: "hz-checkin-card-kicker",
      });
      body.createSpan({
        text: `${entry.doneCount} completed/dropped item(s) ready to move to 40_Archives/`,
        cls: "hz-checkin-card-title",
      });
      const archBtn = actions.createEl("button", { text: "Archive Done Now", cls: "hz-banner-btn", type: "button" });
      archBtn.addEventListener("click", () =>
        this.runAction(async () => {
          const res = await this.adapter.archiveCompletedItems();
          new obsidian.Notice(`Archived ${res.archivedProjects} project(s) and ${res.archivedTasks} task(s).`);
          await this.finishCheckin("Weekly Review complete.", { completed: true });
        }, archBtn)
      );
      const skipBtn = actions.createEl("button", { text: "Skip", cls: "hz-row-btn", type: "button" });
      skipBtn.addEventListener("click", () => this.advanceDeck());
      return;
    }

    if (entry.kind === "inbox") {
      const inb = entry.item;
      body.createSpan({
        text: `${this.checkinIndex + 1}/${this.checkinCards.length} · ${entry.stepLabel || "Inbox Zero"}`,
        cls: "hz-checkin-card-kicker",
      });
      body.createSpan({ text: inb.title, cls: "hz-checkin-card-title" });
      const areaToUse = inb.suggestedArea || this.inboxClarifyArea;

      const mk = (lbl, cls, fn) => {
        const b = actions.createEl("button", { text: lbl, cls, type: "button" });
        b.addEventListener("click", () => this.runAction(() => fn(), b));
      };
      mk(`→ ${areaToUse}`, "hz-banner-btn", async () => {
        const res = await this.adapter.clarifyInboxItem(inb, { action: "task", area: areaToUse });
        await this.reloadAndRender();
        if (!res?.aborted) this.advanceDeck();
      });
      mk("→ Project", "hz-row-btn", async () => {
        const res = await this.adapter.clarifyInboxItem(inb, { action: "project", area: areaToUse });
        await this.reloadAndRender();
        if (!res?.aborted) this.advanceDeck();
      });
      mk("→ Someday", "hz-row-btn", async () => {
        const res = await this.adapter.clarifyInboxItem(inb, { action: "someday", area: areaToUse });
        await this.reloadAndRender();
        if (!res?.aborted) this.advanceDeck();
      });
      mk("Drop", "hz-row-btn del", async () => {
        const res = await this.adapter.clarifyInboxItem(inb, { action: "drop" });
        await this.reloadAndRender();
        if (!res?.aborted) this.advanceDeck();
      });
      actions.createEl("button", { text: "Finish", cls: "hz-row-btn", type: "button" }).addEventListener("click", () =>
        this.finishCheckin()
      );
      return;
    }

    const liveItem = this.items.find((it) => it.id === entry.item.id && it.status !== "done" && it.status !== "dropped");
    if (!liveItem) {
      this.advanceDeck();
      return;
    }

    const kindNames = {
      started: "Started",
      missingNext: "Project needs next step",
      dueSoon: "Due soon",
      waiting: "Waiting on",
      fading: "Fading (14d+)",
      projectReview: entry.stepLabel || "Active Project",
      somedayReview: entry.stepLabel || "Someday/Maybe",
    };
    const dueMeta = liveItem.dueDate
      ? ` · ${logic.formatShortDate(liveItem.dueDate)} (${logic.formatDaysLabel(logic.daysUntil(liveItem.dueDate))})`
      : "";
    body.createSpan({
      text: `${this.checkinIndex + 1}/${this.checkinCards.length} · ${kindNames[entry.kind] || "Review"} · ${liveItem.area}${dueMeta}`,
      cls: "hz-checkin-card-kicker",
    });
    body.createSpan({ text: liveItem.title, cls: "hz-checkin-card-title" });
    if (liveItem.waitingOn) {
      body.createSpan({ text: `◷ Waiting on ${liveItem.waitingOn}`, cls: "hz-checkin-card-sub" });
    } else if (liveItem.nextStep) {
      body.createSpan({ text: `→ ${liveItem.nextStep}`, cls: "hz-checkin-card-sub" });
    }

    const addAct = (lbl, cls, fn) => {
      const b = actions.createEl("button", { text: lbl, cls, type: "button" });
      b.addEventListener("click", () => this.runAction(() => fn(), b));
    };

    if (entry.kind === "fading") {
      addAct("Keep", "hz-banner-btn", async () => {
        await this.adapter.updateItemMeta(liveItem, { touch: true, snoozedUntil: "" });
        await this.reloadAndRender();
        this.advanceDeck();
      });
      addAct("Snooze 2w", "hz-row-btn", async () => {
        await this.adapter.updateItemMeta(liveItem, { snoozedUntil: logic.addDaysKey(now, 14) });
        await this.reloadAndRender();
        this.advanceDeck();
      });
      addAct("Drop", "hz-row-btn del", async () => {
        await this.adapter.dropItem(liveItem);
        await this.reloadAndRender();
        this.advanceDeck();
      });
    } else if (entry.kind === "waiting") {
      addAct("Still waiting", "hz-banner-btn", async () => {
        await this.adapter.updateItemMeta(liveItem, { touch: true });
        await this.reloadAndRender();
        this.advanceDeck();
      });
      addAct("◐ Resume", "hz-row-btn", async () => {
        await this.adapter.updateItemMeta(liveItem, { stage: "started", waitingOn: "" });
        await this.reloadAndRender();
        this.advanceDeck();
      });
      addAct("✓ Done", "hz-row-btn", async () => {
        await this.adapter.toggleItemDone(liveItem);
        await this.reloadAndRender();
        this.advanceDeck();
      });
    } else if (entry.kind === "somedayReview") {
      addAct("Activate", "hz-banner-btn", async () => {
        await this.adapter.updateItemMeta(liveItem, { someday: false });
        await this.reloadAndRender();
        this.advanceDeck();
      });
      addAct("Keep Someday", "hz-row-btn", () => this.advanceDeck());
      addAct("Drop", "hz-row-btn del", async () => {
        await this.adapter.dropItem(liveItem);
        await this.reloadAndRender();
        this.advanceDeck();
      });
    } else {
      if (liveItem.list !== "today" && this.getTodayItems().length < this.getTodayCap() && liveItem.stage !== "waiting") {
        addAct("★ Today", "hz-banner-btn", async () => {
          await this.moveItemToToday(liveItem);
          this.advanceDeck();
        });
      }
      addAct("Open Note ↗", "hz-row-btn", () => this.adapter.openNote(liveItem.filePath, liveItem.lineNumber));
      addAct("✓ Done", "hz-row-btn", async () => {
        await this.adapter.toggleItemDone(liveItem);
        await this.reloadAndRender();
        this.advanceDeck();
      });
      addAct("Next", "hz-row-btn", () => this.advanceDeck());
    }
    addAct("Finish", "hz-row-btn", () => this.finishCheckin());
  }

  renderInboxStrip() {
    if (this.inboxItems.length === 0) return;

    const strip = this.shellEl.createDiv({ cls: "hz-inbox-block" });
    const head = strip.createDiv({ cls: "hz-inbox-head" });
    const titleWrap = head.createDiv({ cls: "hz-block-title" });
    titleWrap.createEl("h2", { text: "Inbox Triage" });
    titleWrap.createSpan({ text: String(this.inboxItems.length), cls: "hz-meta-mono" });

    const controls = head.createDiv({ cls: "hz-inbox-controls" });
    controls.createSpan({ text: "Target Area:", cls: "hz-meta-mono" });
    const areaSelect = controls.createEl("select", { cls: "hz-inbox-select" });
    for (const a of this.areas) areaSelect.createEl("option", { value: a, text: a });
    areaSelect.value = this.inboxClarifyArea;
    areaSelect.addEventListener("change", () => {
      this.inboxClarifyArea = areaSelect.value;
    });

    const todayWrap = controls.createEl("label", { cls: "hz-capture-check" });
    const todayCb = todayWrap.createEl("input", { type: "checkbox" });
    todayCb.checked = this.inboxClarifyToday;
    todayCb.addEventListener("change", () => {
      this.inboxClarifyToday = todayCb.checked;
    });
    todayWrap.createSpan({ text: "Today" });

    for (const inb of this.inboxItems) {
      const row = strip.createDiv({ cls: "hz-inbox-row" });
      const main = row.createDiv({ cls: "hz-inbox-row-main" });
      main.createSpan({ text: inb.title, cls: "hz-inbox-title" });
      if (inb.kind === "inbox-note" && inb.body && inb.body !== inb.title) {
        const snippet = inb.body.length > 90 ? `${inb.body.slice(0, 87)}...` : inb.body;
        main.createSpan({ text: snippet, cls: "hz-meta-mono" });
      }

      const actions = row.createDiv({ cls: "hz-inbox-actions" });
      const mkAct = (label, cls, action) => {
        const btn = actions.createEl("button", { text: label, cls, type: "button" });
        btn.addEventListener("click", () =>
          this.runAction(async () => {
            const res = await this.adapter.clarifyInboxItem(inb, {
              action,
              area: inb.suggestedArea || this.inboxClarifyArea,
              today: this.inboxClarifyToday,
            });
            await this.reloadAndRender();
            if (!res?.aborted) new obsidian.Notice(`Clarified "${inb.title}"`);
          }, btn)
        );
      };

      mkAct("→ Task", "hz-banner-btn", "task");
      mkAct("→ Project", "hz-row-btn", "project");
      mkAct("→ Someday", "hz-row-btn", "someday");
      if (inb.kind === "inbox-note") {
        mkAct("→ Resource", "hz-row-btn", "resource");
      }
      mkAct("Drop", "hz-row-btn del", "drop");
      const openBtn = actions.createEl("button", {
        text: "↗",
        cls: "hz-row-btn",
        type: "button",
        title: "Open source note",
      });
      openBtn.addEventListener("click", () => this.adapter.openNote(inb.filePath, inb.lineNumber));
    }
  }

  renderCaptureForm() {
    const form = this.shellEl.createEl("form", { cls: "hz-capture-wrap" });
    const bar = form.createDiv({ cls: "hz-capture-bar" });

    const titleInput = bar.createEl("input", {
      type: "text",
      cls: "hz-capture-input",
      placeholder: "Add task or project... (!today, +project, !inbox, #someday, @tom, @+1w, #tag)",
    });
    titleInput.required = true;

    const dateInput = bar.createEl("input", { type: "date", cls: "hz-capture-date" });
    const todayLabel = bar.createEl("label", { cls: "hz-capture-check" });
    const todayCheck = todayLabel.createEl("input", { type: "checkbox" });
    todayLabel.createSpan({ text: "Today" });

    const submitBtn = bar.createEl("button", { text: "Add", cls: "hz-btn-add", type: "submit" });

    const chipsRow = form.createDiv({ cls: "hz-capture-chips" });
    const leftChips = chipsRow.createDiv({ cls: "hz-chip-group" });
    const rightChips = chipsRow.createDiv({ cls: "hz-chip-group" });

    const resolveQuickDate = (kind) => {
      const now = new Date();
      if (kind === "tomorrow") return logic.addDaysKey(now, 1);
      if (kind === "+1w") return logic.addDaysKey(now, 7);
      if (kind === "next-mon") return logic.getNextWeekdayKey(1, now);
      if (kind === "+1m") {
        return logic.toDateKey(logic.addMonthsClamped(now.getFullYear(), now.getMonth(), now.getDate(), 1));
      }
      return "";
    };

    const dateBtns = [];
    for (const [kind, label] of [
      ["tomorrow", "Tomorrow"],
      ["+1w", "+1w"],
      ["next-mon", "Next Mon"],
      ["+1m", "+1m"],
    ]) {
      const b = leftChips.createEl("button", { text: label, cls: "hz-chip-btn", type: "button" });
      dateBtns.push({ kind, b });
      b.addEventListener("click", () => {
        const target = resolveQuickDate(kind);
        dateInput.value = dateInput.value === target ? "" : target;
        syncHighlights();
        titleInput.focus();
      });
    }

    const syncHighlights = () => {
      for (const { kind, b } of dateBtns) {
        const target = resolveQuickDate(kind);
        b.classList.toggle("is-active", Boolean(dateInput.value) && dateInput.value === target);
      }
    };
    dateInput.addEventListener("change", syncHighlights);

    const modes = [
      ["task", "Task"],
      ["inbox", "Inbox"],
      ["project", "Project"],
    ];
    const curModeLabel = modes.find((m) => m[0] === this.captureMode)?.[1] || "Task";
    const modeBtn = rightChips.createEl("button", {
      text: `As: ${curModeLabel}`,
      cls: "hz-chip-btn",
      type: "button",
      title: "Cycle capture destination (Task / Inbox / Project)",
    });
    modeBtn.addEventListener("click", () => {
      const idx = modes.findIndex((m) => m[0] === this.captureMode);
      this.captureMode = modes[(idx + 1) % modes.length][0];
      const lbl = modes.find((m) => m[0] === this.captureMode)[1];
      modeBtn.textContent = `As: ${lbl}`;
      titleInput.focus();
    });

    const areaBtn = rightChips.createEl("button", {
      text: this.captureArea,
      cls: "hz-chip-btn",
      type: "button",
      title: "Cycle target PARA Area",
    });
    areaBtn.addEventListener("click", () => {
      const idx = this.areas.findIndex((a) => a.toLowerCase() === this.captureArea.toLowerCase());
      this.captureArea = this.areas[(idx + 1) % this.areas.length] || "Work";
      areaBtn.textContent = this.captureArea;
      titleInput.focus();
    });

    rightChips.createSpan({ text: "N add · S start · E details · / find", cls: "hz-shortcut-hint" });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.runAction(async () => {
        const parsed = logic.parseQuickCapture(titleInput.value, this.areas);
        if (!parsed.title) return;

        const finalMode = parsed.forceInbox ? "inbox" : parsed.forceProject ? "project" : this.captureMode;
        const finalDue = dateInput.value || parsed.dueDate || "";
        const finalToday = (todayCheck.checked || parsed.isToday) && finalMode !== "inbox" && !parsed.isSomeday;
        const finalArea = parsed.area || this.captureArea;

        if (finalToday && this.getTodayItems().length >= this.getTodayCap()) {
          this.pendingSwap = {
            kind: "add",
            mode: finalMode,
            title: parsed.title,
            dueDate: finalDue,
            area: finalArea,
            someday: parsed.isSomeday,
          };
          titleInput.value = "";
          dateInput.value = "";
          todayCheck.checked = false;
          this.renderAll();
          return;
        }

        await this.adapter.captureNewItem({
          mode: finalMode,
          title: parsed.title,
          area: finalArea,
          dueDate: finalDue,
          today: finalToday,
          someday: parsed.isSomeday,
          waitingOn: parsed.isWaiting ? "Pending" : "",
        });

        titleInput.value = "";
        dateInput.value = "";
        todayCheck.checked = false;
        syncHighlights();
        await this.reloadAndRender();
        const nextInput = this.shellEl.querySelector(".hz-capture-input");
        if (nextInput) nextInput.focus();
      }, submitBtn);
    });
  }

  renderSearchBar() {
    const bar = this.shellEl.createDiv({ cls: "hz-search-bar" });
    const input = bar.createEl("input", {
      type: "text",
      cls: "hz-search-input",
      placeholder: "Filter tasks, projects, next steps, or waiting on... (Esc to close)",
    });
    input.value = this.searchQuery;
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this.renderAll();
      const reopened = this.shellEl.querySelector(".hz-search-input");
      if (reopened) {
        reopened.focus();
        reopened.setSelectionRange(reopened.value.length, reopened.value.length);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.searchQuery = "";
        this.searchVisible = false;
        this.renderAll();
      }
    });
    const clr = bar.createEl("button", { text: "×", cls: "hz-row-btn", type: "button" });
    clr.addEventListener("click", () => {
      this.searchQuery = "";
      this.searchVisible = false;
      this.renderAll();
    });
  }

  renderTimeline() {
    const now = new Date();
    const todayStr = logic.toDateKey(now);
    const isDark = this.isDarkTheme();
    const overrides = this.adapter.getSettings().areaRampOverrides;

    const section = this.shellEl.createEl("section", { cls: "hz-block" });
    const head = section.createDiv({ cls: "hz-block-head" });
    const titleWrap = head.createDiv({ cls: "hz-block-title" });
    titleWrap.createEl("h2", { text: logic.getHorizonHeadingText(this.horizonDays) });

    const filtered = this.getFilteredItems();
    const timelineItems = logic.sortItemsByUrgency(
      filtered.filter((it) => it.status !== "done" && it.status !== "dropped" && !it.isSomeday && (logic.parseDateKey(it.dueDate) || it.isToday)),
      now
    );
    titleWrap.createSpan({ text: String(timelineItems.length), cls: "hz-meta-mono" });

    const headRight = head.createDiv({ cls: "hz-head-right" });
    const rangeWrap = headRight.createDiv({ cls: "hz-horizon-range" });
    rangeWrap.createSpan({ text: "View", cls: "hz-meta-mono" });

    const combo = rangeWrap.createDiv({ cls: "hz-horizon-combo" });
    const daysInput = combo.createEl("input", { type: "text", cls: "hz-horizon-days-input" });
    daysInput.value = String(this.horizonDays);
    daysInput.maxLength = 4;

    const commitDays = async (raw) => {
      const nextDays = logic.parseHorizonDays(raw, this.horizonDays);
      if (nextDays !== this.horizonDays) {
        this.horizonDays = nextDays;
        await this.adapter.updateSettings({ horizonDays: nextDays });
      }
      this.horizonMenuOpen = false;
      this.renderAll();
    };

    daysInput.addEventListener("focus", () => daysInput.select());
    daysInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitDays(daysInput.value);
      } else if (e.key === "Escape") {
        this.horizonMenuOpen = false;
        daysInput.value = String(this.horizonDays);
        daysInput.blur();
      }
    });
    daysInput.addEventListener("blur", () => {
      if (!this.horizonMenuOpen) commitDays(daysInput.value);
    });

    combo.createSpan({ text: "d", cls: "hz-horizon-days-unit" });
    const toggleBtn = combo.createEl("button", { text: "▾", cls: "hz-horizon-preset-toggle", type: "button" });
    toggleBtn.addEventListener("mousedown", (e) => e.preventDefault());
    toggleBtn.addEventListener("click", () => {
      this.horizonMenuOpen = !this.horizonMenuOpen;
      this.renderAll();
    });

    if (this.horizonMenuOpen) {
      const menu = combo.createDiv({ cls: "hz-horizon-preset-menu" });
      for (const preset of logic.HORIZON_PRESETS) {
        const opt = menu.createEl("button", {
          cls: `hz-horizon-preset-option${preset === this.horizonDays ? " active" : ""}`,
          type: "button",
        });
        opt.createSpan({ text: `${preset}d` });
        opt.addEventListener("mousedown", (e) => e.preventDefault());
        opt.addEventListener("click", () => commitDays(preset));
      }
    }

    const legend = headRight.createDiv({ cls: "hz-legend" });
    legend.createSpan({ text: `${this.horizonDays}d` });
    legend.createSpan({ cls: "hz-legend-bar" });
    legend.createSpan({ text: "Due" });

    const overdue = [];
    const upcoming = [];
    const beyond = [];
    for (const item of timelineItems) {
      const effDate = logic.parseDateKey(item.dueDate) ? item.dueDate : todayStr;
      const days = logic.daysUntil(effDate, now);
      if (days === null) continue;
      if (days < 0) overdue.push({ item, days, effDate });
      else if (days <= this.horizonDays) upcoming.push({ item, days, effDate });
      else beyond.push({ item, days, effDate });
    }

    if (overdue.length > 0) {
      const overdueRow = section.createDiv({ cls: "hz-overdue-row" });
      overdueRow.createSpan({ text: "Overdue", cls: "hz-overdue-label" });
      for (const { item, days } of overdue) {
        const grp = overdueRow.createSpan({ cls: "hz-overdue-chip-group" });
        const chip = grp.createEl("button", {
          text: `${item.title} (${logic.formatDaysLabel(days)})`,
          cls: "hz-overdue-chip",
          type: "button",
        });
        chip.addEventListener("click", () => {
          this.inspectedItemId = item.id;
          this.renderAll();
        });
        const snz = grp.createEl("button", { text: "+1w", cls: "hz-overdue-snooze-btn", type: "button" });
        snz.addEventListener("click", () =>
          this.runAction(async () => {
            const nextDate = logic.addDaysKey(now, 7);
            const res = await this.adapter.updateItemMeta(item, { dueDate: nextDate });
            await this.reloadAndRender();
            if (res?.undoInfo || !res?.aborted) {
              this.showScopedToast(`Snoozed "${item.title}" to ${logic.formatShortDate(nextDate)}`, res?.undoInfo);
            }
          }, snz)
        );
      }
    }

    const scroll = section.createDiv({ cls: "hz-timeline-scroll" });
    const canvas = scroll.createDiv({ cls: "hz-timeline-canvas" });
    const axisEl = canvas.createDiv({ cls: "hz-timeline-axis" });
    const gridEl = canvas.createDiv({ cls: "hz-timeline-grid" });
    const lanesEl = canvas.createDiv({
      cls: `hz-timeline-lanes${upcoming.length > 8 && this.showAllTimeline ? " is-expanded" : ""}`,
    });

    const { markers, gridLines } = logic.getTimelineAxis(now, this.horizonDays);
    for (const m of markers) {
      const cls = ["hz-month-marker"];
      if (m.isToday) cls.push("is-today");
      else if (m.isAccent) cls.push("is-accent");
      else if (!m.isMajor) cls.push("is-minor");
      const el = axisEl.createDiv({ cls: cls.join(" "), text: m.label });
      el.style.left = `${m.percent}%`;
    }
    for (const g of gridLines) {
      const line = gridEl.createDiv({ cls: `hz-grid-line${g.isMajor ? " is-major" : ""}` });
      line.style.left = `${g.percent}%`;
    }

    if (upcoming.length === 0) {
      lanesEl.createDiv({
        text: beyond.length > 0 ? `No items due within ${this.horizonDays}d.` : "No dated or Today items yet.",
        cls: "hz-timeline-empty",
      });
    } else {
      for (const { item, days, effDate } of upcoming) {
        const lane = lanesEl.createDiv({ cls: "hz-timeline-lane" });
        const st = logic.getAreaGradientStyle(days, item.area, this.horizonDays, isDark, overrides);
        const widthPct = logic.getTimelineWidthPercent(days, this.horizonDays);
        const labelOutside = widthPct < 34;

        const barCls = ["hz-timeline-bar"];
        if (item.area.toLowerCase() !== "work") barCls.push("is-personal");
        if (item.isToday) barCls.push("is-today-star");
        if (item.stage === "waiting") barCls.push("is-waiting");

        const bar = lane.createEl("button", { cls: barCls.join(" "), type: "button" });
        bar.style.width = `${widthPct}%`;
        bar.style.background = st.background;
        bar.style.borderRightColor = st.borderColor;
        bar.style.color = st.textColor;
        bar.addEventListener("click", () => {
          this.inspectedItemId = this.inspectedItemId === item.id ? null : item.id;
          this.renderAll();
        });

        const ratio = logic.getItemProgressRatio(item);
        if (ratio > 0) {
          const fill = bar.createSpan({ cls: "hz-timeline-progress-fill" });
          fill.style.width = `${Math.round(ratio * 100)}%`;
          fill.style.background = st.borderColor;
        }

        const prefix = item.isToday ? "★ " : item.stage === "started" ? "◐ " : item.stage === "waiting" ? "◷ " : "";
        const titleText = `${prefix}${item.title}`;
        const metaText = `${logic.formatShortDate(effDate)} · ${logic.formatDaysLabel(days)}`;
        const freshness = logic.getItemFreshness(item, now);

        if (labelOutside) {
          const outside = lane.createEl("button", { cls: "hz-timeline-outside-label", type: "button" });
          if (freshness.isFading) outside.style.opacity = String(freshness.opacity);
          outside.createSpan({ text: titleText, cls: "hz-timeline-outside-title" });
          const mSpan = outside.createSpan({ text: metaText, cls: "hz-timeline-outside-meta" });
          mSpan.style.color = st.badgeColor;
          outside.addEventListener("click", () => {
            this.inspectedItemId = this.inspectedItemId === item.id ? null : item.id;
            this.renderAll();
          });
        } else {
          const tSpan = bar.createSpan({ text: titleText, cls: "hz-timeline-bar-label" });
          if (freshness.isFading) tSpan.style.opacity = String(freshness.opacity);
          bar.createSpan({ text: metaText, cls: "hz-timeline-bar-meta" });
        }
      }
    }

    if (beyond.length > 0) {
      const beyondEl = canvas.createDiv({ cls: "hz-timeline-beyond-note" });
      beyondEl.createSpan({ text: `Beyond ${this.horizonDays}d`, cls: "hz-beyond-label" });
      for (const { item, days, effDate } of beyond) {
        const c = beyondEl.createEl("button", {
          text: `${item.title} (${logic.formatShortDate(effDate)}, ${days}d)`,
          cls: "hz-beyond-chip",
          type: "button",
        });
        c.addEventListener("click", () => {
          this.inspectedItemId = item.id;
          this.renderAll();
        });
      }
    }

    if (upcoming.length > 8) {
      const foot = section.createDiv({ cls: "hz-section-foot" });
      const more = foot.createEl("button", {
        text: this.showAllTimeline ? "Show less" : `Show all (${upcoming.length})`,
        cls: "hz-text-btn",
        type: "button",
      });
      more.addEventListener("click", () => {
        this.showAllTimeline = !this.showAllTimeline;
        this.renderAll();
      });
    }

    const inspected = this.inspectedItemId
      ? filtered.find((it) => it.id === this.inspectedItemId && it.status !== "done" && it.status !== "dropped")
      : null;
    if (inspected) {
      const insp = section.createDiv({ cls: "hz-timeline-inspector" });
      const info = insp.createDiv({ cls: "hz-timeline-inspector-info" });
      info.createEl("strong", { text: inspected.title });
      info.createSpan({ text: inspected.area, cls: "hz-area-badge" });
      if (inspected.waitingOn) info.createSpan({ text: `◷ ${inspected.waitingOn}`, cls: "hz-meta-mono" });
      else if (inspected.nextStep) info.createSpan({ text: `→ ${inspected.nextStep}`, cls: "hz-meta-mono" });

      const acts = insp.createDiv({ cls: "hz-timeline-inspector-actions" });
      if (inspected.list !== "today" && inspected.stage !== "waiting") {
        acts.createEl("button", { text: "→ Today", cls: "hz-banner-btn", type: "button" }).addEventListener("click", () =>
          this.moveItemToToday(inspected)
        );
      } else if (inspected.list === "today") {
        acts.createEl("button", { text: "Later", cls: "hz-banner-btn", type: "button" }).addEventListener("click", () =>
          this.moveItemToLater(inspected)
        );
      }
      acts
        .createEl("button", { text: "Open Note ↗", cls: "hz-banner-btn", type: "button" })
        .addEventListener("click", () => this.adapter.openNote(inspected.filePath, inspected.lineNumber));
      acts
        .createEl("button", { text: "✓ Done", cls: "hz-banner-btn", type: "button" })
        .addEventListener("click", (e) =>
          this.runAction(async () => {
            const res = await this.adapter.toggleItemDone(inspected);
            await this.reloadAndRender();
            if (!res?.aborted && res?.message) this.showScopedToast(res.message, res.undoInfo);
          }, e.currentTarget)
        );
      acts
        .createEl("button", { text: "×", cls: "hz-banner-btn", type: "button" })
        .addEventListener("click", () => {
          this.inspectedItemId = null;
          this.renderAll();
        });
    }
  }

  renderColumns() {
    const cols = this.shellEl.createDiv({ cls: "hz-columns" });
    const leftCol = cols.createDiv({ cls: "hz-col" });
    const rightCol = cols.createDiv({ cls: "hz-col" });

    const visible = this.getFilteredItems();
    const todayCap = this.getTodayCap();
    const allToday = this.getTodayItems(this.items);
    const todayItems = logic.sortItemsByUrgency(visible.filter((it) => it.list === "today"));
    const waitingItems = logic.sortItemsByUrgency(visible.filter((it) => it.list === "later" && it.stage === "waiting"));
    const laterPool = logic.sortItemsByUrgency(visible.filter((it) => it.list === "later" && it.stage !== "waiting"));
    const doneItems = visible
      .filter((it) => it.list === "done")
      .sort((a, b) => (b.completedDate || b.droppedDate || "").localeCompare(a.completedDate || a.droppedDate || ""));

    // LEFT TOP: TODAY
    const todaySec = leftCol.createEl("section", { cls: "hz-block" });
    const todayHead = todaySec.createDiv({ cls: "hz-block-head" });
    const tTitle = todayHead.createDiv({ cls: "hz-block-title" });
    tTitle.createEl("h2", { text: "Today" });
    tTitle.createSpan({ text: `${allToday.length}/${todayCap}`, cls: "hz-meta-mono" });

    const tRight = todayHead.createDiv({ cls: "hz-head-right" });
    const isOver = allToday.length > todayCap;
    tRight.createSpan({
      text: isOver ? `${allToday.length} in focus — trim to ${todayCap}?` : `1–${todayCap} focus items`,
      cls: `hz-nudge${isOver ? " is-heavy" : ""}`,
    });
    if (this.items.some((it) => it.list !== "done" && !it.isProject && it.stage === "started")) {
      const endBtn = tRight.createEl("button", { text: "End day", cls: "hz-text-btn", type: "button" });
      endBtn.addEventListener("click", () => this.runEndDayRitual(false));
    }

    if (this.pendingSwap && allToday.length >= todayCap) {
      const swap = todaySec.createDiv({ cls: "hz-swap-prompt" });
      swap.createSpan({ text: `Today is full (${allToday.length}/${todayCap}). Swap out:`, cls: "hz-swap-prompt-label" });
      for (const cur of allToday) {
        const short = cur.title.length > 26 ? `${cur.title.slice(0, 24)}…` : cur.title;
        const btn = swap.createEl("button", { text: short, cls: "hz-banner-btn", type: "button" });
        btn.addEventListener("click", () => this.executeSwap(cur.id));
      }
      swap
        .createEl("button", { text: this.pendingSwap.kind === "add" ? "Add to Later" : "Cancel", cls: "hz-row-btn", type: "button" })
        .addEventListener("click", async () => {
          const info = this.pendingSwap;
          this.pendingSwap = null;
          if (info.kind === "add") {
            await this.adapter.captureNewItem({
              mode: info.mode,
              title: info.title,
              area: info.area,
              dueDate: info.dueDate,
              today: false,
              someday: info.someday,
            });
            await this.reloadAndRender();
          } else {
            this.renderAll();
          }
        });
      swap
        .createEl("button", { text: "Add anyway", cls: "hz-row-btn", type: "button" })
        .addEventListener("click", async () => {
          const info = this.pendingSwap;
          this.pendingSwap = null;
          if (info.kind === "add") {
            await this.adapter.captureNewItem({
              mode: info.mode,
              title: info.title,
              area: info.area,
              dueDate: info.dueDate,
              today: true,
              someday: info.someday,
            });
            await this.reloadAndRender();
          } else {
            const target = this.items.find((it) => it.id === info.itemId);
            if (target) await this.moveItemToToday(target, { forceToday: true });
          }
        });
    }

    if (todayItems.length === 0) {
      todaySec.createDiv({ text: "Nothing set for today.", cls: "hz-empty" });
    } else {
      const ul = todaySec.createEl("ul", { cls: "hz-list" });
      for (const item of todayItems) ul.appendChild(this.buildItemRow(item, "today"));
    }

    // LEFT BOTTOM: DONE
    const doneSec = leftCol.createEl("section", { cls: "hz-block" });
    const doneHead = doneSec.createDiv({ cls: "hz-block-head" });
    const dTitle = doneHead.createDiv({ cls: "hz-block-title" });
    dTitle.createEl("h2", { text: "Done" });
    const momentum = logic.getWeeklyMomentum(this.items, this.archivedItems);
    dTitle.createSpan({
      text:
        momentum.stepsDone > 0
          ? `${momentum.tasksDone} done · ${momentum.stepsDone} step${momentum.stepsDone === 1 ? "" : "s"} this week`
          : `${momentum.tasksDone} this week`,
      cls: "hz-meta-mono hz-ok-text",
    });

    if (doneItems.length > 0) {
      const dRight = doneHead.createDiv({ cls: "hz-head-right" });
      if (this.confirmingArchive) {
        const yes = dRight.createEl("button", { text: "Confirm Archive?", cls: "hz-banner-btn", type: "button" });
        yes.addEventListener("click", () =>
          this.runAction(async () => {
            this.confirmingArchive = false;
            const res = await this.adapter.archiveCompletedItems();
            await this.reloadAndRender();
            new obsidian.Notice(`Archived ${res.archivedProjects} project(s) and ${res.archivedTasks} task(s) to 40_Archives/.`);
          }, yes)
        );
        const cancel = dRight.createEl("button", { text: "Cancel", cls: "hz-row-btn", type: "button" });
        cancel.addEventListener("click", () => {
          this.confirmingArchive = false;
          this.renderAll();
        });
      } else {
        const archBtn = dRight.createEl("button", { text: "Archive done", cls: "hz-text-btn", type: "button" });
        archBtn.addEventListener("click", () => {
          this.confirmingArchive = true;
          this.renderAll();
        });
      }
    }

    if (doneItems.length === 0) {
      doneSec.createDiv({ text: "Completed items appear here until archived.", cls: "hz-empty" });
    } else {
      const ul = doneSec.createEl("ul", { cls: "hz-list" });
      const slice = this.showAllDone ? doneItems : doneItems.slice(0, 10);
      for (const item of slice) ul.appendChild(this.buildItemRow(item, "done"));
      if (doneItems.length > 10) {
        const more = doneSec.createEl("button", {
          text: this.showAllDone ? "Show fewer" : `Show ${doneItems.length - 10} more`,
          cls: "hz-text-btn",
          type: "button",
        });
        more.addEventListener("click", () => {
          this.showAllDone = !this.showAllDone;
          this.renderAll();
        });
      }
    }

    // RIGHT: LATER (3 clean filter tabs: Active · Projects · Someday + Waiting On)
    const laterSec = rightCol.createEl("section", { cls: "hz-block" });
    const laterHead = laterSec.createDiv({ cls: "hz-block-head" });
    const lTitle = laterHead.createDiv({ cls: "hz-block-title" });
    lTitle.createEl("h2", { text: "Later" });

    const laterFilter = this.adapter.getPrefs().laterFilter || "active";
    const filteredLater = laterPool.filter((it) => {
      if (laterFilter === "projects") return it.isProject && !it.isSomeday;
      if (laterFilter === "someday") return it.isSomeday;
      return !it.isSomeday;
    });
    lTitle.createSpan({ text: String(filteredLater.length), cls: "hz-meta-mono" });

    const filters = laterHead.createDiv({ cls: "hz-filters" });
    for (const [val, label] of [
      ["active", "Active"],
      ["projects", "Projects"],
      ["someday", "Someday"],
    ]) {
      const fb = filters.createEl("button", {
        text: label,
        cls: `hz-filter-btn${laterFilter === val ? " active" : ""}`,
        type: "button",
      });
      fb.addEventListener("click", async () => {
        await this.adapter.updatePrefs({ laterFilter: val });
        this.renderAll();
      });
    }

    if (filteredLater.length === 0) {
      laterSec.createDiv({
        text:
          laterFilter === "someday"
            ? "No Someday/Maybe items yet."
            : laterFilter === "projects"
            ? "No active projects in Later."
            : "Nothing waiting in Later.",
        cls: "hz-empty",
      });
    } else {
      const ul = laterSec.createEl("ul", { cls: "hz-list" });
      for (const item of filteredLater) ul.appendChild(this.buildItemRow(item, "later"));
    }

    if (waitingItems.length > 0) {
      const waitWrap = laterSec.createDiv({ cls: "hz-waiting-section" });
      const waitExpanded = Boolean(this.adapter.getPrefs().waitingExpanded);
      const wToggle = waitWrap.createEl("button", { cls: "hz-waiting-toggle", type: "button" });
      wToggle.createSpan({ text: `◷ Waiting on (${waitingItems.length})` });
      wToggle.createSpan({ text: waitExpanded ? "▾" : "▸", cls: "hz-meta-mono" });
      wToggle.addEventListener("click", async () => {
        await this.adapter.updatePrefs({ waitingExpanded: !waitExpanded });
        this.renderAll();
      });
      if (waitExpanded) {
        const wList = waitWrap.createEl("ul", { cls: "hz-list" });
        for (const wItem of waitingItems) wList.appendChild(this.buildItemRow(wItem, "later"));
      }
    }
  }

  buildItemRow(item, context) {
    const doc = this.contentEl.ownerDocument;
    const now = new Date();
    const isDark = this.isDarkTheme();
    const overrides = this.adapter.getSettings().areaRampOverrides;
    const freshness = logic.getItemFreshness(item, now);

    const li = doc.createElement("li");
    li.className = `hz-task-item${item.status === "done" ? " is-done" : ""}${item.status === "dropped" ? " is-dropped" : ""}${freshness.isFading ? " is-fading" : ""}`;
    if (freshness.isFading) li.style.setProperty("--hz-ink-alpha", String(freshness.opacity));
    li.dataset.itemId = item.id;

    const mainRow = li.createDiv({ cls: "hz-task-main-row" });

    const cb = mainRow.createEl("input", { type: "checkbox", cls: "hz-task-checkbox" });
    cb.dataset.focusKey = "check";
    cb.checked = item.status === "done";
    cb.addEventListener("change", () =>
      this.runAction(async () => {
        const res = await this.adapter.toggleItemDone(item);
        await this.reloadAndRender();
        if (!res?.aborted && res?.message) this.showScopedToast(res.message, res.undoInfo);
      }, cb)
    );

    if (item.list !== "done") {
      const glyph = item.stage === "started" ? "◐" : item.stage === "waiting" ? "◷" : "○";
      const sBtn = mainRow.createEl("button", {
        text: glyph,
        cls: `hz-stage-btn${item.stage === "started" ? " is-started" : item.stage === "waiting" ? " is-waiting" : ""}`,
        type: "button",
      });
      sBtn.dataset.focusKey = "stage";
      sBtn.addEventListener("click", async () => {
        if (this.editingStage && this.editingStage.id === item.id) {
          this.editingStage = null;
          this.renderAll();
          return;
        }
        this.pendingFocus = { itemId: item.id, key: "stage-input" };
        if (item.stage === "todo" && !item.isProject) {
          this.editingStage = { id: item.id, mode: "started" };
          await this.adapter.updateItemMeta(item, { stage: "started" });
          await this.reloadAndRender();
        } else {
          this.editingStage = { id: item.id, mode: item.stage === "waiting" ? "waiting" : "started" };
          this.renderAll();
        }
      });
    }

    const body = mainRow.createDiv({ cls: "hz-task-body" });
    const line = body.createDiv({ cls: "hz-task-line" });

    if (this.editingTitleId === item.id) {
      const tInput = line.createEl("input", { type: "text", cls: "hz-task-title-input" });
      tInput.value = item.title;
      tInput.dataset.focusKey = "title-input";
      let done = false;
      const commit = async () => {
        if (done) return;
        done = true;
        const val = tInput.value.trim();
        this.editingTitleId = null;
        if (val && val !== item.title) {
          await this.adapter.updateItemMeta(item, { title: val });
          await this.reloadAndRender();
        } else {
          this.renderAll();
        }
      };
      tInput.addEventListener("blur", commit);
      tInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          done = true;
          this.editingTitleId = null;
          this.renderAll();
        }
      });
    } else {
      const titleSpan = line.createSpan({ text: item.title, cls: "hz-task-title" });
      titleSpan.addEventListener("dblclick", () => {
        if (item.list === "done") return;
        this.editingTitleId = item.id;
        this.pendingFocus = { itemId: item.id, key: "title-input" };
        this.renderAll();
      });
    }

    if (item.isProject) line.createSpan({ text: "PROJECT", cls: "hz-kind-badge" });
    if ((this.adapter.getPrefs().selectedArea || "all") === "all") {
      line.createSpan({ text: item.area, cls: "hz-area-badge" });
    }
    if (item.needsNextStep) {
      line.createSpan({ text: "Needs next step", cls: "hz-needs-next-badge" });
    }

    if (item.list === "done") {
      const d = item.completedDate || item.droppedDate;
      if (d) {
        line.createSpan({
          text: `${item.status === "dropped" ? "Dropped " : ""}${logic.formatShortDate(d)}`,
          cls: "hz-done-date",
        });
      }
    } else if (item.dueDate && logic.parseDateKey(item.dueDate)) {
      const days = logic.daysUntil(item.dueDate, now);
      const st = logic.getAreaGradientStyle(days, item.area, this.horizonDays, isDark, overrides);
      const dueTag = line.createSpan({
        text: `${logic.formatShortDate(item.dueDate)} · ${logic.formatDaysLabel(days)}`,
        cls: "hz-due-tag",
      });
      dueTag.style.background = st.badgeBg;
      dueTag.style.color = st.badgeColor;
    }

    if (item.recurrence) {
      line.createSpan({ text: `↻ ${item.recurrence}`, cls: "hz-recurrence-pill" });
    }

    if (item.isProject && item.steps.length > 0) {
      const doneSteps = item.steps.filter((s) => s.done).length;
      const sBtn = line.createEl("button", {
        text: `${doneSteps}/${item.steps.length}`,
        cls: "hz-subtask-count-btn",
        type: "button",
      });
      sBtn.addEventListener("click", () => {
        this.expandedItemId = this.expandedItemId === item.id ? null : item.id;
        this.renderAll();
      });
    }

    if (item.list !== "done" && item.stage === "waiting" && item.waitingOn) {
      const wLine = body.createEl("button", {
        text: `Waiting on ${item.waitingOn}`,
        cls: "hz-next-step-line is-waiting-line",
        type: "button",
      });
      wLine.addEventListener("click", () => {
        this.editingStage = { id: item.id, mode: "waiting" };
        this.pendingFocus = { itemId: item.id, key: "stage-input" };
        this.renderAll();
      });
    } else if (item.list !== "done" && item.nextStep) {
      const nLine = body.createEl("button", {
        text: `→ ${item.nextStep}`,
        cls: "hz-next-step-line",
        type: "button",
      });
      nLine.addEventListener("click", () => {
        if (item.isProject) {
          this.expandedItemId = item.id;
          this.renderAll();
        } else {
          this.editingStage = { id: item.id, mode: "started" };
          this.pendingFocus = { itemId: item.id, key: "stage-input" };
          this.renderAll();
        }
      });
    }

    const actions = mainRow.createDiv({ cls: "hz-task-actions" });
    if (item.list !== "done") {
      const dateIn = actions.createEl("input", { type: "date", cls: "hz-inline-date-input" });
      dateIn.value = item.dueDate || "";
      dateIn.dataset.focusKey = "date";
      let committed = false;
      const commitDate = async () => {
        if (committed) return;
        const val = dateIn.value || "";
        if (val !== (item.dueDate || "")) {
          committed = true;
          await this.adapter.updateItemMeta(item, { dueDate: val });
          await this.reloadAndRender();
        }
      };
      dateIn.addEventListener("blur", commitDate);
      dateIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitDate();
        }
      });

      if (item.stage !== "waiting" && !item.isSomeday) {
        const mvBtn = actions.createEl("button", {
          text: context === "today" ? "Later" : "→ Today",
          cls: "hz-row-btn",
          type: "button",
        });
        mvBtn.dataset.focusKey = "move";
        mvBtn.addEventListener("click", () => {
          if (context === "today") this.moveItemToLater(item);
          else this.moveItemToToday(item);
        });
      }
    }

    const openBtn = actions.createEl("button", {
      text: "↗",
      cls: "hz-row-btn",
      type: "button",
      title: "Open source Markdown note",
    });
    openBtn.addEventListener("click", () => this.adapter.openNote(item.filePath, item.lineNumber));

    const isExpanded = this.expandedItemId === item.id;
    const expBtn = actions.createEl("button", {
      text: isExpanded ? "▾" : "▸",
      cls: "hz-row-btn",
      type: "button",
      title: "Steps & details (E)",
    });
    expBtn.dataset.focusKey = "detail";
    expBtn.addEventListener("click", () => {
      this.expandedItemId = isExpanded ? null : item.id;
      this.renderAll();
    });

    if (item.list !== "done") {
      const dropBtn = actions.createEl("button", {
        text: "×",
        cls: "hz-row-btn del",
        type: "button",
        title: "Drop / cancel item",
      });
      dropBtn.addEventListener("click", () =>
        this.runAction(async () => {
          const res = await this.adapter.dropItem(item);
          await this.reloadAndRender();
          if (!res?.aborted && res?.message) this.showScopedToast(res.message, res.undoInfo);
        }, dropBtn)
      );
    }

    if (freshness.isStale && !(this.editingStage && this.editingStage.id === item.id)) {
      const staleBar = li.createDiv({ cls: "hz-stale-bar" });
      staleBar.createSpan({ text: `Untouched ${freshness.daysUntouched}d:` });
      staleBar.createEl("button", { text: "Keep", cls: "hz-stale-btn", type: "button" }).addEventListener("click", (e) =>
        this.runAction(async () => {
          await this.adapter.updateItemMeta(item, { touch: true, snoozedUntil: "" });
          await this.reloadAndRender();
        }, e.currentTarget)
      );
      staleBar.createEl("button", { text: "Snooze 2w", cls: "hz-stale-btn", type: "button" }).addEventListener("click", (e) =>
        this.runAction(async () => {
          await this.adapter.updateItemMeta(item, { snoozedUntil: logic.addDaysKey(now, 14) });
          await this.reloadAndRender();
        }, e.currentTarget)
      );
      staleBar.createEl("button", { text: "Drop", cls: "hz-stale-btn is-drop", type: "button" }).addEventListener("click", (e) =>
        this.runAction(async () => {
          const res = await this.adapter.dropItem(item);
          await this.reloadAndRender();
          if (!res?.aborted && res?.message) this.showScopedToast(res.message, res.undoInfo);
        }, e.currentTarget)
      );
    }

    if (this.editingStage && this.editingStage.id === item.id && item.list !== "done") {
      li.appendChild(this.buildStageEditor(item));
    }

    if (isExpanded) {
      li.appendChild(this.buildItemDetail(item));
    }

    return li;
  }

  buildStageEditor(item) {
    const editor = this.contentEl.ownerDocument.createElement("div");
    editor.className = "hz-stage-editor";
    const mode = this.editingStage.mode;

    if (this.editingStage.prompt) {
      editor.createDiv({ text: this.editingStage.prompt, cls: "hz-stage-editor-hint" });
    }

    const tabs = editor.createDiv({ cls: "hz-stage-editor-tabs" });
    const mkTab = (label, active, onClick) => {
      const b = tabs.createEl("button", {
        text: label,
        cls: `hz-stage-chip${active ? " active" : ""}`,
        type: "button",
      });
      b.addEventListener("click", onClick);
    };
    mkTab("◐ Started", mode === "started", () => {
      this.editingStage = { id: item.id, mode: "started" };
      this.pendingFocus = { itemId: item.id, key: "stage-input" };
      this.renderAll();
    });
    mkTab("◷ Waiting on", mode === "waiting", () => {
      this.editingStage = { id: item.id, mode: "waiting" };
      this.pendingFocus = { itemId: item.id, key: "stage-input" };
      this.renderAll();
    });
    mkTab("○ Reset", false, async () => {
      this.editingStage = null;
      await this.adapter.updateItemMeta(item, { stage: "todo", waitingOn: "", nextStep: "" });
      await this.reloadAndRender();
    });

    const row = editor.createDiv({ cls: "hz-stage-editor-row" });
    const input = row.createEl("input", { type: "text", cls: "hz-stage-editor-input" });
    input.dataset.focusKey = "stage-input";
    input.placeholder = mode === "waiting" ? "Waiting on who / what?" : "Next physical step...";
    input.value = mode === "waiting" ? item.waitingOn || "" : item.nextStep || "";

    const commit = () =>
      this.runAction(async () => {
        const val = input.value.trim();
        const continueChain = Boolean(this.editingStage?.endDayChain);
        this.editingStage = null;
        if (mode === "waiting") {
          if (val) {
            await this.adapter.updatePrefs({ waitingExpanded: true });
            await this.adapter.updateItemMeta(item, { stage: "waiting", waitingOn: val, today: false });
          } else {
            await this.adapter.updateItemMeta(item, { stage: "started", waitingOn: "" });
          }
        } else {
          await this.adapter.updateItemMeta(item, { stage: "started", nextStep: val, waitingOn: "" });
        }
        await this.reloadAndRender();
        if (continueChain && val) this.runEndDayRitual(true);
      });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        this.editingStage = null;
        this.renderAll();
      }
    });

    row.createEl("button", { text: "Save", cls: "hz-banner-btn", type: "button" }).addEventListener("click", commit);
    row.createEl("button", { text: "Cancel", cls: "hz-row-btn", type: "button" }).addEventListener("click", () => {
      this.editingStage = null;
      this.renderAll();
    });

    return editor;
  }

  buildItemDetail(item) {
    const detail = this.contentEl.ownerDocument.createElement("div");
    detail.className = "hz-task-detail";

    if (item.isProject) {
      const doneCnt = item.steps.filter((s) => s.done).length;
      detail.createDiv({
        text: item.steps.length > 0 ? `Project Steps (${doneCnt}/${item.steps.length})` : "Project Steps",
        cls: "hz-detail-label",
      });
      if (item.steps.length > 0) {
        const ul = detail.createEl("ul", { cls: "hz-subtask-list" });
        for (const step of item.steps) {
          const row = ul.createEl("li", { cls: `hz-subtask-row${step.done ? " is-done" : ""}` });
          const cb = row.createEl("input", { type: "checkbox", cls: "hz-task-checkbox" });
          cb.checked = step.done;
          cb.addEventListener("change", () =>
            this.runAction(async () => {
              await this.adapter.toggleProjectStep(item, step);
              await this.reloadAndRender();
            }, cb)
          );
          row.createSpan({ text: step.title, cls: "hz-subtask-title" });
          row.createEl("button", { text: "×", cls: "hz-row-btn del", type: "button" }).addEventListener("click", (e) =>
            this.runAction(async () => {
              await this.adapter.removeProjectStep(item, step);
              await this.reloadAndRender();
            }, e.currentTarget)
          );
        }
      }
      if (item.list !== "done") {
        const addRow = detail.createDiv({ cls: "hz-subtask-add-row" });
        const sIn = addRow.createEl("input", {
          type: "text",
          cls: "hz-stage-editor-input",
          placeholder: "Add step to project note...",
        });
        const doAdd = () =>
          this.runAction(async () => {
            const val = sIn.value.trim();
            if (!val) return;
            await this.adapter.addProjectStep(item, val);
            await this.reloadAndRender();
          });
        sIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            doAdd();
          }
        });
        addRow.createEl("button", { text: "Add", cls: "hz-banner-btn", type: "button" }).addEventListener("click", doAdd);
      }
      if (item.notesPreview) {
        detail.createDiv({ text: item.notesPreview, cls: "hz-notes-preview" });
      }
    } else if (item.list !== "done") {
      const btnRow = detail.createDiv({ cls: "hz-banner-actions" });
      btnRow
        .createEl("button", { text: "Promote to Project", cls: "hz-banner-btn", type: "button" })
        .addEventListener("click", (e) =>
          this.runAction(async () => {
            const projFile = await this.adapter.promoteTaskToProject(item);
            await this.reloadAndRender();
            if (projFile) new obsidian.Notice(`Promoted to 10_Projects/${projFile.basename}.md`);
          }, e.currentTarget)
        );
      btnRow
        .createEl("button", {
          text: item.isSomeday ? "Move to Active" : "Move to Someday",
          cls: "hz-row-btn",
          type: "button",
        })
        .addEventListener("click", (e) =>
          this.runAction(async () => {
            await this.adapter.updateItemMeta(item, { someday: !item.isSomeday });
            await this.reloadAndRender();
          }, e.currentTarget)
        );
    }

    return detail;
  }
}

module.exports = {
  VIEW_TYPE_HORIZON,
  HorizonItemView,
};
