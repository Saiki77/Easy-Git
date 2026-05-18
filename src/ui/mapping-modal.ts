import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import { GitHubClient } from "../github/client";
import { getRepo } from "../github/git-data";
import { describeAuthError } from "../github/auth";
import {
  AutoMode,
  FolderMapping,
  GitHubAuth,
  SyncDirection,
  makeId,
} from "../types";
import { BranchSuggest, RepoSuggest, VaultFolderSuggest } from "./pickers";

export interface MappingModalOptions {
  initial?: FolderMapping;
  auth: GitHubAuth;
  onSave: (mapping: FolderMapping) => Promise<void>;
}

export class EditMappingModal extends Modal {
  private mapping: FolderMapping;
  private opts: MappingModalOptions;
  private isNew: boolean;
  private client: GitHubClient | null;

  // UI references that update when the user picks a folder/repo/branch
  private vaultFolderEl?: HTMLSpanElement;
  private repoEl?: HTMLSpanElement;
  private branchEl?: HTMLSpanElement;
  private intervalSetting?: Setting;

  constructor(app: App, opts: MappingModalOptions) {
    super(app);
    this.opts = opts;
    this.isNew = !opts.initial;
    this.mapping = opts.initial
      ? structuredClone(opts.initial)
      : freshMapping();
    this.client =
      opts.auth.method !== "none" && opts.auth.token
        ? new GitHubClient({ token: opts.auth.token })
        : null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-git-modal-form");
    contentEl.createEl("h2", {
      text: this.isNew ? "Add folder mapping" : "Edit folder mapping",
    });

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Display name for this mapping")
      .addText((t) =>
        t
          .setPlaceholder("Work notes")
          .setValue(this.mapping.name)
          .onChange((v) => (this.mapping.name = v)),
      );

    new Setting(contentEl)
      .setName("Vault folder")
      .setDesc("Folder inside your Obsidian vault")
      .addButton((btn) => {
        btn.setButtonText(this.mapping.vaultFolder || "Choose folder…");
        btn.buttonEl.addClass("easy-git-picker-button");
        this.vaultFolderEl = btn.buttonEl as unknown as HTMLSpanElement;
        btn.onClick(() => {
          new VaultFolderSuggest(this.app, (folder: TFolder) => {
            this.mapping.vaultFolder = folder.path;
            btn.setButtonText(folder.path || "/");
          }).open();
        });
      });

    new Setting(contentEl)
      .setName("Repository")
      .setDesc("GitHub repo to sync with")
      .addButton((btn) => {
        btn.setButtonText(
          this.mapping.repoOwner
            ? `${this.mapping.repoOwner}/${this.mapping.repoName}`
            : "Choose repo…",
        );
        btn.buttonEl.addClass("easy-git-picker-button");
        this.repoEl = btn.buttonEl as unknown as HTMLSpanElement;
        btn.onClick(() => {
          if (!this.client) {
            new Notice("Please configure GitHub authentication first.");
            return;
          }
          const modal = new RepoSuggest(this.app, this.client, (repo) => {
            this.mapping.repoOwner = repo.owner;
            this.mapping.repoName = repo.name;
            if (!this.mapping.branch) this.mapping.branch = repo.defaultBranch;
            btn.setButtonText(repo.fullName);
            if (this.branchEl) this.branchEl.setText(this.mapping.branch);
          });
          modal.open();
          void modal.load();
        });
      });

    new Setting(contentEl)
      .setName("Branch")
      .setDesc("Branch to commit to and read from")
      .addButton((btn) => {
        btn.setButtonText(this.mapping.branch || "Choose branch…");
        btn.buttonEl.addClass("easy-git-picker-button");
        this.branchEl = btn.buttonEl as unknown as HTMLSpanElement;
        btn.onClick(() => {
          if (!this.client) {
            new Notice("Please configure GitHub authentication first.");
            return;
          }
          if (!this.mapping.repoOwner || !this.mapping.repoName) {
            new Notice("Please choose a repository first.");
            return;
          }
          const modal = new BranchSuggest(
            this.app,
            this.client,
            this.mapping.repoOwner,
            this.mapping.repoName,
            (b) => {
              this.mapping.branch = b.name;
              btn.setButtonText(b.name);
            },
          );
          modal.open();
          void modal.load();
        });
      });

    new Setting(contentEl)
      .setName("Remote folder path")
      .setDesc("Path inside the repo (leave empty for repo root)")
      .addText((t) =>
        t
          .setPlaceholder("notes/")
          .setValue(this.mapping.remoteFolder)
          .onChange((v) => (this.mapping.remoteFolder = v.trim())),
      );

    new Setting(contentEl)
      .setName("Direction")
      .setDesc("Which way changes flow")
      .addDropdown((d) =>
        d
          .addOptions({
            push: "Push only (vault → remote)",
            pull: "Pull only (remote → vault)",
            both: "Both (bidirectional)",
          })
          .setValue(this.mapping.direction)
          .onChange((v) => (this.mapping.direction = v as SyncDirection)),
      );

    new Setting(contentEl)
      .setName("Auto mode")
      .setDesc("When to sync automatically")
      .addDropdown((d) =>
        d
          .addOptions({
            off: "Off (manual only)",
            interval: "On interval",
            startup: "On Obsidian startup",
            onSave: "On file save (debounced)",
          })
          .setValue(this.mapping.autoMode.kind)
          .onChange((v) => {
            this.mapping.autoMode = autoModeFromKind(v, this.mapping.autoMode);
            this.refreshIntervalSetting();
          }),
      );

    this.intervalSetting = new Setting(contentEl)
      .setName("Interval (minutes)")
      .setDesc("How often to sync (only used when Auto mode = On interval)")
      .addText((t) =>
        t
          .setPlaceholder("15")
          .setValue(
            this.mapping.autoMode.kind === "interval"
              ? String(this.mapping.autoMode.minutes)
              : "15",
          )
          .onChange((v) => {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              this.mapping.autoMode = { kind: "interval", minutes: n };
            }
          }),
      );
    this.refreshIntervalSetting();

