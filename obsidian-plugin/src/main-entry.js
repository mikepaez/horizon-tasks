/**
 * main-entry.js — Horizon LifeOS Obsidian Plugin Entrypoint
 */

const obsidian = require("obsidian");
const logic = require("./logic-core");
const codec = require("./markdown-codec");
const adapterMod = require("./vault-adapter");
const viewMod = require("./horizon-view");
const settingsMod = require("./settings");

class HorizonLifeOSPlugin extends obsidian.Plugin {
  async onload() {
    this.adapter = new adapterMod.VaultAdapter(this);
    await this.adapter.loadSidecar();

    this.refreshTimer = null;
    this.adapter.onRefreshNeeded = () => this.scheduleRefresh(50);

    this.registerView(viewMod.VIEW_TYPE_HORIZON, (leaf) => new viewMod.HorizonItemView(leaf, this));

    this.addRibbonIcon("calendar-range", "Open Horizon Desk", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-horizon-desk",
      name: "Open Horizon Desk",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "quick-capture-inbox",
      name: "Quick Capture to Inbox / Horizon",
      callback: () => {
        new settingsMod.QuickCaptureModal(this.app, this.adapter, () => this.scheduleRefresh(30)).open();
      },
    });

    this.addCommand({
      id: "start-morning-checkin",
      name: "Start Morning Check-in",
      callback: async () => {
        const view = await this.activateView();
        if (view) view.startCheckinCards();
      },
    });

    this.addCommand({
      id: "start-weekly-review",
      name: "Start GTD Weekly Review",
      callback: async () => {
        const view = await this.activateView();
        if (view) view.startWeeklyReviewCards();
      },
    });

    this.addCommand({
      id: "export-anonymized-audit",
      name: "Export Anonymized GTD + PARA Audit",
      callback: async () => {
        const res = await this.adapter.exportAnonymizedAudit();
        new obsidian.Notice(
          `Saved anonymized audit (${res.summary.totalItems} items) to ${res.mdPath}`
        );
      },
    });

    this.addCommand({
      id: "import-horizon-json",
      name: "Import Standalone Horizon tasks.json",
      callback: () => {
        new settingsMod.ImportHorizonJsonModal(this.app, this.adapter, () => this.scheduleRefresh(30)).open();
      },
    });

    this.addCommand({
      id: "initialize-para-vault",
      name: "Initialize PARA + GTD Vault Folders",
      callback: async () => {
        const res = await this.adapter.scaffoldParaVault({ includeSamples: false });
        this.scheduleRefresh(30);
        new obsidian.Notice(`PARA + GTD vault folders ready (${res.createdFiles} file(s) created).`);
      },
    });

    this.addSettingTab(new settingsMod.HorizonSettingTab(this.app, this));

    // Register debounced metadataCache & vault watchers only after initial layout
    this.app.workspace.onLayoutReady(() => {
      const watchFolders = () => {
        const f = this.adapter.getFolders();
        return [f.inbox, f.projects, f.areas, f.archives];
      };
      const isWatchedPath = (path) => {
        if (!path || !path.endsWith(".md")) return false;
        return watchFolders().some((folder) => path.startsWith(`${folder}/`));
      };

      this.registerEvent(
        this.app.metadataCache.on("changed", (file) => {
          if (file && isWatchedPath(file.path)) this.scheduleRefresh(250);
        })
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file && isWatchedPath(file.path)) this.scheduleRefresh(250);
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file && isWatchedPath(file.path)) this.scheduleRefresh(250);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if ((file && isWatchedPath(file.path)) || isWatchedPath(oldPath)) {
            this.scheduleRefresh(250);
          }
        })
      );

      if (this.adapter.getSettings().openOnStartup) {
        this.activateView();
      }
    });

    // Midnight rollover refresh via managed interval
    this.registerInterval(
      window.setInterval(() => {
        this.refreshOpenViews({ dateCheckOnly: true });
      }, 60000)
    );
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  scheduleRefresh(delayMs = 250) {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshOpenViews();
    }, delayMs);
  }

  refreshOpenViews(opts = {}) {
    const leaves = this.app.workspace.getLeavesOfType(viewMod.VIEW_TYPE_HORIZON);
    for (const leaf of leaves) {
      if (leaf.view && typeof leaf.view.handleExternalRefresh === "function") {
        leaf.view.handleExternalRefresh(opts);
      }
    }
  }

  async onExternalSettingsChange() {
    await this.adapter.onExternalSettingsChange();
    this.refreshOpenViews();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(viewMod.VIEW_TYPE_HORIZON)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: viewMod.VIEW_TYPE_HORIZON, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof viewMod.HorizonItemView ? leaf.view : null;
  }
}

HorizonLifeOSPlugin.__internals = {
  logic,
  codec,
  adapterMod,
  viewMod,
  settingsMod,
};

module.exports = HorizonLifeOSPlugin;
