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
  MappingDestination,
  PluginSettings,
  SYNC_LOG_MAX,
  SyncLogEntry,
  SyncResult,
  makeId,
} from "./types";
import { destinationLabel } from "./sync/engine";
import { SyncLogModal } from "./ui/sync-log-modal";
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
      resolveConflicts: (mapping, destination, conflicts) =>
        this.openConflictModal(mapping, destination, conflicts),
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

    this.addCommand({
      id: "easy-git-show-log",
      name: "Show sync log",
      callback: () => this.openSyncLog(),
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
    let anyErrored = false;
    let mostRecentSync: number | undefined;
    for (const m of mappings) {
      for (const d of m.destinations ?? []) {
        if (d.lastSyncError) anyErrored = true;
        if (d.lastSyncAt && (!mostRecentSync || d.lastSyncAt > mostRecentSync)) {
          mostRecentSync = d.lastSyncAt;
        }
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
    if (this.migrateLegacyMappings()) {
      await this.saveSettings();
    }
  }

  /**
   * One-time migration from the pre-0.5 single-destination shape to the
   * multi-destination shape. Returns true if any mapping was rewritten.
   */
  private migrateLegacyMappings(): boolean {
    let changed = false;
    for (const m of this.settings.mappings) {
      const legacy = m as unknown as {
        repoOwner?: string;
        repoName?: string;
        branch?: string;
        remoteFolder?: string;
        lastSyncState?: import("./types").LastSyncState;
        lastSyncAt?: number;
        lastSyncError?: string;
        destinations?: MappingDestination[];
      };
      if (Array.isArray(legacy.destinations) && legacy.destinations.length > 0) {
        continue;
      }
      const dest: MappingDestination = {
        id: makeId(),
        repoOwner: legacy.repoOwner ?? "",
        repoName: legacy.repoName ?? "",
        branch: legacy.branch ?? "",
        remoteFolder: legacy.remoteFolder ?? "",
        lastSyncState: legacy.lastSyncState,
        lastSyncAt: legacy.lastSyncAt,
        lastSyncError: legacy.lastSyncError,
      };
      m.destinations = [dest];
      delete legacy.repoOwner;
      delete legacy.repoName;
      delete legacy.branch;
      delete legacy.remoteFolder;
      delete legacy.lastSyncState;
      delete legacy.lastSyncAt;
      delete legacy.lastSyncError;
      changed = true;
    }
    return changed;
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
      const results = await this.engine.syncMapping(mapping);
      if (this.settings.debugLogging) {
        console.log(`[Easy Git] sync results`, results);
      }
      for (const r of results) this.recordSyncResult(mapping, r, trigger);
      await this.saveSettings();
      this.reportSyncResults(mapping, results);
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

  openSyncLog(): void {
    new SyncLogModal(this.app, {
      entries: this.settings.syncLog ?? [],
      onClear: async () => {
        this.settings.syncLog = [];
        await this.saveSettings();
      },
    }).open();
  }

  /**
   * Append a single sync run to the persistent log, capped at SYNC_LOG_MAX.
   */
  private recordSyncResult(
    mapping: FolderMapping,
    result: SyncResult,
    trigger: string,
  ): void {
    const dest = mapping.destinations.find((d) => d.id === result.destinationId);
    const entry: SyncLogEntry = {
      timestamp: Date.now(),
      mappingId: mapping.id,
      mappingName: mapping.name,
      destinationId: result.destinationId,
      destinationLabel: dest ? destinationLabel(dest) : "(unknown)",
      trigger,
      ok: result.ok,
      added: result.added,
      modified: result.modified,
      deleted: result.deleted,
      conflicts: result.conflicts.length,
      filesTouched: result.added + result.modified + result.deleted,
      changedPaths: result.changedPaths,
      error: result.error,
      durationMs: result.durationMs,
    };
    const log = this.settings.syncLog ?? [];
    log.unshift(entry);
    if (log.length > SYNC_LOG_MAX) log.length = SYNC_LOG_MAX;
    this.settings.syncLog = log;
  }

  /**
   * Surface one Notice per destination result. With one destination, this
   * reads exactly like the v0.4 flow. With multiple, the destination label
   * disambiguates which target each line refers to.
   */
  private reportSyncResults(
    mapping: FolderMapping,
    results: SyncResult[],
  ): void {
    const showLabel = mapping.destinations.length > 1;
    for (const result of results) {
      const dest = mapping.destinations.find((d) => d.id === result.destinationId);
      const label = showLabel && dest ? ` → ${destinationLabel(dest)}` : "";
      if (!result.ok && result.error) {
        if (this.settings.showNotifications) {
          new Notice(`Easy Git (${mapping.name}${label}): ${result.error}`);
        }
      } else if (result.ok) {
        if (this.settings.showNotifications) {
          const total = result.added + result.modified + result.deleted;
          const summary =
            total === 0
              ? "up to date"
              : `${result.added}+ ${result.modified}~ ${result.deleted}-`;
          new Notice(`Easy Git (${mapping.name}${label}): ${summary}`);
        }
        if (result.skippedLarge && result.skippedLarge.length > 0 && this.settings.showNotifications) {
          new Notice(
            `Easy Git (${mapping.name}${label}): skipped ${result.skippedLarge.length} file(s) over size limit.`,
          );
        }
        if (
          result.unresolvedWikilinks &&
          result.unresolvedWikilinks > 0 &&
          this.settings.showNotifications
        ) {
          new Notice(
            `Easy Git (${mapping.name}${label}): ${result.unresolvedWikilinks} unresolved wikilink(s) left untouched.`,
          );
        }
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
    destination: MappingDestination,
    conflicts: ConflictEntry[],
  ): Promise<ConflictEntry[] | null> {
    const title =
      mapping.destinations.length > 1
        ? `${mapping.name} → ${destinationLabel(destination)}`
        : mapping.name;
    return new Promise((resolve) => {
      new ConflictResolutionModal(this.app, title, conflicts, (result) => {
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
