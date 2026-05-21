import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import { GitHubClient } from "../github/client";
import { getRepo } from "../github/git-data";
import { describeAuthError } from "../github/auth";
import {
  AutoMode,
  FolderMapping,
  GitHubAuth,
  MappingDestination,
  SyncDirection,
  makeId,
} from "../types";
import { BranchSuggest, RepoSuggest, VaultFolderSuggest } from "./pickers";

export interface MappingModalOptions {
  initial?: FolderMapping;
  auth: GitHubAuth;
  onSave: (mapping: FolderMapping) => Promise<void>;
}

interface DestinationRowRefs {
  cardEl: HTMLElement;
  repoBtn: HTMLButtonElement;
  branchBtn: HTMLButtonElement;
  pathInput: HTMLInputElement;
}

export class EditMappingModal extends Modal {
  private mapping: FolderMapping;
  private opts: MappingModalOptions;
  private isNew: boolean;
  private client: GitHubClient | null;

  private intervalSetting?: Setting;

  // Live element refs per destination, keyed by destination id.
  private destRefs: Map<string, DestinationRowRefs> = new Map();
  private destinationsListEl?: HTMLElement;
  private destinationsHeader?: HTMLElement;

  // Tracks whether the user has explicitly picked a vault folder in THIS
  // editing session. Existing mappings start picked; new mappings start
  // unpicked so a default empty vaultFolder doesn't silently mean
  // "whole vault" on Save.
  private vaultFolderPicked: boolean;

