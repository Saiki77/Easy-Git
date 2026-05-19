import {
  EventRef,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  debounce,
} from "obsidian";
import {
  ConflictEntry,
  DEFAULT_SETTINGS,
  FolderMapping,
  PluginSettings,
} from "./types";
import { EasyGitSettingTab } from "./settings";
import { SyncEngine } from "./sync/engine";
import { ConflictResolutionModal } from "./ui/conflict-modal";
import { MappingNameSuggest } from "./ui/pickers";
import { StatusBarIndicator, StatusState } from "./ui/status-bar";

type SyncTrigger = "manual" | "interval" | "startup" | "on-save" | "command";

interface MappingDebouncer {
  trigger: () => void;
  cancel: () => void;
}

export default class EasyGitPlugin extends Plugin {
  settings!: PluginSettings;
  private engine!: SyncEngine;
  private intervalHandles: Map<string, number> = new Map();
  private onSaveDebouncers: Map<string, MappingDebouncer> = new Map();
  private modifyListener?: EventRef;
  private createListener?: EventRef;
  private deleteListener?: EventRef;
  private renameListener?: EventRef;
  private syncing: Set<string> = new Set();
  private pendingAfterSync: Set<string> = new Set();
  private statusBar?: StatusBarIndicator;
  private settingsTab?: EasyGitSettingTab;

