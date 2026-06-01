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
    let data: unknown = null;
    try {
      data = await this.loadData();
    } catch (e) {
      // Corrupted data.json (truncated, hand-edited, etc.) — fall back to
      // defaults rather than failing to load the plugin entirely. The user
      // can re-add mappings from scratch; nothing in the vault is touched.
      console.error("Easy Git: failed to read plugin data, using defaults.", e);
      new Notice(
        "Easy Git: could not read saved settings (data.json may be corrupted). Started with defaults.",
        10_000,
      );
      data = null;
    }
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (data as Partial<PluginSettings>) ?? {},
    );
    let dirty = false;
    if (this.migrateLegacyMappings()) dirty = true;
    if (this.healSettings()) dirty = true;
    if (dirty) await this.saveSettings();
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

  /**
   * Idempotent settings self-heal. Runs every load.
   *
   * Fixes drift, mojibake, and silent corruption without losing user data:
   * normalizes paths, clamps numeric ranges, repairs auth state, regenerates
   * missing IDs, tops up the excluded-paths list with safe additions made in
   * newer versions. NEVER deletes a mapping or destination — broken ones
   * stay so the user sees them in settings and can fix or remove them.
   *
   * Returns true if anything was changed (so caller can persist).
   */
  private healSettings(): boolean {
    let dirty = false;
    const s = this.settings;

    // --- Auth state ---
    if (!s.auth || typeof s.auth !== "object") {
      s.auth = { method: "none", token: "" };
      dirty = true;
    }
    if (s.auth.method !== "none" && !s.auth.token) {
      // Half-cleared state — treat as signed out.
      s.auth = { method: "none", token: "" };
      dirty = true;
    }

    // --- Numeric clamps ---
    if (
      typeof s.maxFileSizeBytes !== "number" ||
      !Number.isFinite(s.maxFileSizeBytes) ||
      s.maxFileSizeBytes < 1024
    ) {
      s.maxFileSizeBytes = DEFAULT_SETTINGS.maxFileSizeBytes;
      dirty = true;
    }
    if (
      s.backupRetentionDays !== undefined &&
      (typeof s.backupRetentionDays !== "number" ||
        !Number.isFinite(s.backupRetentionDays) ||
        s.backupRetentionDays < 0)
    ) {
      s.backupRetentionDays = 0;
      dirty = true;
    }

    // --- Excluded paths: keep user entries; ensure the safety set is in. ---
    const safeExcludes = [
      ".easy-git-backup/**",
      ".DS_Store",
      ".trash/**",
      ".obsidian/**",
      ".git/**",
    ];
    if (!Array.isArray(s.excludedPaths)) {
      s.excludedPaths = [...DEFAULT_SETTINGS.excludedPaths];
      dirty = true;
    }
    for (const safe of safeExcludes) {
      if (!s.excludedPaths.includes(safe)) {
        s.excludedPaths.push(safe);
        dirty = true;
      }
    }

    // --- Mappings ---
    if (!Array.isArray(s.mappings)) {
      s.mappings = [];
      dirty = true;
    }
    for (const m of s.mappings) {
      if (!m.id) {
        m.id = makeId();
        dirty = true;
      }
      if (typeof m.name !== "string" || !m.name.trim()) {
        m.name = "Untitled mapping";
        dirty = true;
      }
      // Normalize vault folder: strip leading/trailing slashes, treat "/" as "".
      if (typeof m.vaultFolder === "string") {
        const norm = m.vaultFolder.trim().replace(/^\/+|\/+$/g, "");
        if (norm !== m.vaultFolder) {
          m.vaultFolder = norm;
          dirty = true;
        }
      } else {
        m.vaultFolder = "";
        dirty = true;
      }
      // Ensure direction is one of the allowed values.
      if (
        m.direction !== "push" &&
        m.direction !== "pull" &&
        m.direction !== "both"
      ) {
        m.direction = "both";
        dirty = true;
      }
      // Clamp autoMode shape.
      if (!m.autoMode || typeof m.autoMode !== "object") {
        m.autoMode = { kind: "off" };
        dirty = true;
      } else if (m.autoMode.kind === "interval") {
        if (
          typeof m.autoMode.minutes !== "number" ||
          !Number.isFinite(m.autoMode.minutes) ||
          m.autoMode.minutes < 1
        ) {
          m.autoMode.minutes = 15;
          dirty = true;
        }
      } else if (m.autoMode.kind === "onSave") {
        if (
          typeof m.autoMode.debounceMs !== "number" ||
          !Number.isFinite(m.autoMode.debounceMs) ||
          m.autoMode.debounceMs < 500
        ) {
          m.autoMode.debounceMs = 10_000;
          dirty = true;
        }
      } else if (
        m.autoMode.kind !== "off" &&
        m.autoMode.kind !== "startup"
      ) {
        m.autoMode = { kind: "off" };
        dirty = true;
      }
      // Destinations.
      if (!Array.isArray(m.destinations)) {
        m.destinations = [];
        dirty = true;
      }
      const seenIds = new Set<string>();
      for (const d of m.destinations) {
        if (!d.id || seenIds.has(d.id)) {
          d.id = makeId();
          dirty = true;
        }
        seenIds.add(d.id);
        for (const field of ["repoOwner", "repoName", "branch", "remoteFolder"] as const) {
          if (typeof d[field] !== "string") {
            d[field] = "";
            dirty = true;
          }
        }
        // Normalize remoteFolder: strip leading/trailing slashes.
        const remoteNorm = d.remoteFolder.replace(/^\/+|\/+$/g, "");
        if (remoteNorm !== d.remoteFolder) {
          d.remoteFolder = remoteNorm;
          dirty = true;
        }
      }
    }

    return dirty;
  }

  /**
   * Returns true when this mapping isn't safe to sync as-is. Used by the
   * settings UI to surface a warning instead of letting the user click Sync
   * and get a cryptic 404. NEVER auto-deletes the mapping — the user fixes
   * or removes it themselves.
   */
  mappingHealth(m: FolderMapping): { ok: true } | { ok: false; reason: string } {
    if (!m.destinations || m.destinations.length === 0) {
      return { ok: false, reason: "No destinations configured. Edit to add one." };
    }
    const incomplete = m.destinations.find(
      (d) => !d.repoOwner || !d.repoName || !d.branch,
    );
    if (incomplete) {
      return {
        ok: false,
        reason: `Destination missing repo or branch. Edit to fix.`,
      };
    }
    // Vault folder check: empty string means "whole vault" (valid). A
    // non-empty path must resolve to an existing folder.
    if (m.vaultFolder && !this.app.vault.getFolderByPath(m.vaultFolder)) {
      // Try a case-insensitive walk before giving up — disk renames can
      // shift case without renaming the folder object.
      const lc = m.vaultFolder.toLowerCase();
      const match = this.app.vault
        .getAllFolders(true)
        .find((f) => f.path.toLowerCase() === lc);
      if (!match) {
        return {
          ok: false,
          reason: `Vault folder "${m.vaultFolder}" not found. Edit to pick a new one.`,
        };
      }
    }
    return { ok: true };
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
        if (
          result.excalidrawMissingCompanion &&
          result.excalidrawMissingCompanion > 0 &&
          this.settings.showNotifications
        ) {
          new Notice(
            `Easy Git (${mapping.name}${label}): ${result.excalidrawMissingCompanion} Excalidraw drawing(s) have no .svg/.png companion. Enable "Auto-export SVG" in the Excalidraw plugin to render them on GitHub.`,
            8000,
          );
        }
        if (
          result.autoResolvedConflicts &&
          result.autoResolvedConflicts > 0 &&
          this.settings.showNotifications
        ) {
          new Notice(
            `Easy Git (${mapping.name}${label}): ${result.autoResolvedConflicts} conflict(s) auto-resolved — local was newer than last sync.`,
            6000,
          );
        }
        if (
          result.mergedConflicts &&
          result.mergedConflicts > 0 &&
          this.settings.showNotifications
        ) {
          new Notice(
            `Easy Git (${mapping.name}${label}): ${result.mergedConflicts} conflict(s) merged automatically via 3-way diff.`,
            6000,
          );
        }
        if (
          result.backupsCreated &&
          result.backupsCreated > 0 &&
          this.settings.showNotifications
        ) {
          new Notice(
            `Easy Git (${mapping.name}${label}): backed up ${result.backupsCreated} local file(s) to ${result.backupFolder ?? ".easy-git-backup/"} before overwrite.`,
            8000,
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
