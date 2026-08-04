import { App, Modal, Notice, Platform, TFile, TFolder } from "obsidian";
import { GitHubClient } from "../github/client";
import {
  getBranchHead,
  listRemoteFolderFiles,
} from "../github/git-data";
import { describeAuthError, getAuthenticatedUser } from "../github/auth";
import {
  FolderMapping,
  MappingDestination,
  PluginSettings,
  RemoteFileEntry,
  SyncLogEntry,
  resolveApiBase,
} from "../types";
import { isExcluded } from "../sync/exclusion";
import { hasHiddenPathSegment } from "../sync/hidden-paths";

export interface DiagnoseModalOptions {
  mapping: FolderMapping;
  destination: MappingDestination;
  settings: PluginSettings;
  pluginVersion: string;
}

interface LocalEntry {
  path: string;
  sha?: string;
  size?: number;
  excluded: boolean;
  excludedBy?: string;
  hiddenPath: boolean;
}

interface DiagnosticReport {
  generatedAt: string;
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  mapping: {
    id: string;
    name: string;
    direction: string;
    vaultFolder: string;
    autoMode: string;
    rewriteWikilinks: string;
    destinationCount: number;
  };
  destination: {
    id: string;
    repo: string;
    branch: string;
    remoteFolder: string;
    lastSyncAt?: string;
    lastSyncCommit?: string;
    lastSyncError?: string;
  };
  auth: {
    method: string;
    username?: string;
    scopes?: string[];
    tokenError?: string;
  };
  branch: {
    headCommit: string;
    treeSha: string;
    commitUrl: string;
    folderUrl: string;
  } | null;
  remoteScan: {
    fileCount: number;
    correctedPath?: string;
    truncatedFallback: boolean;
    paths: string[];
  } | null;
  localScan: {
    includedCount: number;
    excludedCount: number;
    hiddenPathCount: number;
    paths: string[];
    excludedPaths: Array<{ path: string; pattern: string }>;
  };
  lastState: {
    count: number;
    paths: string[];
  };
  diff: {
    onRemoteNotLocal: string[];
    onLocalNotRemote: string[];
    inLastStateNotRemote: string[];
    bothButDifferentSha: Array<{ path: string; remoteSha: string; localSha: string }>;
  };
  settings: {
    maxFileSizeMB: number;
    excludedPathsGlobal: string[];
    localIgnore: string[];
    autoResolveByMtime: boolean;
    autoMergeText: boolean;
    backupRetentionDays: number;
    showNotifications: boolean;
    debugLogging: boolean;
  };
  syncLogTail: SyncLogEntry[];
  fetchErrors: string[];
}

/**
 * Live, comprehensive look at exactly what the engine sees for one
 * destination. Designed both as an in-modal viewer and as a one-click
 * copyable report for posting to GitHub issues or sharing in chat.
 *
 * Shows: plugin/Obsidian/platform metadata, mapping + destination
 * config, auth state, live branch HEAD, every remote path, every local
 * path (with exclusion reasons), the full diff, all relevant settings,
 * any per-folder .easygitignore content, and the recent sync-log tail
 * filtered to this destination. The "Copy as text" button puts a
 * Markdown version of the whole thing on the clipboard.
 */