  /** Whether a sync run for this mapping is currently in flight. */
  isSyncing(mappingId: string): boolean {
    return this.syncing.has(mappingId);
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.engine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      saveSettings: () => this.saveData(this.settings),
      resolveConflicts: (mapping, conflicts) => this.openConflictModal(mapping, conflicts),
    });

    this.settingsTab = new EasyGitSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addRibbonIcon("git-branch", "Easy Git: sync menu", (evt: MouseEvent) => {
      this.openSyncMenu(evt);
    });

    this.addCommand({
      id: "easy-git-sync-all",
      name: "Sync all mappings",
      callback: () => void this.syncAll("command"),
    });

    this.addCommand({
      id: "easy-git-sync-mapping",
      name: "Sync mapping…",
      callback: () => {
        this.openMappingPicker("Sync mapping…", (m) =>
          void this.syncMapping(m.id, "command"),
        );
      },
    });

    this.addCommand({
      id: "easy-git-push-mapping",
      name: "Push mapping…",
      callback: () => {
        this.openMappingPicker("Push mapping…", (m) =>
          void this.runDirectionalOnce(m, "push"),
        );
      },
    });

    this.addCommand({
      id: "easy-git-pull-mapping",
      name: "Pull mapping…",
      callback: () => {
        this.openMappingPicker("Pull mapping…", (m) =>
          void this.runDirectionalOnce(m, "pull"),
        );
      },
    });

    this.addCommand({
      id: "easy-git-open-settings",
      name: "Open settings",
      callback: () => {
        // @ts-expect-error setting is private but accessible at runtime
        this.app.setting.open();
        // @ts-expect-error setting is private but accessible at runtime
        this.app.setting.openTabById(this.manifest.id);
      },
    });

    // Status bar indicator — shows aggregate sync state, clicks to open settings.
    this.statusBar = new StatusBarIndicator(
      this.addStatusBarItem(),
      () => this.computeStatusState(),
      () => this.openEasyGitSettings(),
    );
    this.statusBar.startTicker(this);

    // Auto-fix folder renames: if the user renames or moves a folder that
    // matches (or contains) a mapping's vaultFolder, update the mapping
    // automatically. Without this, the next sync would see the folder missing
    // and abort. This listener is always-on (independent of auto-sync mode).
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFolder) {
          this.handleFolderRename(oldPath, file.path);
        }
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshAutoSyncWiring();
      this.runStartupSyncs();
      this.statusBar?.refresh();
    });
  }

  private computeStatusState(): StatusState {
    const mappings = this.settings?.mappings ?? [];
    const anySyncing = this.syncing.size > 0;
    const anyErrored = mappings.some((m) => !!m.lastSyncError);
    let mostRecentSync: number | undefined;
    for (const m of mappings) {
      if (m.lastSyncAt && (!mostRecentSync || m.lastSyncAt > mostRecentSync)) {
        mostRecentSync = m.lastSyncAt;
      }
    }
    return {
      hasMappings: mappings.length > 0,
      anySyncing,
      anyErrored,
      mostRecentSync,
    };
  }

  private openEasyGitSettings(): void {
    // @ts-expect-error setting is private but accessible at runtime
    this.app.setting.open();
    // @ts-expect-error setting is private but accessible at runtime
    this.app.setting.openTabById(this.manifest.id);
  }

  /**
   * Update any mapping whose vaultFolder matches the renamed folder or sits
   * inside it. Triggered by Obsidian's rename event for both renames and
   * drag-moves. Saves settings + refreshes the status bar.
   */
  private handleFolderRename(oldPath: string, newPath: string): void {
    if (!oldPath || oldPath === newPath) return;
    let changed = 0;
    for (const mapping of this.settings.mappings) {
      if (mapping.vaultFolder === oldPath) {
        mapping.vaultFolder = newPath;
        changed += 1;
      } else if (mapping.vaultFolder.startsWith(oldPath + "/")) {
        // The renamed folder is a parent of the mapping's folder.
        mapping.vaultFolder = newPath + mapping.vaultFolder.slice(oldPath.length);
        changed += 1;
      }
    }
    if (changed > 0) {
      void this.saveSettings();
      if (this.settings.showNotifications) {
        const label = changed === 1 ? "mapping" : "mappings";
        new Notice(`Easy Git: updated ${changed} ${label} for folder rename.`);
      }
      this.refreshAutoSyncWiring();
      this.statusBar?.refresh();
    }
  }

  onunload(): void {
    for (const handle of this.intervalHandles.values()) window.clearInterval(handle);
    this.intervalHandles.clear();
    for (const d of this.onSaveDebouncers.values()) d.cancel();
    this.onSaveDebouncers.clear();
    this.unregisterVaultListeners();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshAutoSyncWiring(): void {
    for (const handle of this.intervalHandles.values()) window.clearInterval(handle);
    this.intervalHandles.clear();
    for (const d of this.onSaveDebouncers.values()) d.cancel();
    this.onSaveDebouncers.clear();
    this.unregisterVaultListeners();

    let needVaultListeners = false;

    for (const mapping of this.settings.mappings) {
      const auto = mapping.autoMode;
      if (auto.kind === "interval") {
        const ms = Math.max(1, auto.minutes) * 60_000;
        const handle = window.setInterval(() => {
          void this.syncMapping(mapping.id, "interval");
        }, ms);
        this.intervalHandles.set(mapping.id, handle);
        this.registerInterval(handle);
      } else if (auto.kind === "onSave") {
        needVaultListeners = true;
        const debounced = debounce(
          () => void this.syncMapping(mapping.id, "on-save"),
          auto.debounceMs,
          true,
        );
        this.onSaveDebouncers.set(mapping.id, {
          trigger: () => debounced(),
          cancel: () => debounced.cancel(),
        });
      }
    }

    if (needVaultListeners) {
      this.registerVaultListeners();
    }

    this.statusBar?.refresh();
  }

  private runStartupSyncs(): void {
    for (const mapping of this.settings.mappings) {
      if (mapping.autoMode.kind === "startup") {
        void this.syncMapping(mapping.id, "startup");
      }
    }
  }

  private registerVaultListeners(): void {
    const fire = (file: TAbstractFile) => this.maybeFireOnSave(file);
    this.modifyListener = this.app.vault.on("modify", fire);
    this.createListener = this.app.vault.on("create", fire);
    this.deleteListener = this.app.vault.on("delete", fire);
    this.renameListener = this.app.vault.on("rename", (file) => fire(file));
    this.registerEvent(this.modifyListener);
    this.registerEvent(this.createListener);
    this.registerEvent(this.deleteListener);
    this.registerEvent(this.renameListener);
  }

  private unregisterVaultListeners(): void {
    if (this.modifyListener) this.app.vault.offref(this.modifyListener);
    if (this.createListener) this.app.vault.offref(this.createListener);
    if (this.deleteListener) this.app.vault.offref(this.deleteListener);
    if (this.renameListener) this.app.vault.offref(this.renameListener);
    this.modifyListener = undefined;
    this.createListener = undefined;
    this.deleteListener = undefined;
    this.renameListener = undefined;
  }

  private maybeFireOnSave(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    for (const mapping of this.settings.mappings) {
      if (mapping.autoMode.kind !== "onSave") continue;
      if (!isPathInside(file.path, mapping.vaultFolder)) continue;
      const debouncer = this.onSaveDebouncers.get(mapping.id);
      if (debouncer) debouncer.trigger();
    }
  }

  async syncAll(trigger: SyncTrigger): Promise<void> {
    for (const m of this.settings.mappings) {
      await this.syncMapping(m.id, trigger);
    }
  }

  async syncMapping(id: string, trigger: SyncTrigger): Promise<void> {
    const mapping = this.settings.mappings.find((m) => m.id === id);
    if (!mapping) return;
    if (this.syncing.has(id)) {
      this.pendingAfterSync.add(id);
      return;
    }
    this.syncing.add(id);
    this.statusBar?.refresh();
    this.settingsTab?.refreshSyncStates();
    try {
      if (this.settings.debugLogging) {
        console.log(`[Easy Git] sync start (${trigger}) — ${mapping.name}`);
      }
      const result = await this.engine.syncMapping(mapping);
      if (this.settings.debugLogging) {
        console.log(`[Easy Git] sync result`, result);
      }
      if (!result.ok && result.error) {
        mapping.lastSyncError = result.error;
        await this.saveSettings();
        if (this.settings.showNotifications) {
          new Notice(`Easy Git (${mapping.name}): ${result.error}`);
        }
      } else if (result.ok) {
        if (this.settings.showNotifications) {
          const total = result.added + result.modified + result.deleted;
          const summary =
            total === 0
              ? "up to date"
              : `${result.added}+ ${result.modified}~ ${result.deleted}-`;
          new Notice(`Easy Git (${mapping.name}): ${summary}`);
        }
        if (result.skippedLarge && result.skippedLarge.length > 0) {
          new Notice(
            `Easy Git (${mapping.name}): skipped ${result.skippedLarge.length} file(s) over size limit.`,
          );
        }
        if (
          result.unresolvedWikilinks &&
          result.unresolvedWikilinks > 0 &&
          this.settings.showNotifications
        ) {
          new Notice(
            `Easy Git (${mapping.name}): ${result.unresolvedWikilinks} unresolved wikilink(s) left untouched.`,
          );
        }
      }
    } finally {
      this.syncing.delete(id);
      this.statusBar?.refresh();
      this.settingsTab?.refreshSyncStates();
      if (this.pendingAfterSync.has(id)) {
        this.pendingAfterSync.delete(id);
        // schedule another run on a microtask so we don't recurse the stack
        setTimeout(() => void this.syncMapping(id, "on-save"), 0);
      }
    }
  }

  private async runDirectionalOnce(
    mapping: FolderMapping,
    direction: "push" | "pull",
  ): Promise<void> {
    const original = mapping.direction;
    mapping.direction = direction;
    try {
      await this.syncMapping(mapping.id, "command");
    } finally {
      mapping.direction = original;
      await this.saveSettings();
    }
  }

  private openMappingPicker(
    placeholder: string,
    onChoose: (mapping: FolderMapping) => void,
  ): void {
    if (this.settings.mappings.length === 0) {
      new Notice("Easy Git: no mappings configured yet.");
      return;
    }
    new MappingNameSuggest(this.app, this.settings.mappings, placeholder, onChoose).open();
  }

  private openSyncMenu(evt: MouseEvent): void {
    const menu = new Menu();
    if (this.settings.mappings.length === 0) {
      menu.addItem((i) =>
        i
          .setTitle("No mappings configured")
          .setIcon("info")
          .setDisabled(true),
      );
    } else {
      menu.addItem((i) =>
        i
          .setTitle("Sync all")
          .setIcon("refresh-cw")
          .onClick(() => void this.syncAll("manual")),
      );
      menu.addSeparator();
      for (const m of this.settings.mappings) {
        menu.addItem((i) =>
          i
            .setTitle(`Sync: ${m.name}`)
            .setIcon(iconForDirection(m.direction))
            .onClick(() => void this.syncMapping(m.id, "manual")),
        );
      }
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Open Easy Git settings")
        .setIcon("settings")
        .onClick(() => {
          // @ts-expect-error setting is private but accessible at runtime
          this.app.setting.open();
          // @ts-expect-error setting is private but accessible at runtime
          this.app.setting.openTabById(this.manifest.id);
        }),
    );
    menu.showAtMouseEvent(evt);
  }

  private async openConflictModal(
    mapping: FolderMapping,
    conflicts: ConflictEntry[],
  ): Promise<ConflictEntry[] | null> {
    return new Promise((resolve) => {
      new ConflictResolutionModal(this.app, mapping.name, conflicts, (result) => {
        if (!result.applied) {
          resolve(null);
          return;
        }
        resolve(result.resolutions);
      }).open();
    });
  }
}

function iconForDirection(d: FolderMapping["direction"]): string {
  if (d === "push") return "arrow-up";
  if (d === "pull") return "arrow-down";
  return "arrow-up-down";
}

function isPathInside(filePath: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  if (!f) return true;
  return filePath === f || filePath.startsWith(f + "/");
}
