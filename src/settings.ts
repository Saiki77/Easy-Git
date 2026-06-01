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
    containerEl.addClass("easy-git-settings");
    this.mappingRowRefs.clear();

    // Foldable sections. Defaults: the two you'll touch often are open,
    // everything else is closed so the page isn't a wall of controls.
    this.collapsibleSection(containerEl, "Authentication", true, (body) =>
      this.renderAuthSection(body),
    );
    this.collapsibleSection(containerEl, "Folder mappings", true, (body) =>
      this.renderMappingsSection(body),
    );
    this.collapsibleSection(
      containerEl,
      "Conflict handling",
      false,
      (body) => this.renderConflictHandlingSection(body),
    );
    this.collapsibleSection(containerEl, "Backups", false, (body) =>
      this.renderBackupsSection(body),
    );
    this.collapsibleSection(containerEl, "Sync behaviour", false, (body) =>
      this.renderSyncBehaviourSection(body),
    );
    this.collapsibleSection(containerEl, "Excluded paths", false, (body) =>
      this.renderExcludedPathsSection(body),
    );
    this.collapsibleSection(
      containerEl,
      "Notifications & diagnostics",
      false,
      (body) => this.renderDiagnosticsSection(body),
    );
    this.collapsibleSection(containerEl, "About", false, (body) =>
      this.renderAboutSection(body),
    );
  }

  /**
   * Render one foldable section. Uses native HTML `<details>` so the
   * disclosure widget is theme-aware and accessible without extra JS.
   */
  private collapsibleSection(
    parent: HTMLElement,
    title: string,
    defaultOpen: boolean,
    render: (body: HTMLElement) => void,
  ): void {
    const details = parent.createEl("details", {
      cls: "easy-git-section",
    });
    if (defaultOpen) details.setAttr("open", "");
    const summary = details.createEl("summary", {
      cls: "easy-git-section-summary",
    });
    summary.createSpan({
      cls: "easy-git-section-chevron",
      text: "▸",
    });
    summary.createSpan({
      cls: "easy-git-section-title",
      text: title,
    });
    const body = details.createDiv({ cls: "easy-git-section-body" });
    render(body);
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
    parent.createEl("p", {
      attr: { style: "margin-top:0; color: var(--text-muted);" },
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

    new Setting(parent)
      .addButton((b) =>
        b
          .setButtonText("+ Add mapping")
          .setCta()
          .onClick(() => this.openMappingModal()),
      )
      .addButton((b) =>
        b
          .setButtonText("View sync log")
          .setTooltip("See recent sync runs, errors, and which files were touched")
          .onClick(() => this.plugin.openSyncLog()),
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

  private renderConflictHandlingSection(parent: HTMLElement): void {
    parent.createEl("p", {
      attr: { style: "margin-top:0; color: var(--text-muted);" },
      text:
        "Three layers stop a conflict modal from popping up when there's a safe answer: " +
        "mtime auto-resolve catches single-user device drift, 3-way merge catches disjoint edits, " +
        "anything left over is shown for you to decide.",
    });

    new Setting(parent)
      .setName("Auto-resolve by local mtime")
      .setDesc(
        "When local was clearly edited after the last sync (2s grace), keep local without asking. Safe direction only — the reverse stays a user decision.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.autoResolveByMtime !== false)
          .onChange(async (v) => {
            this.plugin.settings.autoResolveByMtime = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName("3-way merge text files")
      .setDesc(
        "For Markdown and other text files where both sides edited disjoint regions, merge automatically using GitHub's stored base blob as the common ancestor.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.autoMergeText !== false)
          .onChange(async (v) => {
            this.plugin.settings.autoMergeText = v;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderBackupsSection(parent: HTMLElement): void {
    parent.createEl("p", {
      attr: { style: "margin-top:0; color: var(--text-muted);" },
      text:
        "Before any pull operation overwrites or deletes a local file, Easy Git copies the original to " +
        ".easy-git-backup/<timestamp>/. Always on for push and bidirectional mappings; skipped only for pull-only mappings.",
    });

    new Setting(parent)
      .setName("Auto-prune backups older than (days)")
      .setDesc(
        "0 keeps every snapshot forever. Pruning runs at the end of each sync that touches the mapping.",
      )
      .addSlider((s) =>
        s
          .setLimits(0, 90, 1)
          .setValue(this.plugin.settings.backupRetentionDays ?? 0)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.backupRetentionDays = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName("Open backup folder")
      .setDesc("Reveal .easy-git-backup/ in the vault file explorer.")
      .addButton((b) =>
        b.setButtonText("Open").onClick(async () => {
          const folder = this.app.vault.getFolderByPath(".easy-git-backup");
          if (!folder) {
            new Notice(
              "Easy Git: no backups yet. Backups appear after the first pull-modify or pull-delete.",
            );
            return;
          }
          // Reveal in the file explorer via the built-in command.
          const fileExplorer = (
            this.app as unknown as {
              commands?: { executeCommandById?: (id: string) => boolean };
            }
          ).commands?.executeCommandById?.("file-explorer:reveal-active-file");
          // Best-effort; show a Notice with the path either way.
          new Notice(
            `Easy Git: backups live at "${folder.path}/" in your vault.`,
          );
          void fileExplorer;
        }),
      );
  }

  private renderSyncBehaviourSection(parent: HTMLElement): void {
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
  }

  private renderExcludedPathsSection(parent: HTMLElement): void {
    parent.createEl("p", {
      attr: { style: "margin-top:0; color: var(--text-muted);" },
      text:
        "Global glob patterns applied to every mapping. For per-mapping exclusions, drop a .easygitignore file at the mapping's vault folder root.",
    });
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
  }

  private renderDiagnosticsSection(parent: HTMLElement): void {
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

    new Setting(parent)
      .setName("Sync log")
      .setDesc("See recent sync runs, errors, and which files were touched.")
      .addButton((b) =>
        b
          .setButtonText("Open sync log")
          .onClick(() => this.plugin.openSyncLog()),
      );
  }

  private renderAboutSection(parent: HTMLElement): void {
    const version = this.plugin.manifest.version;
    parent.createEl("p", {
      text: `Easy Git ${version} by Saiki77`,
      attr: { style: "margin-top:0; color: var(--text-muted);" },
    });
    const links = parent.createDiv({
      attr: { style: "display: flex; gap: 1rem; flex-wrap: wrap;" },
    });
    const a = (href: string, text: string) => {
      const el = links.createEl("a", { text, href });
      el.setAttr("target", "_blank");
      el.setAttr("rel", "noopener");
    };
    a("https://github.com/Saiki77/Easy-Git", "Source");
    a("https://github.com/Saiki77/Easy-Git/issues", "Report an issue");
    a(
      "https://github.com/Saiki77/Easy-Git/blob/main/README.md",
      "Documentation",
    );
    a(
      "https://github.com/Saiki77/Easy-Git/blob/main/LICENSE",
      "License (MIT)",
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