export class DiagnoseModal extends Modal {
  private opts: DiagnoseModalOptions;
  private bodyEl!: HTMLElement;
  private currentReport: DiagnosticReport | null = null;

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
      text: "Gathering diagnostics…",
      attr: { style: "color: var(--text-muted);" },
    });

    void this.run();
  }

  private async run(): Promise<void> {
    const report = await this.buildReport();
    this.currentReport = report;
    this.render(report);
  }

  private async buildReport(): Promise<DiagnosticReport> {
    const fetchErrors: string[] = [];
    const { mapping, destination, settings, pluginVersion } = this.opts;

    // Auth check (separate from main fetch so a bad token doesn't kill
    // the rest of the report).
    const auth: DiagnosticReport["auth"] = {
      method: settings.auth.method,
      username: settings.auth.username,
      scopes: settings.auth.scopes,
    };
    let client: GitHubClient | null = null;
    if (settings.auth.method !== "none" && settings.auth.token) {
      client = new GitHubClient({ token: settings.auth.token, baseUrl: resolveApiBase(settings.auth) });
      try {
        const user = await getAuthenticatedUser(client);
        auth.username = user.login || undefined;
      } catch (e) {
        auth.tokenError = describeAuthError(e);
        fetchErrors.push("Auth check failed: " + auth.tokenError);
      }
    } else {
      auth.tokenError = "no token configured";
    }

    // Branch + remote scan (live; cache-busted by 1.4.5).
    let branch: DiagnosticReport["branch"] = null;
    let remoteScan: DiagnosticReport["remoteScan"] = null;
    let remoteFiles: Record<string, RemoteFileEntry> = {};
    if (client) {
      try {
        const head = await getBranchHead(
          client,
          destination.repoOwner,
          destination.repoName,
          destination.branch,
        );
        branch = {
          headCommit: head.commitSha,
          treeSha: head.treeSha,
          commitUrl: `https://github.com/${destination.repoOwner}/${destination.repoName}/commit/${head.commitSha}`,
          folderUrl: `https://github.com/${destination.repoOwner}/${destination.repoName}/tree/${encodeURIComponent(destination.branch)}/${destination.remoteFolder}`,
        };
        const scan = await listRemoteFolderFiles(
          client,
          destination.repoOwner,
          destination.repoName,
          head.treeSha,
          destination.remoteFolder,
        );
        remoteFiles = scan.files;
        remoteScan = {
          fileCount: Object.keys(scan.files).length,
          correctedPath: scan.correctedPath,
          truncatedFallback: scan.truncatedFallback,
          paths: Object.keys(scan.files).sort(),
        };
      } catch (e) {
        fetchErrors.push("Remote scan failed: " + describeAuthError(e));
      }
    }

    // Local scan + exclude classification.
    const local = await this.scanLocalWithExcludes(mapping);
    const includedLocal = local.filter((l) => !l.excluded);
    const excludedLocal = local.filter((l) => l.excluded);
    const hiddenLocal = local.filter((l) => l.hiddenPath);
    const localPaths = new Set(includedLocal.map((l) => l.path));

    // .easygitignore content (best-effort read via adapter).
    const localIgnore = await this.readLocalIgnore(mapping);

    // LastSyncState paths.
    const lastFiles = destination.lastSyncState?.files ?? {};
    const lastPaths = Object.keys(lastFiles).sort();

    // Diff.
    const remotePaths = new Set(remoteScan?.paths ?? []);
    const onRemoteNotLocal = [...remotePaths].filter((p) => !localPaths.has(p)).sort();
    const onLocalNotRemote = [...localPaths].filter((p) => !remotePaths.has(p)).sort();
    const inLastStateNotRemote = lastPaths.filter((p) => !remotePaths.has(p));
    const bothButDifferentSha: Array<{ path: string; remoteSha: string; localSha: string }> = [];
    for (const l of includedLocal) {
      const r = remoteFiles[l.path];
      if (r && l.sha && l.sha !== r.sha) {
        bothButDifferentSha.push({ path: l.path, remoteSha: r.sha, localSha: l.sha });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      pluginVersion,
      obsidianVersion: this.detectObsidianVersion(),
      platform: this.detectPlatform(),
      mapping: {
        id: mapping.id,
        name: mapping.name,
        direction: mapping.direction,
        vaultFolder: mapping.vaultFolder || "(whole vault)",
        autoMode: this.formatAutoMode(mapping),
        rewriteWikilinks:
          mapping.rewriteWikilinks === false
            ? "off"
            : mapping.rewriteWikilinks === true
              ? "on"
              : "auto (default on)",
        destinationCount: mapping.destinations.length,
      },
      destination: {
        id: destination.id,
        repo: `${destination.repoOwner}/${destination.repoName}`,
        branch: destination.branch,
        remoteFolder: destination.remoteFolder || "(repo root)",
        lastSyncAt: destination.lastSyncAt
          ? new Date(destination.lastSyncAt).toISOString()
          : undefined,
        lastSyncCommit: destination.lastSyncState?.baseCommitSha,
        lastSyncError: destination.lastSyncError,
      },
      auth,
      branch,
      remoteScan,
      localScan: {
        includedCount: includedLocal.length,
        excludedCount: excludedLocal.length,
        hiddenPathCount: hiddenLocal.length,
        paths: includedLocal.map((l) => l.path).sort(),
        excludedPaths: excludedLocal.map((l) => ({
          path: l.path,
          pattern: l.excludedBy ?? "?",
        })),
      },
      lastState: {
        count: lastPaths.length,
        paths: lastPaths,
      },
      diff: {
        onRemoteNotLocal,
        onLocalNotRemote,
        inLastStateNotRemote,
        bothButDifferentSha,
      },
      settings: {
        maxFileSizeMB: Math.round(settings.maxFileSizeBytes / (1024 * 1024)),
        excludedPathsGlobal: [...settings.excludedPaths],
        localIgnore,
        autoResolveByMtime: settings.autoResolveByMtime !== false,
        autoMergeText: settings.autoMergeText !== false,
        backupRetentionDays: settings.backupRetentionDays ?? 0,
        showNotifications: settings.showNotifications,
        debugLogging: settings.debugLogging,
      },
      syncLogTail: (settings.syncLog ?? [])
        .filter((e) => e.destinationId === destination.id)
        .slice(0, 5),
      fetchErrors,
    };
  }

  private detectObsidianVersion(): string {
    const anyApp = this.app as unknown as { appVersion?: string };
    return anyApp.appVersion ?? "unknown";
  }

  private detectPlatform(): string {
    const parts: string[] = [];
    if (Platform.isMobile) parts.push("mobile");
    if (Platform.isDesktop) parts.push("desktop");
    if (Platform.isMacOS) parts.push("macOS");
    if (Platform.isWin) parts.push("Windows");
    if (Platform.isLinux) parts.push("Linux");
    if (Platform.isIosApp) parts.push("iOS");
    if (Platform.isAndroidApp) parts.push("Android");
    return parts.length > 0 ? parts.join(", ") : "unknown";
  }

  private formatAutoMode(m: FolderMapping): string {
    const a = m.autoMode;
    if (!a || a.kind === "off") return "off";
    if (a.kind === "interval") return `every ${a.minutes}m`;
    if (a.kind === "startup") return "on startup";
    if (a.kind === "onSave") return `on save (debounce ${a.debounceMs}ms)`;
    return JSON.stringify(a);
  }

  /**
   * Adapter-backed local walk that also picks up hidden files and folders,
   * and tags each file with whether and why it's
   * filtered by an exclude pattern.
   */
  private async scanLocalWithExcludes(mapping: FolderMapping): Promise<LocalEntry[]> {
    const isWholeVault = !mapping.vaultFolder || mapping.vaultFolder === "/";
    const root: TFolder | null = isWholeVault
      ? this.app.vault.getRoot()
      : this.app.vault.getFolderByPath(mapping.vaultFolder);
    if (!root) return [];

    const globalExcludes = this.opts.settings.excludedPaths ?? [];
    const safetyExcludes = [".easy-git-backup/**"];
    const localIgnore = await this.readLocalIgnore(mapping);
    const allPatterns = [...safetyExcludes, ...globalExcludes, ...localIgnore];

    const entries: LocalEntry[] = [];
    const folderPaths: string[] = [];
    const stack: TFolder[] = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      folderPaths.push(cur.path);
      for (const child of cur.children) {
        if (child instanceof TFolder) {
          stack.push(child);
        } else if (child instanceof TFile) {
          const rel = this.relativeTo(mapping.vaultFolder, child.path);
          const matchedBy = this.firstMatchingPattern(child.path, rel, allPatterns);
          entries.push({
            path: rel,
            size: child.stat.size,
            excluded: matchedBy !== null,
            excludedBy: matchedBy ?? undefined,
            hiddenPath: false,
          });
        }
      }
    }

    // Hidden-path pass via adapter — mirrors the sync engine so
    // the diagnostic reflects what an actual sync would see, not just
    // what the vault layer surfaces.
    const seenPaths = new Set(entries.map((e) => e.path));
    const seenFolders = new Set(folderPaths);
    for (const folderPath of folderPaths) {
      try {
        const listing = await this.app.vault.adapter.list(folderPath || "/");
        for (const hiddenFolder of listing.folders) {
          const rel = this.relativeTo(mapping.vaultFolder, hiddenFolder);
          if (
            hasHiddenPathSegment(rel) &&
            this.firstMatchingPattern(hiddenFolder, rel, allPatterns) === null &&
            !seenFolders.has(hiddenFolder)
          ) {
            seenFolders.add(hiddenFolder);
            folderPaths.push(hiddenFolder);
          }
        }
        for (const filePath of listing.files) {
          const basename = filePath.substring(filePath.lastIndexOf("/") + 1);
          const rel = this.relativeTo(mapping.vaultFolder, filePath);
          if (!basename.startsWith(".") && !hasHiddenPathSegment(rel)) continue;
          if (seenPaths.has(rel)) continue;
          const matchedBy = this.firstMatchingPattern(filePath, rel, allPatterns);
          let size: number | undefined;
          try {
            const stat = (await this.app.vault.adapter.stat(filePath)) as
              | { size: number }
              | null;
            size = stat?.size;
          } catch {
            /* ignore */
          }
          entries.push({
            path: rel,
            size,
            excluded: matchedBy !== null,
            excludedBy: matchedBy ?? undefined,
            hiddenPath: true,
          });
          seenPaths.add(rel);
        }
      } catch {
        /* unreadable folder; skip */
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

  private async readLocalIgnore(mapping: FolderMapping): Promise<string[]> {
    const folder =
      !mapping.vaultFolder || mapping.vaultFolder === "/"
        ? ""
        : mapping.vaultFolder.replace(/^\/+|\/+$/g, "");
    const path = folder ? `${folder}/.easygitignore` : ".easygitignore";
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return [];
      const text = await this.app.vault.adapter.read(path);
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
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

  // -------------------------------------------------------------------
  // Render (UI)
  // -------------------------------------------------------------------

  private render(r: DiagnosticReport): void {
    this.bodyEl.empty();

    if (r.fetchErrors.length > 0) {
      const errs = this.bodyEl.createDiv({ cls: "easy-git-diag-error" });
      errs.createEl("p", { text: "Some live data could not be fetched:" });
      const ul = errs.createEl("ul");
      for (const e of r.fetchErrors) ul.createEl("li", { text: e });
    }

    // ---- Header (live branch state) ----
    if (r.branch) {
      const branchSection = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
      branchSection.createEl("h3", { text: "Branch state (live)" });
      const meta = branchSection.createEl("p");
      meta.createSpan({ text: "Head commit: " });
      const link = meta.createEl("a", {
        text: r.branch.headCommit.slice(0, 7),
        href: r.branch.commitUrl,
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      meta.createSpan({ text: " · " });
      const browseLink = meta.createEl("a", {
        text: "Open folder on GitHub",
        href: r.branch.folderUrl,
      });
      browseLink.setAttr("target", "_blank");
      browseLink.setAttr("rel", "noopener");
    }

    if (r.remoteScan?.correctedPath) {
      const note = this.bodyEl.createEl("p", { cls: "easy-git-diag-note" });
      note.setText(
        `Note: remote folder path auto-corrected from "${this.opts.destination.remoteFolder}" to "${r.remoteScan.correctedPath}" (case mismatch).`,
      );
    }
    if (r.remoteScan?.truncatedFallback) {
      const note = this.bodyEl.createEl("p", { cls: "easy-git-diag-note" });
      note.setText(
        "Note: the recursive tree response was truncated. Walked it folder-by-folder.",
      );
    }

    // ---- Summary ----
    const summary = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
    summary.createEl("h3", { text: "Summary" });
    const ul = summary.createEl("ul");
    ul.createEl("li", { text: `Plugin: Easy Git ${r.pluginVersion}` });
    ul.createEl("li", { text: `Obsidian: ${r.obsidianVersion} (${r.platform})` });
    ul.createEl("li", { text: `Auth: ${this.formatAuthSummary(r.auth)}` });
    ul.createEl("li", {
      text: `Files on remote: ${r.remoteScan?.fileCount ?? "n/a"}`,
    });
    ul.createEl("li", {
      text: `Files in vault (included): ${r.localScan.includedCount}` +
        (r.localScan.hiddenPathCount > 0
          ? ` (${r.localScan.hiddenPathCount} hidden paths)`
          : ""),
    });
    if (r.localScan.excludedCount > 0) {
      ul.createEl("li", {
        text: `Files in vault but excluded by patterns: ${r.localScan.excludedCount}`,
      });
    }
    ul.createEl("li", { text: `Files in last-sync state: ${r.lastState.count}` });
    const wouldPullColor =
      r.diff.onRemoteNotLocal.length > 0 ? "color: var(--text-accent);" : "";
    ul.createEl("li", {
      text: `Would be pulled on next sync: ${r.diff.onRemoteNotLocal.length}`,
      attr: { style: wouldPullColor },
    });
    if (r.diff.bothButDifferentSha.length > 0) {
      ul.createEl("li", {
        text: `Files differing on both sides (SHA mismatch): ${r.diff.bothButDifferentSha.length}`,
        attr: { style: "color: var(--text-accent);" },
      });
    }

    // ---- Mapping + destination config ----
    this.renderKV(this.bodyEl, "Mapping", {
      Name: r.mapping.name,
      ID: r.mapping.id,
      Direction: r.mapping.direction,
      "Vault folder": r.mapping.vaultFolder,
      "Auto mode": r.mapping.autoMode,
      "Wikilink rewrite": r.mapping.rewriteWikilinks,
      Destinations: String(r.mapping.destinationCount),
    });
    this.renderKV(this.bodyEl, "Destination", {
      Repo: r.destination.repo,
      Branch: r.destination.branch,
      "Remote folder": r.destination.remoteFolder,
      "Last sync at": r.destination.lastSyncAt ?? "(never)",
      "Last sync commit": r.destination.lastSyncCommit?.slice(0, 7) ?? "(none)",
      "Last sync error": r.destination.lastSyncError ?? "(none)",
    });

    // ---- Diff sections ----
    this.renderFileList(
      this.bodyEl,
      "Would be pulled on next sync",
      r.diff.onRemoteNotLocal,
      "Paths on remote but not in your vault (after exclude filter).",
      r.diff.onRemoteNotLocal.length > 0 ? "easy-git-diag-positive" : undefined,
    );
    if (r.diff.bothButDifferentSha.length > 0) {
      const sec = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
      sec.createEl("h3", {
        text: `Same path, different content (${r.diff.bothButDifferentSha.length})`,
      });
      sec.createEl("p", {
        text:
          "These paths exist on both sides but with different SHAs. Pull-only → remote will overwrite (with backup). Bidirectional → may go to the conflict modal.",
        attr: { style: "color: var(--text-muted);" },
      });
      const list = sec.createEl("ul", { cls: "easy-git-diag-files" });
      for (const e of r.diff.bothButDifferentSha.slice(0, 50)) {
        const li = list.createEl("li");
        li.createSpan({ text: e.path });
        li.createSpan({
          cls: "easy-git-diag-tag",
          text: `  remote=${e.remoteSha.slice(0, 7)} local=${e.localSha.slice(0, 7)}`,
        });
      }
    }
    if (r.diff.onLocalNotRemote.length > 0) {
      this.renderFileList(
        this.bodyEl,
        "In vault, not on remote",
        r.diff.onLocalNotRemote,
        "Push-only or bidirectional mappings push these. Pull-only leaves them alone (they're considered user-added).",
      );
    }
    if (r.diff.inLastStateNotRemote.length > 0) {
      this.renderFileList(
        this.bodyEl,
        "In last-sync state but not on remote",
        r.diff.inLastStateNotRemote,
        "These were pulled previously but are gone from remote now. Pull-only → next sync deletes them locally (with backup), unless you edited them locally.",
      );
    }

    // ---- Remote + local listings ----
    this.renderFileList(
      this.bodyEl,
      "All files on remote",
      r.remoteScan?.paths ?? [],
      "Every file Easy Git found in the configured remote folder.",
    );
    this.renderFileList(
      this.bodyEl,
      "All files in local vault folder",
      r.localScan.paths,
      "Every file in your vault folder that passes the exclude filter.",
    );

    // ---- Excluded local files ----
    if (r.localScan.excludedPaths.length > 0) {
      const sec = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
      sec.createEl("h3", {
        text: `Excluded by patterns (${r.localScan.excludedPaths.length})`,
      });
      sec.createEl("p", {
        text:
          "These files are in your vault but match an exclude pattern. If you expected one of them to sync, remove the matching pattern.",
        attr: { style: "color: var(--text-muted);" },
      });
      const list = sec.createEl("ul", { cls: "easy-git-diag-files" });
      for (const e of r.localScan.excludedPaths.slice(0, 50)) {
        const li = list.createEl("li");
        li.createSpan({ text: e.path });
        li.createSpan({ cls: "easy-git-diag-tag", text: ` ← ${e.pattern}` });
      }
    }

    // ---- Settings ----
    this.renderKV(this.bodyEl, "Settings", {
      "Max file size (MB)": String(r.settings.maxFileSizeMB),
      "Auto-resolve by mtime": String(r.settings.autoResolveByMtime),
      "3-way merge text": String(r.settings.autoMergeText),
      "Backup retention (days)":
        r.settings.backupRetentionDays > 0
          ? String(r.settings.backupRetentionDays)
          : "keep all",
      Notifications: String(r.settings.showNotifications),
      "Debug logging": String(r.settings.debugLogging),
    });
    if (r.settings.excludedPathsGlobal.length > 0) {
      this.renderFileList(
        this.bodyEl,
        "Global excluded paths",
        r.settings.excludedPathsGlobal,
        "From Easy Git → Excluded paths.",
      );
    }
    if (r.settings.localIgnore.length > 0) {
      this.renderFileList(
        this.bodyEl,
        ".easygitignore (per-folder)",
        r.settings.localIgnore,
        "Patterns read from a .easygitignore file at the root of the vault folder.",
      );
    }

    // ---- Recent sync log ----
    if (r.syncLogTail.length > 0) {
      const sec = this.bodyEl.createDiv({ cls: "easy-git-diag-section" });
      sec.createEl("h3", {
        text: `Recent sync log entries for this destination (${r.syncLogTail.length})`,
      });
      const list = sec.createEl("ul", { cls: "easy-git-diag-files" });
      for (const e of r.syncLogTail) {
        const li = list.createEl("li");
        const when = new Date(e.timestamp).toISOString();
        const status = e.ok ? "✓" : "✗";
        li.setText(
          `${status} ${when} · ${e.trigger} · ` +
            `+${e.added} ~${e.modified} -${e.deleted}` +
            (e.error ? `  error: ${e.error}` : ""),
        );
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
      text: 'If remote shows the file but local doesn\'t get it after a sync, try the destination\'s "Reset sync state" button.',
    });

    // ---- Footer ----
    const footer = this.bodyEl.createDiv({ cls: "easy-git-diag-footer" });
    const copyBtn = footer.createEl("button", { text: "Copy as text" });
    copyBtn.addClass("mod-cta");
    copyBtn.onclick = async () => {
      const text = this.toMarkdown(r);
      await this.copyToClipboard(text);
      new Notice("Easy Git: diagnostic report copied to clipboard.");
    };
    const refresh = footer.createEl("button", { text: "Re-run" });
    refresh.onclick = () => {
      this.bodyEl.empty();
      this.bodyEl.createEl("p", {
        text: "Gathering diagnostics…",
        attr: { style: "color: var(--text-muted);" },
      });
      void this.run();
    };
    const close = footer.createEl("button", { text: "Close" });
    close.onclick = () => this.close();
  }

  private formatAuthSummary(a: DiagnosticReport["auth"]): string {
    if (a.tokenError) return `${a.method} (${a.tokenError})`;
    const who = a.username ?? "(unknown user)";
    const scopes = a.scopes && a.scopes.length > 0 ? `, scopes: ${a.scopes.join(",")}` : "";
    return `${a.method} as ${who}${scopes}`;
  }

  private renderKV(
    parent: HTMLElement,
    title: string,
    kv: Record<string, string>,
  ): void {
    const sec = parent.createDiv({ cls: "easy-git-diag-section" });
    sec.createEl("h3", { text: title });
    const list = sec.createEl("ul", { cls: "easy-git-diag-kv" });
    for (const [k, v] of Object.entries(kv)) {
      const li = list.createEl("li");
      li.createSpan({ cls: "easy-git-diag-kv-key", text: `${k}:` });
      li.createSpan({ cls: "easy-git-diag-kv-val", text: " " + v });
    }
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
    if (description) {
      section.createEl("p", {
        text: description,
        attr: { style: "color: var(--text-muted);" },
      });
    }
    if (paths.length === 0) {
      section.createEl("p", {
        text: "(none)",
        attr: { style: "color: var(--text-faint);" },
      });
      return;
    }
    const list = section.createEl("ul", { cls: "easy-git-diag-files" });
    for (const p of paths.slice(0, 200)) {
      list.createEl("li", { text: p || "(root)" });
    }
    if (paths.length > 200) {
      section.createEl("p", {
        text: `…and ${paths.length - 200} more. (Use "Copy as text" to get the full list.)`,
        attr: { style: "color: var(--text-muted);" },
      });
    }
  }

  // -------------------------------------------------------------------
  // Text report
  // -------------------------------------------------------------------

  private toMarkdown(r: DiagnosticReport): string {
    const lines: string[] = [];
    const h = (lvl: number, t: string) => lines.push("#".repeat(lvl) + " " + t, "");
    const kv = (k: string, v: string) => lines.push(`- **${k}:** ${v}`);
    const list = (items: string[]) => {
      if (items.length === 0) {
        lines.push("(none)");
        return;
      }
      for (const i of items) lines.push(`- ${i || "(root)"}`);
    };

    h(1, "Easy Git diagnostic report");
    lines.push(
      `Generated: ${r.generatedAt}`,
      `Plugin: Easy Git ${r.pluginVersion}`,
      `Obsidian: ${r.obsidianVersion} (${r.platform})`,
      "",
    );

    if (r.fetchErrors.length > 0) {
      h(2, "Fetch errors");
      list(r.fetchErrors);
      lines.push("");
    }

    h(2, "Mapping");
    kv("Name", r.mapping.name);
    kv("ID", r.mapping.id);
    kv("Direction", r.mapping.direction);
    kv("Vault folder", r.mapping.vaultFolder);
    kv("Auto mode", r.mapping.autoMode);
    kv("Wikilink rewrite", r.mapping.rewriteWikilinks);
    kv("Destinations", String(r.mapping.destinationCount));
    lines.push("");

    h(2, "Destination");
    kv("Repo", r.destination.repo);
    kv("Branch", r.destination.branch);
    kv("Remote folder", r.destination.remoteFolder);
    kv("Last sync at", r.destination.lastSyncAt ?? "(never)");
    kv("Last sync commit", r.destination.lastSyncCommit ?? "(none)");
    kv("Last sync error", r.destination.lastSyncError ?? "(none)");
    lines.push("");

    h(2, "Auth");
    kv("Method", r.auth.method);
    if (r.auth.username) kv("Username", r.auth.username);
    if (r.auth.scopes && r.auth.scopes.length > 0) kv("Scopes", r.auth.scopes.join(","));
    if (r.auth.tokenError) kv("Error", r.auth.tokenError);
    lines.push("");

    if (r.branch) {
      h(2, "Branch state (live)");
      kv("Head commit", r.branch.headCommit);
      kv("Tree SHA", r.branch.treeSha);
      kv("Commit URL", r.branch.commitUrl);
      kv("Folder URL", r.branch.folderUrl);
      lines.push("");
    }

    if (r.remoteScan?.correctedPath) {
      lines.push(
        `> NOTE: remote folder path auto-corrected from "${this.opts.destination.remoteFolder}" to "${r.remoteScan.correctedPath}" (case mismatch).`,
        "",
      );
    }
    if (r.remoteScan?.truncatedFallback) {
      lines.push(
        "> NOTE: the recursive tree response was truncated. Walked it folder-by-folder.",
        "",
      );
    }

    h(2, "Counts");
    kv("Files on remote", String(r.remoteScan?.fileCount ?? "n/a"));
    kv("Files in vault (included)", String(r.localScan.includedCount));
    kv("Hidden paths in vault", String(r.localScan.hiddenPathCount));
    kv("Files in vault excluded by patterns", String(r.localScan.excludedCount));
    kv("Files in last-sync state", String(r.lastState.count));
    kv("Would be pulled on next sync", String(r.diff.onRemoteNotLocal.length));
    kv("Same path, different SHA", String(r.diff.bothButDifferentSha.length));
    kv("In vault, not on remote", String(r.diff.onLocalNotRemote.length));
    kv("In last-sync state, not on remote", String(r.diff.inLastStateNotRemote.length));
    lines.push("");

    h(2, "Would be pulled on next sync");
    list(r.diff.onRemoteNotLocal);
    lines.push("");

    if (r.diff.bothButDifferentSha.length > 0) {
      h(2, "Same path, different SHA");
      for (const e of r.diff.bothButDifferentSha) {
        lines.push(`- ${e.path}  (remote ${e.remoteSha.slice(0, 7)} ↔ local ${e.localSha.slice(0, 7)})`);
      }
      lines.push("");
    }

    if (r.diff.onLocalNotRemote.length > 0) {
      h(2, "In vault, not on remote");
      list(r.diff.onLocalNotRemote);
      lines.push("");
    }

    if (r.diff.inLastStateNotRemote.length > 0) {
      h(2, "In last-sync state but not on remote");
      list(r.diff.inLastStateNotRemote);
      lines.push("");
    }

    h(2, "All files on remote");
    list(r.remoteScan?.paths ?? []);
    lines.push("");

    h(2, "All files in vault folder (included)");
    list(r.localScan.paths);
    lines.push("");

    if (r.localScan.excludedPaths.length > 0) {
      h(2, "Excluded by patterns");
      for (const e of r.localScan.excludedPaths) {
        lines.push(`- ${e.path}  ← \`${e.pattern}\``);
      }
      lines.push("");
    }

    h(2, "Settings");
    kv("Max file size (MB)", String(r.settings.maxFileSizeMB));
    kv("Auto-resolve by mtime", String(r.settings.autoResolveByMtime));
    kv("3-way merge text", String(r.settings.autoMergeText));
    kv(
      "Backup retention (days)",
      r.settings.backupRetentionDays > 0
        ? String(r.settings.backupRetentionDays)
        : "keep all",
    );
    kv("Notifications", String(r.settings.showNotifications));
    kv("Debug logging", String(r.settings.debugLogging));
    lines.push("");

    h(2, "Global excluded paths");
    list(r.settings.excludedPathsGlobal);
    lines.push("");

    if (r.settings.localIgnore.length > 0) {
      h(2, ".easygitignore (per-folder)");
      list(r.settings.localIgnore);
      lines.push("");
    }

    if (r.syncLogTail.length > 0) {
      h(2, "Recent sync log entries (this destination)");
      for (const e of r.syncLogTail) {
        const when = new Date(e.timestamp).toISOString();
        const status = e.ok ? "ok" : "FAIL";
        lines.push(
          `- ${when} [${status}] trigger=${e.trigger} +${e.added} ~${e.modified} -${e.deleted}` +
            (e.error ? `  error: ${e.error}` : ""),
        );
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private async copyToClipboard(text: string): Promise<void> {
    // Obsidian runs on Electron where the async Clipboard API is always
    // available, so no legacy execCommand fallback is needed.
    await navigator.clipboard.writeText(text);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
