import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type EasyGitPlugin from "./main";
import { FolderMapping } from "./types";
import { EditMappingModal } from "./ui/mapping-modal";
import { DeviceFlowModal } from "./ui/device-flow-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { GitHubClient } from "./github/client";
import {
  describeAuth,
  describeAuthError,
  getAuthenticatedUser,
} from "./github/auth";

interface MappingRowRefs {
  syncBtn: HTMLButtonElement;
  statusEl: HTMLElement;
}

export class EasyGitSettingTab extends PluginSettingTab {
  private plugin: EasyGitPlugin;
  // Live references to per-mapping row elements so we can update the Sync
  // button + status text from outside this class (e.g. when the plugin
  // reports a sync state change) without re-rendering the whole tab.
  private mappingRowRefs: Map<string, MappingRowRefs> = new Map();

  constructor(app: App, plugin: EasyGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.mappingRowRefs.clear();

    this.renderAuthSection(containerEl);
    this.renderMappingsSection(containerEl);
    this.renderOptionsSection(containerEl);
  }

  /**
   * Update the Sync button + status text for every visible mapping row to
   * reflect current sync state. Called by main.ts whenever a sync starts or
   * ends, so the buttons stay accurate across settings open/close cycles.
   */
  refreshSyncStates(): void {
    for (const [id, refs] of this.mappingRowRefs) {
      const mapping = this.plugin.settings.mappings.find((m) => m.id === id);
      if (!mapping) continue;
      const isSyncing = this.plugin.isSyncing(id);
      const anyErrored = (mapping.destinations ?? []).some((d) => !!d.lastSyncError);
      refs.syncBtn.disabled = isSyncing;
      refs.syncBtn.setText(isSyncing ? "Syncing…" : "Sync");
      refs.statusEl.setText(statusText(mapping, isSyncing));
      refs.statusEl.toggleClass("is-syncing", isSyncing);
      refs.statusEl.toggleClass("is-error", !isSyncing && anyErrored);
    }
  }

  private renderAuthSection(parent: HTMLElement): void {
    new Setting(parent).setName("GitHub authentication").setHeading();

    const status = parent.createDiv({
      attr: { style: "margin-bottom: 0.75rem; color: var(--text-muted);" },
      text: describeAuth(this.plugin.settings.auth),
    });

    new Setting(parent)
      .setName("Personal access token")
      .setDesc(
        "Paste a token with the `repo` scope. Create one at github.com/settings/tokens (fine-grained tokens with content read/write also work).",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("ghp_...")
          .setValue(
            this.plugin.settings.auth.method === "pat"
              ? this.plugin.settings.auth.token
              : "",
          )
          .onChange(async (v) => {
            this.plugin.settings.auth = {
              method: v ? "pat" : "none",
              token: v,
              username: undefined,
            };
            await this.plugin.saveSettings();
            status.setText(describeAuth(this.plugin.settings.auth));
          });
      });

    new Setting(parent)
      .setName("Sign in with GitHub (Device Flow)")
      .setDesc(
        "Open a one-time code in your browser. Easier than copying a PAT. Requires the plugin's OAuth App client_id to be configured.",
      )
      .addButton((b) =>
        b
          .setButtonText("Sign in")
          .onClick(() => {
            const modal = new DeviceFlowModal(this.app, {
              onSuccess: async ({ token, scope }) => {
                this.plugin.settings.auth = {
                  method: "oauth",
                  token,
                  scopes: scope ? scope.split(",") : undefined,
                };
                await this.plugin.saveSettings();
                status.setText(describeAuth(this.plugin.settings.auth));
                new Notice("Easy Git: signed in with GitHub.");
                this.display();
              },
            });
            modal.open();
          }),
      );

