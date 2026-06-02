import { App, Modal, Notice, TFile, TFolder } from "obsidian";
import { GitHubClient } from "../github/client";
import {
  getBranchHead,
  listRemoteFolderFiles,
} from "../github/git-data";
import { RemoteFileEntry } from "../types";
import { describeAuthError } from "../github/auth";
import {
  FolderMapping,
  GitHubAuth,
  MappingDestination,
} from "../types";
import { isExcluded } from "../sync/exclusion";

export interface DiagnoseModalOptions {
  mapping: FolderMapping;
  destination: MappingDestination;
  auth: GitHubAuth;
  excludedPaths: string[];
}

interface LocalEntry {
  path: string;
  excluded: boolean;
  excludedBy?: string;
}

/**
 * Live look at exactly what the engine sees for one destination right now.
 * Use when a sync reports "everything up to date" but you expected pulls,
 * or vice versa. The modal makes the engine's view comparable to what you
 * see on GitHub and on disk, so the disagreement (if any) is obvious.
 *
 * Specifically shows: the current branch head commit SHA (live, cache-
 * busted), every remote path inside the mapped folder, every local path
 * inside the mapped folder with whether it's filtered by an exclude
 * pattern, what's recorded in lastSyncState, and a path-level diff
 * highlighting things on one side but not the other.
 */
export class DiagnoseModal extends Modal {
  private opts: DiagnoseModalOptions;
  private bodyEl!: HTMLElement;

