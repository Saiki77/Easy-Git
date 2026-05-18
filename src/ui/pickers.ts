import { App, FuzzySuggestModal, Notice, TFolder } from "obsidian";
import { GitHubClient } from "../github/client";
import { listBranches, listUserRepos } from "../github/git-data";
import { BranchSummary, RepoSummary } from "../types";
import { describeAuthError } from "../github/auth";

export class VaultFolderSuggest extends FuzzySuggestModal<TFolder> {
  private folders: TFolder[];
  private onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.onChoose = onChoose;
    this.folders = collectFolders(app);
    this.setPlaceholder("Choose a folder in your vault");
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path === "" ? "/" : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

function collectFolders(app: App): TFolder[] {
  const out: TFolder[] = [];
  const root = app.vault.getRoot();
  walk(root);
  return out;

  function walk(folder: TFolder): void {
    out.push(folder);
    for (const child of folder.children) {
      if (child instanceof TFolder) walk(child);
    }
  }
}

export class RepoSuggest extends FuzzySuggestModal<RepoSummary> {
  private repos: RepoSummary[] = [];
  private onChoose: (repo: RepoSummary) => void;

  constructor(
    app: App,
    private client: GitHubClient,
    onChoose: (repo: RepoSummary) => void,
  ) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Loading repositories…");
  }

  async load(): Promise<void> {
    try {
      this.repos = await listUserRepos(this.client);
      this.setPlaceholder("Choose a repository");
      this.inputEl?.dispatchEvent(new Event("input"));
    } catch (e) {
      new Notice("Easy Git: failed to load repositories — " + describeAuthError(e));
      this.close();
    }
  }

  getItems(): RepoSummary[] {
    return this.repos;
  }

  getItemText(r: RepoSummary): string {
    return `${r.fullName}${r.private ? "  [private]" : ""}`;
  }

  onChooseItem(r: RepoSummary): void {
    this.onChoose(r);
  }
}

export class BranchSuggest extends FuzzySuggestModal<BranchSummary> {
  private branches: BranchSummary[] = [];
  private onChoose: (branch: BranchSummary) => void;

  constructor(
    app: App,
    private client: GitHubClient,
    private owner: string,
    private repo: string,
    onChoose: (branch: BranchSummary) => void,
  ) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Loading branches…");
  }

  async load(): Promise<void> {
    try {
      this.branches = await listBranches(this.client, this.owner, this.repo);
      this.setPlaceholder("Choose a branch");
      this.inputEl?.dispatchEvent(new Event("input"));
    } catch (e) {
      new Notice("Easy Git: failed to load branches — " + describeAuthError(e));
      this.close();
    }
  }

  getItems(): BranchSummary[] {
    return this.branches;
  }

  getItemText(b: BranchSummary): string {
    return b.name;
  }

  onChooseItem(b: BranchSummary): void {
    this.onChoose(b);
  }
}

export class MappingNameSuggest<T extends { id: string; name: string }> extends FuzzySuggestModal<T> {
  private items: T[];
  private onChoose: (item: T) => void;

  constructor(app: App, items: T[], placeholder: string, onChoose: (item: T) => void) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder);
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return item.name;
  }

  onChooseItem(item: T): void {
    this.onChoose(item);
  }
}