    new Setting(parent)
      .setName("Test connection")
      .setDesc("Verifies the current token works.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          if (!this.plugin.settings.auth.token) {
            new Notice("Easy Git: no token configured.");
            return;
          }
          try {
            const client = new GitHubClient({
              token: this.plugin.settings.auth.token,
            });
            const user = await getAuthenticatedUser(client);
            this.plugin.settings.auth.username = user.login;
            await this.plugin.saveSettings();
            status.setText(describeAuth(this.plugin.settings.auth));
            new Notice(`Easy Git: connected as ${user.login}.`);
          } catch (e) {
            new Notice("Easy Git: " + describeAuthError(e));
          }
        }),
      );

    new Setting(parent)
      .setName("Clear credentials")
      .setDesc("Removes the stored token.")
      .addButton((b) =>
        b
          .setWarning()
          .setButtonText("Clear")
          .onClick(async () => {
            this.plugin.settings.auth = { method: "none", token: "" };
            await this.plugin.saveSettings();
            status.setText(describeAuth(this.plugin.settings.auth));
            new Notice("Easy Git: credentials cleared.");
            this.display();
          }),
      );
  }

  private renderMappingsSection(parent: HTMLElement): void {
    new Setting(parent).setName("Folder mappings").setHeading();
    parent.createEl("p", {
      attr: { style: "margin-top:-0.5rem; color: var(--text-muted);" },
      text: "Each mapping pairs a vault folder with a folder inside a GitHub repo.",
    });

    const list = parent.createDiv();
    if (this.plugin.settings.mappings.length === 0) {
      list.createEl("p", {
        text: "No mappings yet. Click the button below to add one.",
        attr: { style: "color: var(--text-muted);" },
      });
    } else {
      for (const m of this.plugin.settings.mappings) {
        this.renderMappingRow(list, m);
      }
    }

    new Setting(parent).addButton((b) =>
      b
        .setButtonText("+ Add mapping")
        .setCta()
        .onClick(() => this.openMappingModal()),
    );
  }

  private renderMappingRow(parent: HTMLElement, mapping: FolderMapping): void {
    const row = parent.createDiv({ cls: "easy-git-mapping-row" });
    const info = row.createDiv({ cls: "easy-git-mapping-info" });
    info.createDiv({ cls: "easy-git-mapping-name", text: mapping.name });
    info.createDiv({
      cls: "easy-git-mapping-summary",
      text: summarizeMapping(mapping),
    });
    const isSyncing = this.plugin.isSyncing(mapping.id);
    const anyErrored = (mapping.destinations ?? []).some((d) => !!d.lastSyncError);
    const statusEl = info.createDiv({
      cls: "easy-git-mapping-status",
      text: statusText(mapping, isSyncing),
    });
    if (isSyncing) statusEl.addClass("is-syncing");
    else if (anyErrored) statusEl.addClass("is-error");

    const actions = row.createDiv({ cls: "easy-git-mapping-actions" });
    actions.createSpan({
      cls: "easy-git-direction-icon",
      text: directionIcon(mapping.direction),
    });

    const syncBtn = actions.createEl("button", {
      text: isSyncing ? "Syncing…" : "Sync",
    });
    syncBtn.disabled = isSyncing;
    syncBtn.onclick = async () => {
      if (this.plugin.isSyncing(mapping.id)) return;
      // Visual feedback immediately; plugin.syncMapping will fire
      // refreshSyncStates() which keeps us in sync from here on.
      syncBtn.disabled = true;
      syncBtn.setText("Syncing…");
      await this.plugin.syncMapping(mapping.id, "manual");
    };

    this.mappingRowRefs.set(mapping.id, { syncBtn, statusEl });

    const editBtn = actions.createEl("button", { text: "Edit" });
    editBtn.onclick = () => this.openMappingModal(mapping);

    const deleteBtn = actions.createEl("button", { text: "Delete" });
    deleteBtn.addClass("mod-warning");
    deleteBtn.onclick = () => {
      new ConfirmModal(this.app, {
        title: "Delete mapping",
        message: `Delete mapping "${mapping.name}"? Your local and remote files are not touched.`,
        confirmText: "Delete",
        destructive: true,
        onConfirm: async () => {
          this.plugin.settings.mappings = this.plugin.settings.mappings.filter(
            (m) => m.id !== mapping.id,
          );
          await this.plugin.saveSettings();
          this.plugin.refreshAutoSyncWiring();
          this.display();
        },
      }).open();
    };
  }

  private openMappingModal(existing?: FolderMapping): void {
    new EditMappingModal(this.app, {
      initial: existing,
      auth: this.plugin.settings.auth,
      onSave: async (m) => {
        const idx = this.plugin.settings.mappings.findIndex((x) => x.id === m.id);
        if (idx >= 0) {
          this.plugin.settings.mappings[idx] = m;
        } else {
          this.plugin.settings.mappings.push(m);
        }
        await this.plugin.saveSettings();
        this.plugin.refreshAutoSyncWiring();
        this.display();
      },
    }).open();
  }

  private renderOptionsSection(parent: HTMLElement): void {
    new Setting(parent).setName("Options").setHeading();

    new Setting(parent)
      .setName("Default commit message template")
      .setDesc(
        "Tokens: {date}, {datetime}, {n}, {added}, {modified}, {deleted}, {files}, {vault}, {mapping}",
      )
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultCommitTemplate)
          .onChange(async (v) => {
            this.plugin.settings.defaultCommitTemplate = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName("Excluded paths")
      .setDesc("One glob per line. Matched against vault-relative paths.")
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.excludedPaths.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.excludedPaths = v
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
      });

    new Setting(parent)
      .setName("Max file size (MB)")
      .setDesc("Files larger than this are skipped (GitHub blob limit is 100 MB).")
      .addSlider((s) =>
        s
          .setLimits(1, 100, 1)
          .setValue(Math.round(this.plugin.settings.maxFileSizeBytes / (1024 * 1024)))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxFileSizeBytes = v * 1024 * 1024;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName("Show notifications")
      .setDesc("Show a Notice after each sync run.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.showNotifications)
          .onChange(async (v) => {
            this.plugin.settings.showNotifications = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName("Debug logging")
      .setDesc("Log sync details to the developer console.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (v) => {
            this.plugin.settings.debugLogging = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}

function summarizeMapping(m: FolderMapping): string {
  const vault = isVaultRootFolder(m.vaultFolder) ? "Whole vault" : m.vaultFolder;
  const raw = m.rewriteWikilinks === false ? "  (raw wikilinks)" : "";
  const destinations = m.destinations ?? [];
  if (destinations.length === 0) {
    return `${vault} ↔ (no destinations)${raw}`;
  }
  const first = destinations[0];
  const remoteFolder = first.remoteFolder || "/";
  const head = `${first.repoOwner}/${first.repoName}:${first.branch}/${remoteFolder}`;
  const more = destinations.length > 1 ? `  +${destinations.length - 1} more` : "";
  return `${vault} ↔ ${head}${more}${raw}`;
}

function isVaultRootFolder(vaultFolder: string): boolean {
  const t = vaultFolder.trim();
  return t === "" || t === "/";
}

function statusText(m: FolderMapping, isSyncing = false): string {
  if (isSyncing) return "Syncing…";
  const destinations = m.destinations ?? [];

  // Aggregate across destinations: any error → show one error; else the
  // most recent successful sync time.
  const errored = destinations.find((d) => d.lastSyncError);
  if (errored) {
    const prefix =
      destinations.length > 1
        ? `Last sync error (${errored.repoOwner}/${errored.repoName}): `
        : "Last sync error: ";
    return prefix + errored.lastSyncError;
  }
  let mostRecent: number | undefined;
  for (const d of destinations) {
    if (d.lastSyncAt && (!mostRecent || d.lastSyncAt > mostRecent)) {
      mostRecent = d.lastSyncAt;
    }
  }
  if (mostRecent) {
    const minutes = Math.floor((Date.now() - mostRecent) / 60_000);
    if (minutes < 1) return "Synced just now";
    if (minutes < 60) return `Synced ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Synced ${hours}h ago`;
    return `Synced ${Math.floor(hours / 24)}d ago`;
  }
  return "Not synced yet";
}

function directionIcon(dir: FolderMapping["direction"]): string {
  if (dir === "push") return "↑";
  if (dir === "pull") return "↓";
  return "↕";
}