    new Setting(contentEl)
      .setName("Commit message template")
      .setDesc("Optional. Leave empty to use the global default.")
      .addText((t) =>
        t
          .setPlaceholder("Use global default")
          .setValue(this.mapping.commitTemplate ?? "")
          .onChange((v) => {
            this.mapping.commitTemplate = v.length > 0 ? v : undefined;
          }),
      );

    new Setting(contentEl)
      .setName("Convert Obsidian wikilinks for GitHub")
      .setDesc(
        "Rewrites ![[image.png]] to ![](image.png) at push time so GitHub renders images inline. Attachments outside this folder are copied to attachments/ on the remote. Your vault files are not modified.",
      )
      .addToggle((t) =>
        t
          .setValue(this.mapping.rewriteWikilinks !== false)
          .onChange((v) => {
            this.mapping.rewriteWikilinks = v;
          }),
      );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Cancel")
          .onClick(() => this.close()),
      )
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Save")
          .onClick(() => void this.save()),
      );
  }

  private refreshIntervalSetting(): void {
    if (!this.intervalSetting) return;
    const isInterval = this.mapping.autoMode.kind === "interval";
    this.intervalSetting.settingEl.style.display = isInterval ? "" : "none";
  }

  private async save(): Promise<void> {
    const err = validate(this.mapping);
    if (err) {
      new Notice("Easy Git: " + err);
      return;
    }
    if (this.mapping.repoOwner && this.mapping.repoName && !this.mapping.branch && this.client) {
      try {
        const info = await getRepo(this.client, this.mapping.repoOwner, this.mapping.repoName);
        this.mapping.branch = info.defaultBranch;
      } catch (e) {
        new Notice("Easy Git: cannot determine default branch — " + describeAuthError(e));
        return;
      }
    }
    if (this.mapping.remoteFolder.startsWith("/")) {
      this.mapping.remoteFolder = this.mapping.remoteFolder.replace(/^\/+/, "");
    }
    if (this.mapping.remoteFolder.endsWith("/")) {
      this.mapping.remoteFolder = this.mapping.remoteFolder.replace(/\/+$/, "");
    }
    await this.opts.onSave(this.mapping);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function freshMapping(): FolderMapping {
  return {
    id: makeId(),
    name: "",
    vaultFolder: "",
    repoOwner: "",
    repoName: "",
    branch: "",
    remoteFolder: "",
    direction: "both",
    autoMode: { kind: "off" },
    rewriteWikilinks: true,
  };
}

function autoModeFromKind(kind: string, prev: AutoMode): AutoMode {
  switch (kind) {
    case "interval":
      return prev.kind === "interval" ? prev : { kind: "interval", minutes: 15 };
    case "startup":
      return { kind: "startup" };
    case "onSave":
      return prev.kind === "onSave" ? prev : { kind: "onSave", debounceMs: 10000 };
    case "off":
    default:
      return { kind: "off" };
  }
}

function validate(m: FolderMapping): string | null {
  if (!m.name.trim()) return "Name is required.";
  if (!m.vaultFolder && m.vaultFolder !== "") return "Choose a vault folder.";
  if (!m.repoOwner || !m.repoName) return "Choose a repository.";
  if (!m.branch) return "Choose a branch.";
  if (m.remoteFolder.startsWith("/")) return "Remote folder path cannot start with '/'.";
  if (m.autoMode.kind === "interval" && m.autoMode.minutes < 1) {
    return "Interval must be at least 1 minute.";
  }
  return null;
}
