/**
 * settings.js — Obsidian Settings Tab & Modals (Quick Capture + Tasks JSON Import)
 */

const obsidian = require("obsidian");
const logic = require("./logic-core");

class QuickCaptureModal extends obsidian.Modal {
  constructor(app, adapter, onDone) {
    super(app);
    this.adapter = adapter;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("horizon-lifeos-modal");
    contentEl.createEl("h3", { text: "Quick Capture to Horizon" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "e.g. Call dentist !today #health @tom  (or !inbox, +project, #someday)",
    });
    input.style.width = "100%";

    const row = contentEl.createDiv({ cls: "hz-modal-row" });
    const modeSelect = row.createEl("select");
    modeSelect.createEl("option", { value: "inbox", text: "00_Inbox (Clarify later)" });
    modeSelect.createEl("option", { value: "task", text: "Area Task" });
    modeSelect.createEl("option", { value: "project", text: "10_Projects (New Project)" });
    modeSelect.value = "inbox";

    const areaSelect = row.createEl("select");
    const settings = this.adapter.getSettings();
    const areas = ["Work", "Personal", "Health", "Finance"];
    if (settings.lastUsedArea && !areas.includes(settings.lastUsedArea)) areas.push(settings.lastUsedArea);
    for (const a of areas) areaSelect.createEl("option", { value: a, text: a });
    areaSelect.value = settings.lastUsedArea || "Work";

    const submitBtn = row.createEl("button", { text: "Capture", cls: "mod-cta" });
    let submitting = false;

    const submit = async () => {
      if (submitting) return;
      const parsed = logic.parseQuickCapture(input.value, areas);
      if (!parsed.title) return;
      submitting = true;
      submitBtn.disabled = true;
      try {
        const mode = parsed.forceInbox
          ? "inbox"
          : parsed.forceProject
          ? "project"
          : modeSelect.value;
        await this.adapter.captureNewItem({
          mode,
          title: parsed.title,
          area: parsed.area || areaSelect.value,
          dueDate: parsed.dueDate || "",
          today: parsed.isToday,
          someday: parsed.isSomeday,
        });
        this.close();
        if (this.onDone) this.onDone();
        new obsidian.Notice(`Captured "${parsed.title}"`);
      } catch (err) {
        submitting = false;
        submitBtn.disabled = false;
        new obsidian.Notice(`Capture failed: ${err.message || err}`);
      }
    };

    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => input.focus(), 20);
  }
}

class ImportHorizonJsonModal extends obsidian.Modal {
  constructor(app, adapter, onDone) {
    super(app);
    this.adapter = adapter;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("horizon-lifeos-modal");
    contentEl.createEl("h3", { text: "Import Standalone Horizon tasks.json" });
    contentEl.createEl("p", {
      text: "Paste the contents of tasks.json (v1 or v2) below. Run Preview first to check how many projects, area tasks, and archive entries will be imported.",
    });

    const textarea = contentEl.createEl("textarea", {
      placeholder: '{ "schema": 2, "tasks": [ ... ] }',
    });

    const statusEl = contentEl.createEl("p", { text: "" });
    const row = contentEl.createDiv({ cls: "hz-modal-row" });
    const previewBtn = row.createEl("button", { text: "Preview (Dry Run)" });
    const importBtn = row.createEl("button", { text: "Import into Vault", cls: "mod-cta" });
    importBtn.disabled = true;

    previewBtn.addEventListener("click", () => {
      try {
        const res = this.adapter.importStandaloneHorizonJson(textarea.value, { dryRun: true });
        statusEl.textContent = `Ready: ${res.projectsCount} project note(s), ${res.tasksCount} area task(s), ${res.archivedCount} completed item(s).`;
        importBtn.disabled = false;
      } catch (err) {
        statusEl.textContent = `Invalid JSON: ${err.message || err}`;
        importBtn.disabled = true;
      }
    });

    let importing = false;
    importBtn.addEventListener("click", async () => {
      if (importing) return;
      importing = true;
      importBtn.disabled = true;
      previewBtn.disabled = true;
      try {
        const res = await this.adapter.importStandaloneHorizonJson(textarea.value, { dryRun: false });
        this.close();
        if (this.onDone) this.onDone();
        new obsidian.Notice(
          `Imported ${res.projectsCount} projects, ${res.tasksCount} tasks, and ${res.archivedCount} archived items.`
        );
      } catch (err) {
        importing = false;
        importBtn.disabled = false;
        previewBtn.disabled = false;
        statusEl.textContent = `Import failed: ${err.message || err}`;
      }
    });
  }
}

class HorizonSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Horizon LifeOS — GTD + PARA Settings" });

    const s = this.plugin.adapter.getSettings();

    const addText = (name, desc, key, placeholder) => {
      let saveTimer = null;
      new obsidian.Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text.setPlaceholder(placeholder).setValue(String(s[key] || ""));
          const commit = async () => {
            if (saveTimer) {
              window.clearTimeout(saveTimer);
              saveTimer = null;
            }
            const nextVal = text.getValue().trim() || placeholder;
            await this.plugin.adapter.updateSettings({ [key]: nextVal });
            this.plugin.refreshOpenViews();
          };
          text.onChange(() => {
            if (saveTimer) window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(commit, 400);
          });
          if (text.inputEl) {
            text.inputEl.addEventListener("blur", commit);
          }
        });
    };

    addText("Inbox folder", "Landing zone for raw thoughts & iPhone voice captures.", "inboxFolder", "00_Inbox");
    addText("Projects folder", "Multi-step outcomes with deadlines and checkboxes.", "projectsFolder", "10_Projects");
    addText("Areas folder", "One note per ongoing PARA responsibility (Work, Personal, Health, Finance).", "areasFolder", "20_Areas");
    addText("Resources folder", "Reference notes moved out of Inbox.", "resourcesFolder", "30_Resources");
    addText("Archives folder", "Completed projects & append-only Completed Tasks.md log.", "archivesFolder", "40_Archives");
    addText("System folder", "Templates, dashboard, and Anonymized Audit exports.", "systemFolder", "90_System");

    new obsidian.Setting(containerEl)
      .setName("Today Focus cap")
      .setDesc("Maximum focus slots before Horizon prompts a gentle swap (default 3).")
      .addText((text) =>
        text.setValue(String(s.todayCap || 3)).onChange(async (val) => {
          const n = parseInt(val, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 9) {
            await this.plugin.adapter.updateSettings({ todayCap: n });
            this.plugin.refreshOpenViews();
          }
        })
      );

    new obsidian.Setting(containerEl)
      .setName("Default visual horizon (days)")
      .setDesc("Timeline span from 1 to 730 days (default 90).")
      .addText((text) =>
        text.setValue(String(s.horizonDays || 90)).onChange(async (val) => {
          const d = logic.parseHorizonDays(val, 90);
          await this.plugin.adapter.updateSettings({ horizonDays: d });
          this.plugin.refreshOpenViews();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("Inbox capture mode")
      .setDesc("Per-capture files avoid OneDrive/Remotely Save sync collisions between iPhone and PC.")
      .addDropdown((dd) =>
        dd
          .addOption("per-file", "One file per capture (Recommended for Remotely Save)")
          .addOption("quick-inbox", "Append lines to Quick Inbox.md")
          .setValue(s.inboxCaptureMode || "per-file")
          .onChange(async (val) => {
            await this.plugin.adapter.updateSettings({ inboxCaptureMode: val });
          })
      );

    new obsidian.Setting(containerEl)
      .setName("Open Horizon on startup")
      .setDesc("Automatically open the Horizon Desk tab when Obsidian finishes loading.")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(s.openOnStartup)).onChange(async (val) => {
          await this.plugin.adapter.updateSettings({ openOnStartup: val });
        })
      );

    new obsidian.Setting(containerEl)
      .setName("Initialize PARA + GTD folders")
      .setDesc("Creates missing PARA folders & starter Area notes (run on secondary devices only after your first Remotely Save pull).")
      .addButton((btn) =>
        btn.setButtonText("Initialize Missing Folders").onClick(async () => {
          const res = await this.plugin.adapter.scaffoldParaVault({ includeSamples: false });
          this.plugin.refreshOpenViews();
          new obsidian.Notice(`PARA vault ready (${res.createdFiles} file(s) created).`);
        })
      );
  }
}

module.exports = {
  QuickCaptureModal,
  ImportHorizonJsonModal,
  HorizonSettingTab,
};