  constructor(app: App, opts: MappingModalOptions) {
    super(app);
    this.opts = opts;
    this.isNew = !opts.initial;
    this.mapping = opts.initial
      ? structuredClone(opts.initial)
      : freshMapping();
    if (!Array.isArray(this.mapping.destinations)) {
      this.mapping.destinations = [];
    }
    this.vaultFolderPicked = !this.isNew;
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
      .setDesc(
        "Folder inside your Obsidian vault. Pick the vault root for whole-vault sync.",
      )
      .addButton((btn) => {
        btn.setButtonText(
          this.vaultFolderPicked
            ? formatVaultFolderLabel(this.mapping.vaultFolder)
            : "Choose folder…",
        );
        btn.buttonEl.addClass("easy-git-picker-button");
        btn.onClick(() => {
          new VaultFolderSuggest(this.app, (folder: TFolder) => {
            this.mapping.vaultFolder = folder.path;
            this.vaultFolderPicked = true;
            btn.setButtonText(formatVaultFolderLabel(folder.path));
          }).open();
        });
      });

    // Destinations section
    this.destinationsHeader = contentEl.createDiv({ cls: "easy-git-section-header" });
    this.updateDestinationsHeader();
    this.destinationsListEl = contentEl.createDiv({ cls: "easy-git-destinations-list" });
    this.renderDestinationsList();
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("+ Add destination")
        .onClick(() => {
          const newDest: MappingDestination = {
            id: makeId(),
            repoOwner: "",
            repoName: "",
            branch: "",
            remoteFolder: "",
          };
          this.mapping.destinations.push(newDest);
          this.renderDestinationsList();
          this.updateDestinationsHeader();
        }),
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

  private updateDestinationsHeader(): void {
    if (!this.destinationsHeader) return;
    this.destinationsHeader.empty();
    const n = this.mapping.destinations.length;
    this.destinationsHeader.createEl("h3", {
      text: `Destinations${n > 0 ? ` (${n})` : ""}`,
    });
    this.destinationsHeader.createEl("p", {
      cls: "easy-git-section-sub",
      text:
        n === 0
          ? "Add at least one destination — a GitHub repo + branch + path to sync this folder to."
          : "One mapping can push to several places. Each destination tracks its own sync state.",
    });
  }

  private renderDestinationsList(): void {
    if (!this.destinationsListEl) return;
    this.destinationsListEl.empty();
    this.destRefs.clear();
    for (const dest of this.mapping.destinations) {
      this.renderDestinationCard(this.destinationsListEl, dest);
    }
  }

  private renderDestinationCard(parent: HTMLElement, dest: MappingDestination): void {
    const card = parent.createDiv({ cls: "easy-git-destination-card" });

    const repoRow = card.createDiv({ cls: "easy-git-destination-row" });
    repoRow.createSpan({ cls: "easy-git-destination-label", text: "Repository" });
    const repoBtn = repoRow.createEl("button", {
      text: dest.repoOwner ? `${dest.repoOwner}/${dest.repoName}` : "Choose repo…",
    });
    repoBtn.addClass("easy-git-picker-button");
    repoBtn.onclick = () => {
      if (!this.client) {
        new Notice("Please configure GitHub authentication first.");
        return;
      }
      const modal = new RepoSuggest(this.app, this.client, (repo) => {
        dest.repoOwner = repo.owner;
        dest.repoName = repo.name;
        if (!dest.branch) dest.branch = repo.defaultBranch;
        repoBtn.setText(repo.fullName);
        const refs = this.destRefs.get(dest.id);
        if (refs && dest.branch) refs.branchBtn.setText(dest.branch);
      });
      modal.open();
      void modal.load();
    };

    const branchRow = card.createDiv({ cls: "easy-git-destination-row" });
    branchRow.createSpan({ cls: "easy-git-destination-label", text: "Branch" });
    const branchBtn = branchRow.createEl("button", {
      text: dest.branch || "Choose branch…",
    });
    branchBtn.addClass("easy-git-picker-button");
    branchBtn.onclick = () => {
      if (!this.client) {
        new Notice("Please configure GitHub authentication first.");
        return;
      }
      if (!dest.repoOwner || !dest.repoName) {
        new Notice("Please choose a repository first.");
        return;
      }
      const modal = new BranchSuggest(
        this.app,
        this.client,
        dest.repoOwner,
        dest.repoName,
        (b) => {
          dest.branch = b.name;
          branchBtn.setText(b.name);
        },
      );
      modal.open();
      void modal.load();
    };

    const pathRow = card.createDiv({ cls: "easy-git-destination-row" });
    pathRow.createSpan({ cls: "easy-git-destination-label", text: "Remote path" });
    const pathInput = pathRow.createEl("input", { type: "text" });
    pathInput.placeholder = "notes/  (empty = repo root)";
    pathInput.value = dest.remoteFolder;
    pathInput.oninput = () => {
      dest.remoteFolder = pathInput.value.trim();
    };

    const actionsRow = card.createDiv({ cls: "easy-git-destination-actions" });
    const removeBtn = actionsRow.createEl("button", { text: "Remove" });
    removeBtn.addClass("mod-warning");
    removeBtn.onclick = () => {
      this.mapping.destinations = this.mapping.destinations.filter((d) => d.id !== dest.id);
      this.renderDestinationsList();
      this.updateDestinationsHeader();
    };

    this.destRefs.set(dest.id, { cardEl: card, repoBtn, branchBtn, pathInput });
  }

  private refreshIntervalSetting(): void {
    if (!this.intervalSetting) return;
    const isInterval = this.mapping.autoMode.kind === "interval";
    this.intervalSetting.settingEl.style.display = isInterval ? "" : "none";
  }

  private async save(): Promise<void> {
    const err = validate(this.mapping, this.vaultFolderPicked);
    if (err) {
      new Notice("Easy Git: " + err);
      return;
    }
    // Resolve missing branches by querying each destination's repo default.
    for (const dest of this.mapping.destinations) {
      if (dest.repoOwner && dest.repoName && !dest.branch && this.client) {
        try {
          const info = await getRepo(this.client, dest.repoOwner, dest.repoName);
          dest.branch = info.defaultBranch;
        } catch (e) {
          new Notice(
            `Easy Git: cannot determine default branch for ${dest.repoOwner}/${dest.repoName} — ${describeAuthError(e)}`,
          );
          return;
        }
      }
      if (dest.remoteFolder.startsWith("/")) {
        dest.remoteFolder = dest.remoteFolder.replace(/^\/+/, "");
      }
      if (dest.remoteFolder.endsWith("/")) {
        dest.remoteFolder = dest.remoteFolder.replace(/\/+$/, "");
      }
    }
    await this.opts.onSave(this.mapping);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatVaultFolderLabel(path: string): string {
  const t = (path ?? "").trim();
  if (t === "" || t === "/") return "Whole vault";
  return t;
}

function freshMapping(): FolderMapping {
  return {
    id: makeId(),
    name: "",
    vaultFolder: "",
    direction: "both",
    autoMode: { kind: "off" },
    rewriteWikilinks: true,
    destinations: [],
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

function validate(m: FolderMapping, vaultFolderPicked: boolean): string | null {
  if (!m.name.trim()) return "Name is required.";
  if (!vaultFolderPicked) return "Choose a vault folder (or pick the vault root for whole-vault sync).";
  if (!m.destinations || m.destinations.length === 0) {
    return "Add at least one destination.";
  }
  for (let i = 0; i < m.destinations.length; i++) {
    const d = m.destinations[i];
    if (!d.repoOwner || !d.repoName) {
      return `Destination ${i + 1}: choose a repository.`;
    }
    if (d.remoteFolder.startsWith("/")) {
      return `Destination ${i + 1}: remote folder path cannot start with '/'.`;
    }
  }
  if (m.autoMode.kind === "interval" && m.autoMode.minutes < 1) {
    return "Interval must be at least 1 minute.";
  }
  return null;
}