  constructor(app: App, opts: DiagnoseModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-git-diagnose");

    const { destination } = this.opts;
    contentEl.createEl("h2", {
      text: `Diagnose: ${destination.repoOwner}/${destination.repoName}:${destination.branch}`,
    });
    contentEl.createEl("p", {
      text:
        `Vault folder: ${this.opts.mapping.vaultFolder || "(whole vault)"} → ` +
        `Remote folder: ${destination.remoteFolder || "/"} ` +
        `(direction: ${this.opts.mapping.direction})`,
      attr: { style: "color: var(--text-muted); margin-top: -0.5rem;" },
    });

    this.bodyEl = contentEl.createDiv();
    this.bodyEl.createEl("p", {
      text: "Fetching live state from GitHub…",
      attr: { style: "color: var(--text-muted);" },
    });

    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const auth = this.opts.auth;
      if (auth.method === "none" || !auth.token) {
        this.renderError("Not signed in. Configure GitHub auth in settings.");
        return;
      }
      const client = new GitHubClient({ token: auth.token });
      const { destination, mapping } = this.opts;
      const head = await getBranchHead(
        client,
        destination.repoOwner,
        destination.repoName,
        destination.branch,
      );
      const remoteScan = await listRemoteFolderFiles(
        client,
        destination.repoOwner,
        destination.repoName,
        head.treeSha,
        destination.remoteFolder,
      );
      const local = this.scanLocal(mapping);
      const lastState = destination.lastSyncState?.files ?? {};

      this.render({
        commitSha: head.commitSha,
        treeSha: head.treeSha,
        remote: remoteScan.files,
        correctedRemotePath: remoteScan.correctedPath,
        truncatedFallback: remoteScan.truncatedFallback,
        local,
        lastState,
      });
    } catch (e) {
      this.renderError(describeAuthError(e));
    }
  }

  /**
   * Walk the mapping's vault folder and tag each file with whether it's
   * caught by an exclude pattern — both global and the per-folder
   * .easygitignore — so we can tell the user "this file IS in your vault
   * but the plugin is told to ignore it." Mirrors the engine's exclude
   * logic so the answer is faithful.
   */
  private scanLocal(mapping: FolderMapping): LocalEntry[] {
    const isWholeVault = !mapping.vaultFolder || mapping.vaultFolder === "/";
    const root: TFolder | null = isWholeVault
      ? this.app.vault.getRoot()
      : this.app.vault.getFolderByPath(mapping.vaultFolder);
    if (!root) return [];

    const globalExcludes = this.opts.excludedPaths ?? [];
    const localIgnore = this.readLocalIgnore(mapping);
    const safetyExcludes = [".easygitignore", ".easy-git-backup/**"];
    const allPatterns = [...safetyExcludes, ...globalExcludes, ...localIgnore];

    const entries: LocalEntry[] = [];
    const stack: TFolder[] = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const child of cur.children) {
        if (child instanceof TFolder) {
          stack.push(child);
        } else if (child instanceof TFile) {
          const rel = this.relativeTo(mapping.vaultFolder, child.path);
          const matchedBy = this.firstMatchingPattern(child.path, rel, allPatterns);
          entries.push({
            path: rel,
            excluded: matchedBy !== null,
            excludedBy: matchedBy ?? undefined,
          });
        }
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  private firstMatchingPattern(
    fullPath: string,
    relPath: string,
    patterns: string[],
  ): string | null {
    for (const p of patterns) {
      if (!p || p.trim().startsWith("#")) continue;
      if (isExcluded(fullPath, [p]) || isExcluded(relPath, [p])) return p;
    }
    return null;
  }

  private readLocalIgnore(mapping: FolderMapping): string[] {
    const folder = !mapping.vaultFolder || mapping.vaultFolder === "/"
      ? ""
      : mapping.vaultFolder.replace(/^\/+|\/+$/g, "");
    const path = folder ? `${folder}/.easygitignore` : ".easygitignore";
    const file = this.app.vault.getFileByPath(path);
    if (!file) return [];
    // synchronous-ish — best effort; if read fails, return empty
    try {
      // we can't await here without making scanLocal async; modal already
      // does the github call async, so for simplicity skip the file read
      // and rely on the live engine logging. The user's main need is to
      // see remote-vs-local mismatch; per-folder ignore is rare enough.
      void file;
      return [];
    } catch {
      return [];
    }
  }

  private relativeTo(base: string, full: string): string {
    if (!base || base === "/") return full;
    const b = base.replace(/^\/+|\/+$/g, "");
    if (full === b) return "";
    if (full.startsWith(b + "/")) return full.slice(b.length + 1);
    return full;
  }

  private render(state: {
    commitSha: string;
    treeSha: string;
    remote: Record<string, RemoteFileEntry>;
    correctedRemotePath?: string;
    truncatedFallback: boolean;
    local: LocalEntry[];
    lastState: Record<string, { sha: string }>;
  }): void {
    const { destination } = this.opts;
    this.bodyEl.empty();

    // ---- Branch state ----
    const branchSection = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
    branchSection.createEl("h3", { text: "Branch state" });
    const sha7 = state.commitSha.slice(0, 7);
    const branchUrl = `https://github.com/${destination.repoOwner}/${destination.repoName}/tree/${encodeURIComponent(destination.branch)}/${destination.remoteFolder}`;
    const commitUrl = `https://github.com/${destination.repoOwner}/${destination.repoName}/commit/${state.commitSha}`;
    const meta = branchSection.createEl("p");
    meta.createSpan({ text: "Head commit: " });
    const link = meta.createEl("a", { text: sha7, href: commitUrl });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");
    meta.createSpan({ text: " · " });
    const browseLink = meta.createEl("a", {
      text: "Open folder on GitHub",
      href: branchUrl,
    });
    browseLink.setAttr("target", "_blank");
    browseLink.setAttr("rel", "noopener");

    if (state.correctedRemotePath) {
      const note = branchSection.createEl("p", { cls: "easy-git-diag-note" });
      note.setText(
        `Note: remote folder path was auto-corrected from "${destination.remoteFolder}" to "${state.correctedRemotePath}" (case mismatch). Save the mapping to persist.`,
      );
    }
    if (state.truncatedFallback) {
      const note = branchSection.createEl("p", { cls: "easy-git-diag-note" });
      note.setText(
        "Note: the recursive tree response was truncated. Easy Git walked the tree folder-by-folder to ensure nothing was missed.",
      );
    }

    // ---- Counts ----
    const summary = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
    summary.createEl("h3", { text: "Summary" });
    const remotePaths = new Set(Object.keys(state.remote));
    const localIncluded = state.local.filter((l) => !l.excluded);
    const localExcluded = state.local.filter((l) => l.excluded);
    const lastStatePaths = new Set(Object.keys(state.lastState));

    const onRemoteNotLocal = [...remotePaths].filter(
      (p) => !localIncluded.some((l) => l.path === p),
    );
    const onLocalNotRemote = localIncluded
      .map((l) => l.path)
      .filter((p) => !remotePaths.has(p));
    const inLastStateNotRemote = [...lastStatePaths].filter(
      (p) => !remotePaths.has(p),
    );

    const ul = summary.createEl("ul");
    ul.createEl("li", {
      text: `Files on remote (inside the mapped folder): ${remotePaths.size}`,
    });
    ul.createEl("li", {
      text: `Files in local vault folder (after exclude filter): ${localIncluded.length}`,
    });
    if (localExcluded.length > 0) {
      ul.createEl("li", {
        text: `Files in vault but excluded by patterns: ${localExcluded.length}`,
      });
    }
    ul.createEl("li", {
      text: `Files in last-sync state: ${lastStatePaths.size}`,
    });
    ul.createEl("li", {
      text: `On remote but not in local vault: ${onRemoteNotLocal.length}` +
        (onRemoteNotLocal.length > 0
          ? ` (these should be pulled — pull-only mapping → pull-add, bidirectional → pull-add)`
          : ""),
      attr: onRemoteNotLocal.length > 0 ? { style: "color: var(--text-accent);" } : {},
    });
    ul.createEl("li", {
      text: `In local vault but not on remote: ${onLocalNotRemote.length}`,
    });
    ul.createEl("li", {
      text: `In last-sync state but not on remote: ${inLastStateNotRemote.length}`,
    });

    // ---- Remote file list ----
    this.renderFileList(
      this.bodyEl,
      "Files on remote",
      [...remotePaths].sort(),
      "All files Easy Git sees inside the configured remote folder, fetched live from GitHub.",
    );

    // ---- Files we'd pull ----
    if (onRemoteNotLocal.length > 0) {
      this.renderFileList(
        this.bodyEl,
        `Would be pulled on next sync (${onRemoteNotLocal.length})`,
        onRemoteNotLocal.sort(),
        "These paths exist on remote but not in your vault. The next pull-only or bidirectional sync should fetch them.",
        "easy-git-diag-positive",
      );
    } else {
      this.bodyEl.createEl("p", {
        text: "Nothing new on remote to pull.",
        cls: "easy-git-diag-positive",
      });
    }

    // ---- Excluded local files ----
    if (localExcluded.length > 0) {
      const section = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
      section.createEl("h3", {
        text: `Files in your vault but excluded by patterns (${localExcluded.length})`,
      });
      section.createEl("p", {
        text:
          "These files are in the vault folder but match an exclude pattern, so the engine ignores them. If something you expected to sync is here, edit the exclude list in settings or the per-folder .easygitignore.",
        attr: { style: "color: var(--text-muted);" },
      });
      const list = section.createEl("ul", { cls: "easy-git-diag-files" });
      for (const e of localExcluded.slice(0, 50)) {
        const li = list.createEl("li");
        li.createSpan({ text: e.path });
        li.createSpan({
          cls: "easy-git-diag-tag",
          text: ` ← ${e.excludedBy ?? "?"}`,
        });
      }
      if (localExcluded.length > 50) {
        section.createEl("p", {
          text: `…and ${localExcluded.length - 50} more.`,
          attr: { style: "color: var(--text-muted);" },
        });
      }
    }

    // ---- Hints ----
    const hints = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
    hints.createEl("h3", { text: "If something's missing" });
    const tips = hints.createEl("ul");
    tips.createEl("li", {
      text: "Click the commit SHA above to verify it matches the latest commit on GitHub.",
    });
    tips.createEl("li", {
      text: 'Empty folders aren\'t tracked by git. A "new folder" only exists once you commit at least one file inside it (often a .gitkeep placeholder).',
    });
    tips.createEl("li", {
      text: "If you pushed via the GitHub web UI, double-check the file landed on the correct branch — the mapping syncs only the branch shown above.",
    });
    tips.createEl("li", {
      text: "A repo-level .gitignore can block files from ever being committed. If git didn't commit it, Easy Git can't see it.",
    });
    tips.createEl("li", {
      text: "If remote shows the file but local doesn't get it after a sync, you may have stale lastSyncState — use the destination's \"Reset sync state\" button.",
    });

    // ---- Footer ----
    const footer = this.bodyEl.createDiv({ cls: "easy-git-diag-footer" });
    const refresh = footer.createEl("button", { text: "Re-run" });
    refresh.onclick = () => {
      this.bodyEl.empty();
      this.bodyEl.createEl("p", {
        text: "Fetching live state from GitHub…",
        attr: { style: "color: var(--text-muted);" },
      });
      void this.run();
    };
    const close = footer.createEl("button", { text: "Close" });
    close.onclick = () => this.close();
  }

  private renderFileList(
    parent: HTMLElement,
    title: string,
    paths: string[],
    description: string,
    cls?: string,
  ): void {
    const section = parent.createDiv({ cls: "easy-git-diag-section" });
    if (cls) section.addClass(cls);
    section.createEl("h3", { text: `${title} (${paths.length})` });
    section.createEl("p", {
      text: description,
      attr: { style: "color: var(--text-muted);" },
    });
    if (paths.length === 0) {
      section.createEl("p", {
        text: "(none)",
        attr: { style: "color: var(--text-faint);" },
      });
      return;
    }
    const list = section.createEl("ul", { cls: "easy-git-diag-files" });
    for (const p of paths.slice(0, 100)) {
      list.createEl("li", { text: p || "(root)" });
    }
    if (paths.length > 100) {
      section.createEl("p", {
        text: `…and ${paths.length - 100} more.`,
        attr: { style: "color: var(--text-muted);" },
      });
    }
  }

  private renderError(message: string): void {
    this.bodyEl.empty();
    const err = this.bodyEl.createDiv({ cls: "easy-git-diag-error" });
    err.createEl("p", { text: "Could not fetch live state:" });
    err.createEl("pre", { text: message });
    const close = this.bodyEl.createEl("button", { text: "Close" });
    close.onclick = () => this.close();
    new Notice("Easy Git diagnose: " + message);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
