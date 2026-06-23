import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import {
  ConflictEntry,
  FileAction,
  FileSyncRecord,
  FolderMapping,
  LastSyncState,
  LocalFileEntry,
  MappingDestination,
  PluginSettings,
  RemoteFileEntry,
  SyncResult,
  authConfigError,
  resolveApiBase,
} from "../types";
import { GitHubClient, GitHubApiError } from "../github/client";
import {
  NewTreeEntry,
  createBlob,
  createCommit,
  createTree,
  deleteFileContents,
  getBlobContent,
  getBranchHead,
  listRemoteFolderFiles,
  putFileContents,
  updateRef,
} from "../github/git-data";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToString,
  computeGitBlobShaFromArrayBuffer,
  computeGitBlobShaFromString,
  isLikelyTextPath,
} from "./blob-sha";
import {
  ResolvedConflictPlan,
  classify,
  planFromResolvedConflicts,
  renameForConflict,
} from "./classifier";
import { formatCommitMessage } from "./commit-message";
import { isExcluded } from "./exclusion";
import {
  ExtraBlob,
  WikilinkResolver,
  rewriteWikilinks,
} from "./wikilink-rewrite";
import {
  applyPullRestores,
  applyPushTransforms,
} from "./markdown-transforms";
import { merge as diff3Merge } from "node-diff3";

/** Counts returned by applyPullModify so runOnce can sum them into the
 * sync result. Only the keys whose count > 0 are set. */
interface PullRestoreCounts {
  calloutsRestored?: number;
  highlightsRestored?: number;
  mathMacrosRestored?: number;
}

export interface SyncEngineDeps {
  app: App;
  settings: PluginSettings;
  saveSettings: () => Promise<void>;
  /** Resolve conflicts. Returns the same list with `resolution` set, or null
   * if the user cancelled. The destination is passed so the modal title can
   * disambiguate when a mapping has multiple destinations. */
  resolveConflicts: (
    mapping: FolderMapping,
    destination: MappingDestination,
    conflicts: ConflictEntry[],
  ) => Promise<ConflictEntry[] | null>;
}

const MAX_NON_FF_RETRIES = 3;

export class SyncEngine {
  constructor(private deps: SyncEngineDeps) {}

  /**
   * Sync every destination of this mapping, sequentially. Returns one
   * SyncResult per destination. Independent — if destination 1 errors,
   * destination 2 still tries.
   */
  async syncMapping(mapping: FolderMapping): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const destination of mapping.destinations) {
      results.push(await this.syncDestination(mapping, destination));
    }
    // Prune old backup snapshots once per mapping-sync. Only runs if the
    // user has set a retention window in settings; failures are silent.
    try {
      await this.pruneBackups();
    } catch {
      /* never let pruning failures break a successful sync */
    }
    return results;
  }

  /**
   * One sync run for one destination. Mirrors the v0.4 single-destination
   * `runOnce` but reads/writes destination-scoped state.
   */
  private async syncDestination(
    mapping: FolderMapping,
    destination: MappingDestination,
  ): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = {
      mappingId: mapping.id,
      destinationId: destination.id,
      ok: false,
      added: 0,
      modified: 0,
      deleted: 0,
      conflicts: [],
      durationMs: 0,
    };

    const auth = this.deps.settings.auth;
    if (auth.method === "none" || !auth.token) {
      result.error = "Not signed in. Configure auth in settings.";
      result.durationMs = Date.now() - start;
      return result;
    }
    const cfgError = authConfigError(auth);
    if (cfgError) {
      result.error = cfgError;
      result.durationMs = Date.now() - start;
      return result;
    }

    const client = new GitHubClient({ token: auth.token, baseUrl: resolveApiBase(auth) });

    let attempt = 0;
    while (attempt < MAX_NON_FF_RETRIES) {
      attempt += 1;
      try {
        const outcome = await this.runOnce(client, mapping, destination);
        if (outcome === "retry") {
          await delay(backoffMs(attempt));
          continue;
        }
        Object.assign(result, outcome);
        result.ok = !outcome.error;
        result.durationMs = Date.now() - start;
        return result;
      } catch (e) {
        result.error =
          e instanceof GitHubApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
        result.durationMs = Date.now() - start;
        return result;
      }
    }
    result.error = "Remote moved during sync; gave up after retries.";
    result.durationMs = Date.now() - start;
    return result;
  }

  private async runOnce(
    client: GitHubClient,
    mapping: FolderMapping,
    destination: MappingDestination,
  ): Promise<SyncResult | "retry"> {
    const baseResult: SyncResult = {
      mappingId: mapping.id,
      destinationId: destination.id,
      ok: false,
      added: 0,
      modified: 0,
      deleted: 0,
      conflicts: [],
      durationMs: 0,
    };

    // 1. Pin remote head.
    const head = await getBranchHead(
      client,
      destination.repoOwner,
      destination.repoName,
      destination.branch,
    );

    // 2. Read remote tree.
    const remoteScan = await listRemoteFolderFiles(
      client,
      destination.repoOwner,
      destination.repoName,
      head.treeSha,
      destination.remoteFolder,
    );
    const remote = remoteScan.files;
    // Persist a one-time case correction when GitHub's remote folder
    // casing differs from what we have stored. Future syncs hit the
    // fast (exact-match) path.
    if (
      remoteScan.correctedPath &&
      remoteScan.correctedPath !== destination.remoteFolder
    ) {
      if (this.deps.settings.debugLogging) {
        console.log(
          `Easy Git: remote folder case auto-corrected ` +
            `"${destination.remoteFolder}" → "${remoteScan.correctedPath}" ` +
            `(${destination.repoOwner}/${destination.repoName})`,
        );
      }
      destination.remoteFolder = remoteScan.correctedPath;
      await this.deps.saveSettings();
    }
    if (remoteScan.truncatedFallback && this.deps.settings.showNotifications) {
      new Notice(
        `Easy Git (${mapping.name}): the ${destination.repoOwner}/${destination.repoName} ` +
          `tree is large enough that GitHub truncated the recursive listing. ` +
          `Walked it folder-by-folder to make sure nothing was missed.`,
        8000,
      );
    }
    if (this.deps.settings.debugLogging) {
      console.log(
        `Easy Git: remote scan for ${destination.repoOwner}/${destination.repoName}` +
          `:${destination.branch}/${destination.remoteFolder || "/"} → ` +
          `${Object.keys(remote).length} files at commit ${head.commitSha.slice(0, 7)}`,
      );
    }

    // 2.5 First-sync-after-v0.2 auto-enable for existing mappings.
    if (
      mapping.rewriteWikilinks === undefined &&
      !mapping.rewriteWikilinksMigrated &&
      mapping.direction !== "pull"
    ) {
      mapping.rewriteWikilinks = true;
      mapping.rewriteWikilinksMigrated = true;
      if (this.deps.settings.showNotifications) {
        new Notice(
          `Easy Git (${mapping.name}): wikilinks will be rewritten to standard Markdown so GitHub renders images. This first sync touches every .md in the mapping.`,
          8000,
        );
      }
    }

    // 3. Read local files (applies wikilink rewrite for .md when enabled).
    const localScan = await this.scanLocalFolder(mapping);
    baseResult.skippedLarge = localScan.skipped;
    if (localScan.rewrittenWikilinks > 0) {
      baseResult.rewrittenWikilinks = localScan.rewrittenWikilinks;
    }
    if (localScan.unresolvedWikilinks > 0) {
      baseResult.unresolvedWikilinks = localScan.unresolvedWikilinks;
    }
    if (localScan.excalidrawMissingCompanion > 0) {
      baseResult.excalidrawMissingCompanion = localScan.excalidrawMissingCompanion;
    }
    if (localScan.calloutsRewritten > 0) {
      baseResult.calloutsRewritten = localScan.calloutsRewritten;
    }
    if (localScan.highlightsRewritten > 0) {
      baseResult.highlightsRewritten = localScan.highlightsRewritten;
    }
    if (localScan.mathMacrosRewritten > 0) {
      baseResult.mathMacrosRewritten = localScan.mathMacrosRewritten;
    }

    // 4. Load last-sync state for THIS destination.
    const lastState: Record<string, FileSyncRecord> =
      destination.lastSyncState?.files ?? {};

    // Drop remote paths that match this mapping's exclude list. An excluded
    // file can still exist on the remote (e.g. a .obsidian/app.json that landed
    // there before the exclusion was added). Without this it is classified as
    // pull-add and the engine tries to create it locally, which fails with
    // "File already exists" because config-dir / dotfiles are not vault files
    // the create-fallback can find. Mirrors the local scan's exclude check, so
    // an excluded path is invisible on both sides.
    for (const rp of Object.keys(remote)) {
      if (
        isExcluded(rp, localScan.excludePatterns) ||
        isExcluded(vaultPathFor(mapping, rp), localScan.excludePatterns)
      ) {
        delete remote[rp];
      }
    }

    // 4.5. Multi-source pull noise filter: when the mapping is pull-only and
    // has more than one destination, the vault folder is a shared sink for
    // several upstreams. Files owned by sibling destinations would otherwise
    // appear as "local-only changes not pushed" for this destination and
    // produce noisy Notices on every sync. Strip them from this dest's view.
    const effectiveLocal =
      mapping.direction === "pull" && mapping.destinations.length > 1
        ? filterSiblingOwnedPaths(localScan.files, mapping, destination)
        : localScan.files;

    // 5. Classify.
    const plan = classify({
      local: effectiveLocal,
      remote,
      lastState,
      direction: mapping.direction,
    });

    // The same backup folder timestamp is used by both the 3-way merge
    // pre-pass and the pull-side application step below, so all files
    // affected by a single sync run cluster in one folder.
    const backupTimestamp = formatBackupTimestamp(new Date());

    // 6. Resolve conflicts.
    let conflictPlan: ResolvedConflictPlan = { extraActions: [], keepBothRenames: [] };
    if (plan.conflicts.length > 0) {
      // 6.0 Pre-pass: auto-resolve `both-edited` conflicts where the local
      // file's mtime is decisively newer than what we recorded at last sync.
      // Gated on settings.autoResolveByMtime (default on).
      if (this.deps.settings.autoResolveByMtime !== false) {
        const autoResolved = autoResolveByMtime(
          plan.conflicts,
          localScan.files,
          lastState,
        );
        baseResult.autoResolvedConflicts =
          (baseResult.autoResolvedConflicts ?? 0) + autoResolved;
      }

      // 6.05 Pre-pass: 3-way text merge for `both-edited` conflicts where
      // both sides edited disjoint regions of the same file. Uses GitHub's
      // stored blob at `lastSyncState.files[path].sha` as the common
      // ancestor — that's the same blob both sides forked from. Files
      // are pre-merged in the vault (with a backup) so the push side
      // emits the merged content via the normal keep-local path.
      // Gated on settings.autoMergeText (default on).
      if (this.deps.settings.autoMergeText !== false) {
        const mergedCount = await this.tryThreeWayMerges(
          client,
          destination,
          mapping,
          plan.conflicts,
          localScan.files,
          lastState,
          backupTimestamp,
        );
        if (mergedCount > 0) {
          baseResult.mergedConflicts =
            (baseResult.mergedConflicts ?? 0) + mergedCount;
        }
      }

      // 6.1 If anything is still unresolved, ask the user. Otherwise skip
      // the modal entirely.
      const stillAmbiguous = plan.conflicts.some((c) => !c.resolution);
      let resolvedList: ConflictEntry[] | null = plan.conflicts;
      if (stillAmbiguous) {
        resolvedList = await this.deps.resolveConflicts(
          mapping,
          destination,
          plan.conflicts,
        );
        if (!resolvedList) {
          baseResult.conflicts = plan.conflicts;
          baseResult.error = "Sync cancelled at conflict resolution.";
          return baseResult;
        }
      }
      conflictPlan = planFromResolvedConflicts(resolvedList, mapping.direction);
    }

    // Apply keep-both renames in the vault first so the rename participates
    // in the push as a new file.
    for (const { from, to } of conflictPlan.keepBothRenames) {
      await this.renameInVault(mapping, from, to);
      const entry = localScan.files[from];
      if (entry) {
        localScan.files[to] = { ...entry, path: to };
        delete localScan.files[from];
      }
    }

    const actions = [...plan.actions, ...conflictPlan.extraActions];

    // 7. Apply pull-side actions. Before any operation that destroys local
    // content (pull-modify of an existing file, pull-delete), back the file
    // up to .easy-git-backup/<timestamp>/<original-path>. Skipped when the
    // mapping direction is "pull" (user opted into remote-wins).
    // backupTimestamp was computed above so step 6.05 can use it too.
    let backupsCreated = 0;
    let calloutsRestored = 0;
    let highlightsRestored = 0;
    let mathMacrosRestored = 0;
    const accumulate = (c: PullRestoreCounts) => {
      if (c.calloutsRestored) calloutsRestored += c.calloutsRestored;
      if (c.highlightsRestored) highlightsRestored += c.highlightsRestored;
      if (c.mathMacrosRestored) mathMacrosRestored += c.mathMacrosRestored;
    };
    for (const action of actions) {
      if (action.op === "pull-modify") {
        const fullPath = vaultPathFor(mapping, action.path);
        const backed = await this.backupVaultFile(mapping, fullPath, backupTimestamp);
        if (backed) backupsCreated += 1;
        accumulate(await this.applyPullModify(mapping, destination, action, client));
      } else if (action.op === "pull-add") {
        accumulate(await this.applyPullModify(mapping, destination, action, client));
      } else if (action.op === "pull-delete") {
        const fullPath = vaultPathFor(mapping, action.path);
        const backed = await this.backupVaultFile(mapping, fullPath, backupTimestamp);
        if (backed) backupsCreated += 1;
        await this.applyPullDelete(mapping, action);
      }
    }
    if (backupsCreated > 0) {
      baseResult.backupsCreated =
        (baseResult.backupsCreated ?? 0) + backupsCreated;
      baseResult.backupFolder = `.easy-git-backup/${backupTimestamp}/`;
    }
    if (calloutsRestored > 0) baseResult.calloutsRestored = calloutsRestored;
    if (highlightsRestored > 0) baseResult.highlightsRestored = highlightsRestored;
    if (mathMacrosRestored > 0) baseResult.mathMacrosRestored = mathMacrosRestored;

    // 8. Build remote commit if push actions exist.
    const pushActions = actions.filter(
      (a) =>
        a.op === "push-add" || a.op === "push-modify" || a.op === "push-delete",
    );

    let newCommitSha: string | undefined;
    if (pushActions.length > 0) {
      if (this.deps.settings.auth.provider === "forgejo") {
        // Forgejo does not implement the Git Data write API (POST /git/blobs,
        // /git/trees, /git/commits, PATCH /git/refs). Use the contents API
        // instead — one commit per changed file.
        const sha = await this.pushViaContentsApi(
          client,
          mapping,
          destination,
          pushActions,
          localScan.files,
          remote,
          head.commitSha,
        );
        if (sha === null) {
          // Non-fast-forward: someone pushed during our run.
          return "retry";
        }
        newCommitSha = sha || undefined;
      } else {
        const commitResult = await this.buildAndPushCommit(
          client,
          mapping,
          destination,
          head.commitSha,
          head.treeSha,
          pushActions,
          localScan.files,
        );
        if (commitResult === null) {
          // Non-fast-forward: someone pushed during our run.
          return "retry";
        }
        newCommitSha = commitResult;
      }
    }

    // 9. Persist new last-sync state on the destination.
    const newState = computeNewState(
      newCommitSha ?? head.commitSha,
      head.treeSha,
      actions,
      localScan.files,
      remote,
      lastState,
    );
    destination.lastSyncState = newState;
    destination.lastSyncAt = Date.now();
    destination.lastSyncError = undefined;
    await this.deps.saveSettings();

    // 10. Counts for the result.
    const changedPaths: string[] = [];
    for (const a of actions) {
      if (a.op === "noop") continue;
      changedPaths.push(a.path);
      if (a.op === "push-add" || a.op === "pull-add") baseResult.added += 1;
      else if (a.op === "push-modify" || a.op === "pull-modify") baseResult.modified += 1;
      else if (a.op === "push-delete" || a.op === "pull-delete") baseResult.deleted += 1;
    }
    baseResult.commitSha = newCommitSha;
    baseResult.conflicts = plan.conflicts.map((c) => ({ ...c }));
    baseResult.changedPaths = changedPaths;

    const destLabel = destinationLabel(destination);
    if (mapping.direction === "push" && plan.informationalRemoteChanges.length > 0) {
      const n = plan.informationalRemoteChanges.length;
      if (this.deps.settings.showNotifications) {
        new Notice(
          `Easy Git (${mapping.name} → ${destLabel}): ${n} file${n === 1 ? "" : "s"} changed on remote (not pulled — push-only mapping).`,
        );
      }
    }
    if (mapping.direction === "pull" && plan.informationalLocalChanges.length > 0) {
      const n = plan.informationalLocalChanges.length;
      if (this.deps.settings.showNotifications) {
        new Notice(
          `Easy Git (${mapping.name} → ${destLabel}): ${n} file${n === 1 ? "" : "s"} changed locally (not pushed — pull-only mapping).`,
        );
      }
    }
    return baseResult;
  }

  /**
   * Per-sync caches for the wikilink rewriter so we don't read+rewrite each .md
   * file twice (once during the SHA scan, once during push).
   */
  private rewriteContentCache: Map<string, string> = new Map();
  private attachmentSourceMap: Map<string, string> = new Map();

  private async scanLocalFolder(
    mapping: FolderMapping,
  ): Promise<{
    files: Record<string, LocalFileEntry>;
    skipped: string[];
    unresolvedWikilinks: number;
    rewrittenWikilinks: number;
    excalidrawMissingCompanion: number;
    calloutsRewritten: number;
    highlightsRewritten: number;
    mathMacrosRewritten: number;
    excludePatterns: string[];
  }> {
    const isWholeVault = isVaultRoot(mapping.vaultFolder);
    let folder: TFolder | null;
    if (isWholeVault) {
      folder = this.deps.app.vault.getRoot();
    } else {
      // Normalize: strip leading/trailing slashes before lookup. Stored paths
      // sometimes have a trailing slash that getFolderByPath doesn't accept.
      const normalized = mapping.vaultFolder.replace(/^\/+|\/+$/g, "");
      folder = this.deps.app.vault.getFolderByPath(normalized);

      // Case-insensitive fallback: walks the vault looking for a folder whose
      // path matches case-insensitively. Covers the case where the user
      // renamed the folder's casing on a case-insensitive filesystem (macOS,
      // Windows) and the metadata cache stores a different casing than the
      // mapping. Auto-fixes the saved path on success so future syncs hit
      // the fast path.
      if (!folder) {
        const targetLower = normalized.toLowerCase();
        for (const f of this.deps.app.vault.getAllFolders()) {
          if (f.path.toLowerCase() === targetLower) {
            folder = f;
            mapping.vaultFolder = f.path;
            await this.deps.saveSettings();
            break;
          }
        }
      }
    }

    // Safety net: if the configured folder really doesn't exist (renamed/moved
    // outside Obsidian or deleted), refuse to sync. Without this we'd treat
    // every previously-synced file as locally-deleted and push the deletions.
    if (!folder) {
      throw new Error(
        `Vault folder "${mapping.vaultFolder}" no longer exists. Edit the mapping or restore the folder.`,
      );
    }

    const files: Record<string, LocalFileEntry> = {};
    const skipped: string[] = [];
    const localIgnore = await this.loadLocalIgnore(mapping);
    const excludePatterns = [
      ".easygitignore",
      ".easy-git-backup/**",
      ...this.deps.settings.excludedPaths,
      ...localIgnore,
    ];
    const maxBytes = this.deps.settings.maxFileSizeBytes;

    this.rewriteContentCache = new Map();
    this.attachmentSourceMap = new Map();

    const rewriteOn = isRewriteEnabled(mapping) && mapping.direction !== "pull";
    let unresolvedWikilinks = 0;
    let rewrittenWikilinks = 0;
    let excalidrawMissingCompanion = 0;
    let calloutsRewritten = 0;
    let highlightsRewritten = 0;
    let mathMacrosRewritten = 0;
    const accumulatedExtraBlobs: ExtraBlob[] = [];

    const stack: TFolder[] = [folder];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const child of cur.children) {
        if (child instanceof TFolder) {
          stack.push(child);
        } else if (child instanceof TFile) {
          const relPath = relativeTo(mapping.vaultFolder, child.path);
          if (isExcluded(child.path, excludePatterns) || isExcluded(relPath, excludePatterns)) {
            continue;
          }
          if (child.stat.size > maxBytes) {
            skipped.push(relPath);
            continue;
          }
          if (rewriteOn && child.extension === "md") {
            const text = await this.deps.app.vault.read(child);
            const result = rewriteWikilinks(text, {
              sourcePath: child.path,
              mappingVaultFolder: mapping.vaultFolder,
              mappingRemoteFolder: "",
              resolve: this.makeResolver(),
            });
            // Second pass: GitHub-rendering rewrites (callouts, highlights,
            // math). All three embed restore markers so the pull side can
            // invert them losslessly. Same gate as wikilink rewrite.
            const renderResult = applyPushTransforms(result.markdown);
            const finalText = renderResult.markdown;
            unresolvedWikilinks += result.unresolvedCount;
            rewrittenWikilinks += result.rewrittenCount;
            excalidrawMissingCompanion += result.excalidrawMissingCompanion;
            calloutsRewritten += renderResult.calloutsRewritten;
            highlightsRewritten += renderResult.highlightsRewritten;
            mathMacrosRewritten += renderResult.mathMacrosRewritten;
            for (const blob of result.extraBlobs) {
              accumulatedExtraBlobs.push(blob);
            }
            this.rewriteContentCache.set(relPath, finalText);
            files[relPath] = {
              path: relPath,
              sha: await computeGitBlobShaFromString(finalText),
              size: new TextEncoder().encode(finalText).byteLength,
              mtime: child.stat.mtime,
            };
          } else {
            const sha = await this.computeLocalSha(child);
            files[relPath] = {
              path: relPath,
              sha,
              size: child.stat.size,
              mtime: child.stat.mtime,
            };
          }
        }
      }
    }

    // Second pass: pick up dotfiles (.gitkeep, .gitignore, etc.) that
    // Obsidian's vault layer filters out of TFolder.children. We walk the
    // same folders via the low-level adapter, find files starting with `.`
    // that we didn't already capture, and add them to the scan. Without
    // this the classifier would emit pull-add for the same dotfile on
    // every sync because local "doesn't have it" from the vault's POV —
    // and the create would fail because the file IS on disk.
    //
    // We use the same folder set as the TFolder walk; dot-FOLDERS aren't
    // handled here (TFolder walk doesn't enter them either) — that's a
    // rarer case and the apply path's adapter fallback already keeps it
    // functional, just noisy.
    await this.augmentScanWithDotfiles(folder, mapping, files, excludePatterns, maxBytes);

    // Fold the deduplicated extra blobs (out-of-folder attachments) into the
    // local file map so the classifier treats them as locally-present files
    // at attachments/<basename> under the mapping.
    const seenRemotePaths = new Set<string>();
    for (const blob of accumulatedExtraBlobs) {
      if (seenRemotePaths.has(blob.remoteRelPath)) continue;
      seenRemotePaths.add(blob.remoteRelPath);
      const sourceFile = this.deps.app.vault.getFileByPath(blob.vaultPath);
      if (!sourceFile) continue;
      if (sourceFile.stat.size > maxBytes) {
        skipped.push(blob.remoteRelPath);
        continue;
      }
      const sha = await this.computeLocalSha(sourceFile);
      files[blob.remoteRelPath] = {
        path: blob.remoteRelPath,
        sha,
        size: sourceFile.stat.size,
        mtime: sourceFile.stat.mtime,
      };
      this.attachmentSourceMap.set(blob.remoteRelPath, blob.vaultPath);
    }

    return {
      files,
      skipped,
      unresolvedWikilinks,
      rewrittenWikilinks,
      excalidrawMissingCompanion,
      calloutsRewritten,
      highlightsRewritten,
      mathMacrosRewritten,
      excludePatterns,
    };
  }

  /**
   * For each `both-edited` conflict that's safe to merge, fetch the common
   * ancestor blob from GitHub (the SHA we recorded at lastSync — that's what
   * both sides forked from), run a 3-way text merge, and if it's clean,
   * write the merged content to the vault (with a pre-merge backup) so the
   * push side sends the merged file via the normal keep-local path.
   *
   * Skipped for:
   *   - non-text files (binary by extension)
   *   - `.md` files in mappings with wikilink rewrite on — the local SHA on
   *     record is of the rewritten markdown, not the wikilink-form vault
   *     content, so writing rewritten merged content back to the vault
   *     would destroy the user's wikilink notation
   *
   * Returns the number of conflicts cleanly merged.
   */
  private async tryThreeWayMerges(
    client: GitHubClient,
    destination: MappingDestination,
    mapping: FolderMapping,
    conflicts: ConflictEntry[],
    localFiles: Record<string, LocalFileEntry>,
    lastState: Record<string, FileSyncRecord>,
    backupTimestamp: string,
  ): Promise<number> {
    let merged = 0;
    const rewriteOn = isRewriteEnabled(mapping) && mapping.direction !== "pull";

    for (const c of conflicts) {
      if (c.resolution) continue;
      if (c.kind !== "both-edited") continue;
      if (!c.localSha || !c.remoteSha) continue;
      const baseFileSha = lastState[c.path]?.sha;
      if (!baseFileSha) continue;

      // Gate: text only.
      if (!isLikelyTextPath(c.path)) continue;

      // Gate: skip rewritten .md files (writing merged rewritten content
      // back to the vault would convert wikilinks to markdown).
      const isMd = c.path.toLowerCase().endsWith(".md");
      if (isMd && rewriteOn) continue;

      try {
        // Fetch base + remote blob contents from GitHub. Local content comes
        // from the vault directly.
        const [baseBlob, remoteBlob] = await Promise.all([
          getBlobContent(client, destination.repoOwner, destination.repoName, baseFileSha),
          getBlobContent(client, destination.repoOwner, destination.repoName, c.remoteSha),
        ]);
        const baseText = base64ToString(baseBlob.content);
        const remoteText = base64ToString(remoteBlob.content);

        const vaultPath = vaultPathFor(mapping, c.path);
        const file = this.deps.app.vault.getFileByPath(vaultPath);
        if (!file) continue;
        const localText = await this.deps.app.vault.read(file);

        // Run diff3. node-diff3.merge(a, base, b) → { conflict, result: lines }.
        const result = diff3Merge(
          localText.split("\n"),
          baseText.split("\n"),
          remoteText.split("\n"),
        );
        if (result.conflict) continue;

        // Backup the existing local content before overwrite.
        await this.backupVaultFile(mapping, vaultPath, backupTimestamp);

        const mergedText = result.result.join("\n");
        await this.deps.app.vault.modify(file, mergedText);

        // Update the in-memory local scan so push-modify reads the new SHA.
        const newSha = await computeGitBlobShaFromString(mergedText);
        localFiles[c.path] = {
          path: c.path,
          sha: newSha,
          size: new TextEncoder().encode(mergedText).byteLength,
          mtime: Date.now(),
        };

        c.resolution = "keep-local";
        merged += 1;
      } catch {
        // Any failure (network, decode, write) → leave for the modal.
        continue;
      }
    }
    return merged;
  }

  /**
   * Snapshot the current local content of a vault file to
   * `.easy-git-backup/<timestamp>/<vaultPath>` before an operation that
   * would overwrite or delete it.
   *
   * Returns true on success, false if no backup was needed (no existing
   * local file). Throws on write failure — the caller aborts the whole
   * sync rather than risk losing the original.
   *
   * Backs up for EVERY direction, including pull-only. The original v1.3
   * spec skipped pull-only on the assumption "user opted into remote-
   * wins"; v1.4.7 made the pull-only classifier reconcile aggressively
   * against remote, so any local file the user accidentally edited could
   * be overwritten without warning. The backup folder is the safety net.
   */
  private async backupVaultFile(
    mapping: FolderMapping,
    vaultPath: string,
    timestamp: string,
  ): Promise<boolean> {
    // mapping parameter is kept for API stability; behaviour no longer
    // varies by direction.
    void mapping;
    const adapter = this.deps.app.vault.adapter;
    const file = this.deps.app.vault.getFileByPath(vaultPath);
    // Fallback for dotfiles and anything else vault.getFileByPath misses:
    // check the disk directly via the adapter.
    const onDisk = file ? true : await adapter.exists(vaultPath);
    if (!file && !onDisk) return false;

    const backupPath = `.easy-git-backup/${timestamp}/${vaultPath}`;
    await ensureVaultFolder(this.deps.app, parentOf(backupPath));

    try {
      if (file) {
        // Vault API path — preserves Obsidian's internal indexing.
        if (isLikelyTextPath(file.path)) {
          const text = await this.deps.app.vault.read(file);
          await this.deps.app.vault.create(backupPath, text);
        } else {
          const buf = await this.deps.app.vault.readBinary(file);
          await this.deps.app.vault.createBinary(backupPath, buf);
        }
      } else {
        // Adapter path — for dotfiles vault.getFileByPath couldn't see.
        if (isLikelyTextPath(vaultPath)) {
          const text = await adapter.read(vaultPath);
          await adapter.write(backupPath, text);
        } else {
          const buf = await adapter.readBinary(vaultPath);
          await adapter.writeBinary(backupPath, buf);
        }
      }
      return true;
    } catch (e) {
      // Adapter sometimes errors on duplicate paths within the same second.
      // Treat any failure as fatal — we promised local would not be lost.
      throw new Error(
        `Easy Git: could not back up "${vaultPath}" before overwrite (${
          e instanceof Error ? e.message : String(e)
        }). Sync aborted to prevent data loss.`,
      );
    }
  }

  /**
   * Prune `.easy-git-backup/<timestamp>/` subfolders older than
   * `settings.backupRetentionDays`. No-op when unset, 0, or negative.
   *
   * Timestamps live in the folder name (`YYYY-MM-DD-HHmmss`) so we don't
   * need to read mtimes — we just parse the name. Unparseable names are
   * left alone (forward-compatible if we ever change the format).
   */
  private async pruneBackups(): Promise<number> {
    const days = this.deps.settings.backupRetentionDays;
    if (!days || days <= 0) return 0;
    const root = this.deps.app.vault.getFolderByPath(".easy-git-backup");
    if (!root) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let pruned = 0;
    // Snapshot children first — deleting mutates root.children mid-iteration.
    const children = [...root.children];
    for (const child of children) {
      if (!(child instanceof TFolder)) continue;
      const m = child.name.match(
        /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/,
      );
      if (!m) continue;
      const ts = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
      ).getTime();
      if (Number.isNaN(ts) || ts >= cutoff) continue;
      try {
        // Recursive delete via the adapter.
        await this.deps.app.vault.adapter.rmdir(child.path, true);
        pruned += 1;
      } catch {
        /* leave the folder; we'll try again next sync */
      }
    }
    return pruned;
  }

  /**
   * Read a `.easygitignore` file at the root of the mapping's vault folder.
   * Returns an array of pattern strings (with comments and blank lines preserved
   * — `isExcluded` already strips them). Returns [] if the file doesn't exist.
   */
  private async loadLocalIgnore(mapping: FolderMapping): Promise<string[]> {
    const folder = isVaultRoot(mapping.vaultFolder)
      ? ""
      : mapping.vaultFolder.replace(/^\/+|\/+$/g, "");
    const path = folder ? `${folder}/.easygitignore` : ".easygitignore";
    const file = this.deps.app.vault.getFileByPath(path);
    if (!file) return [];
    try {
      const text = await this.deps.app.vault.read(file);
      return text.split(/\r?\n/);
    } catch {
      return [];
    }
  }

  private makeResolver(): WikilinkResolver {
    const md = this.deps.app.metadataCache;
    return (linkpath, sourcePath) => {
      const file = md.getFirstLinkpathDest(linkpath, sourcePath);
      return file ? { path: file.path } : null;
    };
  }

  private async computeLocalSha(file: TFile): Promise<string> {
    if (isLikelyTextPath(file.path)) {
      const text = await this.deps.app.vault.read(file);
      return computeGitBlobShaFromString(text);
    }
    const buf = await this.deps.app.vault.readBinary(file);
    return computeGitBlobShaFromArrayBuffer(buf);
  }

  /**
   * Walk the mapping's vault folder tree at the low-level adapter layer
   * and add any dotfile (basename starts with `.`) that the TFolder walk
   * missed. Obsidian's TFolder.children filters dotfiles out of its
   * results, so a `.gitkeep` or `.gitignore` that exists on disk would
   * otherwise be invisible to the engine — and the next sync would try
   * to pull it again, hit "file already exists" on the apply, and abort.
   *
   * Cheap: one `adapter.list()` per folder we already visited (Obsidian
   * caches these). Only computes SHAs for the dotfiles found.
   */
  private async augmentScanWithDotfiles(
    rootFolder: TFolder,
    mapping: FolderMapping,
    files: Record<string, LocalFileEntry>,
    excludePatterns: string[],
    maxBytes: number,
  ): Promise<void> {
    const adapter = this.deps.app.vault.adapter;
    // Collect every folder path we visited so we can re-walk via adapter.
    const folderPaths: string[] = [];
    const stack: TFolder[] = [rootFolder];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      folderPaths.push(cur.path);
      for (const child of cur.children) {
        if (child instanceof TFolder) stack.push(child);
      }
    }

    for (const folderPath of folderPaths) {
      let listing: { files: string[]; folders: string[] };
      try {
        // adapter.list expects "" for vault root; TFolder.getRoot().path is "".
        listing = await adapter.list(folderPath || "/");
      } catch {
        continue;
      }
      for (const filePath of listing.files) {
        const basename = filePath.substring(filePath.lastIndexOf("/") + 1);
        if (!basename.startsWith(".")) continue;
        // Already captured by the TFolder walk? Skip.
        const relPath = relativeTo(mapping.vaultFolder, filePath);
        if (files[relPath]) continue;
        // Honour the exclude list — dotfiles get the same treatment as
        // normal files, so a `.git/**` global exclude still blocks
        // `.git/whatever`, etc.
        if (
          isExcluded(filePath, excludePatterns) ||
          isExcluded(relPath, excludePatterns)
        ) {
          continue;
        }
        // Size + content via the adapter (vault.read can't access this).
        let stat: { size: number; mtime: number } | null;
        try {
          stat = await adapter.stat(filePath);
        } catch {
          continue;
        }
        if (!stat || stat.size > maxBytes) continue;
        let sha: string;
        try {
          if (isLikelyTextPath(filePath)) {
            const text = await adapter.read(filePath);
            sha = await computeGitBlobShaFromString(text);
          } else {
            const buf = await adapter.readBinary(filePath);
            sha = await computeGitBlobShaFromArrayBuffer(buf);
          }
        } catch {
          continue;
        }
        files[relPath] = {
          path: relPath,
          sha,
          size: stat.size,
          mtime: stat.mtime,
        };
      }
    }
  }

  private async applyPullModify(
    mapping: FolderMapping,
    destination: MappingDestination,
    action: FileAction,
    client: GitHubClient,
  ): Promise<PullRestoreCounts> {
    const counts: PullRestoreCounts = {};
    if (!action.remoteSha) return counts;
    const fullPath = vaultPathFor(mapping, action.path);
    try {
      const blob = await getBlobContent(
        client,
        destination.repoOwner,
        destination.repoName,
        action.remoteSha,
      );
      await ensureVaultFolder(this.deps.app, parentOf(fullPath));
      const existing =
        this.deps.app.vault.getFileByPath(fullPath) ??
        findFileCaseInsensitive(this.deps.app, fullPath);
      const isText = isLikelyTextPath(fullPath) && blob.encoding !== "base64-binary";
      if (isText) {
        let text = base64ToString(blob.content);
        // Pull-side restore: invert the push-time GitHub rendering
        // rewrites (callouts, highlights, math) for .md files when
        // rewriteWikilinks is enabled. No-op on files that have no
        // markers (i.e. files never push-processed) — pure function.
        if (
          isRewriteEnabled(mapping) &&
          mapping.direction !== "push" &&
          fullPath.toLowerCase().endsWith(".md")
        ) {
          const restored = applyPullRestores(text);
          text = restored.markdown;
          if (restored.calloutsRestored > 0) counts.calloutsRestored = restored.calloutsRestored;
          if (restored.highlightsRestored > 0) counts.highlightsRestored = restored.highlightsRestored;
          if (restored.mathMacrosRestored > 0) counts.mathMacrosRestored = restored.mathMacrosRestored;
        }
        if (existing) {
          await this.deps.app.vault.modify(existing, text);
        } else {
          await this.createOrFallbackText(fullPath, text);
        }
      } else {
        const buf = base64ToArrayBuffer(blob.content);
        if (existing) {
          await this.deps.app.vault.modifyBinary(existing, buf);
        } else {
          await this.createOrFallbackBinary(fullPath, buf);
        }
      }
    } catch (e) {
      throw annotateWithPath(e, fullPath);
    }
    return counts;
  }

  /**
   * Create a text file. Handles two filesystem realities the high-level
   * vault API can't:
   *
   * 1. Case-insensitive collisions (macOS/Windows): vault.create rejects
   *    if a same-name-different-case file exists. Fall back to modify.
   * 2. Files Obsidian's vault layer doesn't index — most notably dotfiles
   *    like `.gitkeep` and `.gitignore` (Obsidian filters them out of
   *    getFiles()/getFileByPath()) even when they exist on disk. The
   *    high-level create rejects ("already exists") AND the vault-API
   *    lookup returns null. Last resort: write via the low-level adapter
   *    which is filesystem-faithful. That covers anything the vault
   *    abstraction hides.
   */
  private async createOrFallbackText(path: string, text: string): Promise<void> {
    try {
      await this.deps.app.vault.create(path, text);
      return;
    } catch (e) {
      if (!/already exists/i.test(String(e))) throw e;
    }
    const existing = findFileCaseInsensitive(this.deps.app, path);
    if (existing) {
      await this.deps.app.vault.modify(existing, text);
      return;
    }
    // Adapter fallback for dotfiles and anything else vault.getFiles()
    // doesn't surface.
    await this.deps.app.vault.adapter.write(path, text);
  }

  private async createOrFallbackBinary(path: string, buf: ArrayBuffer): Promise<void> {
    try {
      await this.deps.app.vault.createBinary(path, buf);
      return;
    } catch (e) {
      if (!/already exists/i.test(String(e))) throw e;
    }
    const existing = findFileCaseInsensitive(this.deps.app, path);
    if (existing) {
      await this.deps.app.vault.modifyBinary(existing, buf);
      return;
    }
    await this.deps.app.vault.adapter.writeBinary(path, buf);
  }

  private async applyPullDelete(
    mapping: FolderMapping,
    action: FileAction,
  ): Promise<void> {
    const fullPath = vaultPathFor(mapping, action.path);
    try {
      const existing =
        this.deps.app.vault.getFileByPath(fullPath) ??
        findFileCaseInsensitive(this.deps.app, fullPath);
      // Use trashFile so the deletion respects the user's "deleted files"
      // preference (system trash / .trash / permanent) instead of hard-deleting.
      if (existing) await this.deps.app.fileManager.trashFile(existing);
    } catch (e) {
      throw annotateWithPath(e, fullPath);
    }
  }

  private async renameInVault(
    mapping: FolderMapping,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const fromPath = vaultPathFor(mapping, fromRel);
    const toPath = vaultPathFor(mapping, toRel);
    const file = this.deps.app.vault.getFileByPath(fromPath);
    if (!file) return;
    await ensureVaultFolder(this.deps.app, parentOf(toPath));
    await this.deps.app.fileManager.renameFile(file, toPath);
  }

  /**
   * Push files to Forgejo via the contents API (PUT/DELETE /contents/{path}).
   * Used instead of buildAndPushCommit because Forgejo does not implement the
   * Git Data write endpoints. Produces one commit per changed file.
   *
   * Returns the SHA of the last commit created, "" if no actions ran, or null
   * if a write was rejected because the branch moved under us (non-fast-forward)
   * so the caller can re-pin head and retry, mirroring the GitHub path.
   *
   * Note: because each file is its own commit, a push is not atomic. A failure
   * partway leaves the already-written files committed; the next sync reconciles
   * them as no-ops (local SHA matches the new remote SHA), so no data is lost.
   */
  private async pushViaContentsApi(
    client: GitHubClient,
    mapping: FolderMapping,
    destination: MappingDestination,
    pushActions: FileAction[],
    localFiles: Record<string, LocalFileEntry>,
    remote: Record<string, RemoteFileEntry>,
    baseCommitSha: string,
  ): Promise<string | null> {
    let lastCommitSha = "";
    // The commit the branch is expected to be at before each write: starts at
    // the pinned head and advances to every commit we create, so a conflict can
    // be told apart from our own commits by re-pinning and comparing.
    let expectedHead = baseCommitSha;
    const prefix = `[Easy Git] ${mapping.name}`;

    for (const action of pushActions) {
      const fullRepoPath = repoPathFor(destination, action.path);

      try {
        if (action.op === "push-delete") {
          const existingSha = remote[action.path]?.sha;
          if (!existingSha) continue;
          lastCommitSha = await deleteFileContents(
            client,
            destination.repoOwner,
            destination.repoName,
            fullRepoPath,
            `${prefix}: delete ${action.path}`,
            destination.branch,
            existingSha,
          );
        } else {
          const content = await this.readVaultFile(mapping, action.path);
          const existingSha = action.op === "push-modify" ? remote[action.path]?.sha : undefined;
          const opLabel = action.op === "push-add" ? "add" : "update";
          const result = await putFileContents(
            client,
            destination.repoOwner,
            destination.repoName,
            fullRepoPath,
            content.base64,
            `${prefix}: ${opLabel} ${action.path}`,
            destination.branch,
            existingSha,
          );
          lastCommitSha = result.commitSha;
        }
        expectedHead = lastCommitSha;
      } catch (e) {
        // Forgejo's contents API rejects a write with a conflict (409/422) when
        // the file SHA we hold is stale, i.e. the branch moved under us. Confirm
        // it was a concurrent push (head differs from the last commit we made,
        // not our own commits) and signal a non-fast-forward retry if so.
        if (e instanceof GitHubApiError && (e.status === 409 || e.status === 422)) {
          const fresh = await getBranchHead(
            client,
            destination.repoOwner,
            destination.repoName,
            destination.branch,
          );
          if (fresh.commitSha && fresh.commitSha !== expectedHead) {
            return null;
          }
        }
        throw e;
      }
    }

    return lastCommitSha;
  }

  private async buildAndPushCommit(
    client: GitHubClient,
    mapping: FolderMapping,
    destination: MappingDestination,
    baseCommitSha: string,
    baseTreeSha: string,
    pushActions: FileAction[],
    localFiles: Record<string, LocalFileEntry>,
  ): Promise<string | null> {
    const treeEntries: NewTreeEntry[] = [];
    let added = 0,
      modified = 0,
      deleted = 0;
    const changedFiles: string[] = [];

    for (const action of pushActions) {
      const fullRepoPath = repoPathFor(destination, action.path);
      changedFiles.push(action.path);
      if (action.op === "push-delete") {
        treeEntries.push({
          path: fullRepoPath,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        deleted += 1;
        continue;
      }

      const local = localFiles[action.path];
      if (!local) continue;
      const content = await this.readVaultFile(mapping, action.path);
      const blobSha = await createBlob(
        client,
        destination.repoOwner,
        destination.repoName,
        content.base64,
      );
      treeEntries.push({
        path: fullRepoPath,
        mode: "100644",
        type: "blob",
        sha: blobSha,
      });
      if (action.op === "push-add") added += 1;
      else if (action.op === "push-modify") modified += 1;
    }

    const newTreeSha = await createTree(
      client,
      destination.repoOwner,
      destination.repoName,
      baseTreeSha,
      treeEntries,
    );
    const template = mapping.commitTemplate ?? this.deps.settings.defaultCommitTemplate;
    const message = formatCommitMessage(template, {
      mappingName: mapping.name,
      vaultName: this.deps.app.vault.getName(),
      added,
      modified,
      deleted,
      files: changedFiles,
    });
    const newCommitSha = await createCommit(
      client,
      destination.repoOwner,
      destination.repoName,
      message,
      newTreeSha,
      [baseCommitSha],
    );
    const ok = await updateRef(
      client,
      destination.repoOwner,
      destination.repoName,
      destination.branch,
      newCommitSha,
    );
    if (!ok) return null;
    return newCommitSha;
  }

  private async readVaultFile(
    mapping: FolderMapping,
    relPath: string,
  ): Promise<{ base64: string }> {
    // Cached rewritten markdown content (computed during scan).
    const cached = this.rewriteContentCache.get(relPath);
    if (cached !== undefined) {
      const bytes = new TextEncoder().encode(cached);
      return { base64: arrayBufferToBase64(bytes.buffer) };
    }
    // Out-of-folder attachment: read from its real vault path.
    const attachmentSource = this.attachmentSourceMap.get(relPath);
    if (attachmentSource) {
      const sourceFile = this.deps.app.vault.getFileByPath(attachmentSource);
      if (!sourceFile) {
        throw new Error(`Attachment source not found: ${attachmentSource}`);
      }
      const buf = await this.deps.app.vault.readBinary(sourceFile);
      return { base64: arrayBufferToBase64(buf) };
    }

    const fullPath = vaultPathFor(mapping, relPath);
    const file = this.deps.app.vault.getFileByPath(fullPath);
    if (!file) throw new Error(`Vault file not found: ${fullPath}`);
    if (isLikelyTextPath(file.path)) {
      const text = await this.deps.app.vault.read(file);
      const bytes = new TextEncoder().encode(text);
      return { base64: arrayBufferToBase64(bytes.buffer) };
    }
    const buf = await this.deps.app.vault.readBinary(file);
    return { base64: arrayBufferToBase64(buf) };
  }
}

/**
 * True if this mapping should have its .md files rewritten on push.
 * Treats `undefined` as `true` (auto-enable on first sync after v0.2 upgrade).
 */
export function isRewriteEnabled(mapping: FolderMapping): boolean {
  return mapping.rewriteWikilinks !== false;
}

/** Short "owner/repo:branch/path" label for messages and modal titles. */
export function destinationLabel(d: MappingDestination): string {
  const remote = d.remoteFolder || "/";
  return `${d.repoOwner}/${d.repoName}:${d.branch}/${remote}`;
}

/**
 * Format a Date as `YYYY-MM-DD-HHmm` for use in the backup folder name.
 * Stable, sortable, filesystem-safe, and gives one folder per sync run.
 */
function formatBackupTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Auto-resolve `both-edited` conflicts where the local file's mtime is
 * decisively newer than the mtime recorded in lastSyncState. Mutates the
 * conflicts in place to set `resolution: "keep-local"` when the heuristic
 * is confident. Other conflict kinds and ambiguous cases are left alone.
 *
 * The 2-second grace handles filesystem mtime jitter and intra-sync writes.
 * "Local is newer" is the safe direction to auto-resolve in: it just means
 * we're pushing the user's recent edit. "Remote is newer" requires more
 * signal (we don't have remote-side mtime) so it stays a user decision.
 */
function autoResolveByMtime(
  conflicts: ConflictEntry[],
  localFiles: Record<string, LocalFileEntry>,
  lastState: Record<string, FileSyncRecord>,
): number {
  const GRACE_MS = 2000;
  let count = 0;
  for (const c of conflicts) {
    if (c.resolution) continue;
    if (c.kind !== "both-edited") continue;
    const local = localFiles[c.path];
    const last = lastState[c.path];
    if (!local?.mtime || !last?.mtime) continue;
    if (local.mtime > last.mtime + GRACE_MS) {
      c.resolution = "keep-local";
      count += 1;
    }
  }
  return count;
}

/**
 * Remove paths that are tracked by other destinations of the same mapping.
 * Used in the pull-multi-source case to keep each destination focused on its
 * own subset of the shared vault folder.
 */
function filterSiblingOwnedPaths(
  localFiles: Record<string, LocalFileEntry>,
  mapping: FolderMapping,
  current: MappingDestination,
): Record<string, LocalFileEntry> {
  const siblingPaths = new Set<string>();
  for (const other of mapping.destinations) {
    if (other.id === current.id) continue;
    const files = other.lastSyncState?.files;
    if (!files) continue;
    for (const path of Object.keys(files)) {
      siblingPaths.add(path);
    }
  }
  if (siblingPaths.size === 0) return localFiles;
  const out: Record<string, LocalFileEntry> = {};
  for (const [path, entry] of Object.entries(localFiles)) {
    if (!siblingPaths.has(path)) out[path] = entry;
  }
  return out;
}

function computeNewState(
  newCommitSha: string,
  baseTreeSha: string,
  actions: FileAction[],
  localFiles: Record<string, LocalFileEntry>,
  remote: Record<string, RemoteFileEntry>,
  prior: Record<string, FileSyncRecord>,
): LastSyncState {
  const files: Record<string, FileSyncRecord> = { ...prior };

  for (const action of actions) {
    switch (action.op) {
      case "push-add":
      case "push-modify": {
        const l = localFiles[action.path];
        if (l) files[action.path] = { sha: l.sha, size: l.size, mtime: l.mtime };
        break;
      }
      case "pull-add":
      case "pull-modify": {
        const r = remote[action.path];
        const l = localFiles[action.path];
        if (r) {
          files[action.path] = {
            sha: r.sha,
            size: r.size,
            mtime: l?.mtime,
          };
        }
        break;
      }
      case "push-delete":
      case "pull-delete":
        delete files[action.path];
        break;
      default:
        break;
    }
  }

  // Walk every file currently present locally that wasn't part of an action;
  // if its sha matches the remote sha (e.g. unchanged on both sides), record it
  // so we can detect divergence on the next run.
  for (const [path, l] of Object.entries(localFiles)) {
    if (files[path]) continue;
    const r = remote[path];
    if (r && r.sha === l.sha) {
      files[path] = { sha: l.sha, size: l.size, mtime: l.mtime };
    }
  }

  return {
    baseCommitSha: newCommitSha,
    baseTreeSha,
    files,
  };
}

function vaultPathFor(mapping: FolderMapping, relPath: string): string {
  if (isVaultRoot(mapping.vaultFolder)) return normalizePath(relPath);
  const folder = mapping.vaultFolder.replace(/^\/+|\/+$/g, "");
  return normalizePath(folder ? `${folder}/${relPath}` : relPath);
}

/** True if the mapping's vaultFolder represents "the whole vault" (root). */
export function isVaultRoot(vaultFolder: string): boolean {
  const trimmed = vaultFolder.trim();
  return trimmed === "" || trimmed === "/";
}

function repoPathFor(destination: MappingDestination, relPath: string): string {
  const folder = destination.remoteFolder.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${relPath}` : relPath;
}

function relativeTo(base: string, fullPath: string): string {
  if (isVaultRoot(base)) return fullPath;
  const b = base.replace(/^\/+|\/+$/g, "");
  if (!b) return fullPath;
  if (fullPath === b) return "";
  if (fullPath.startsWith(b + "/")) return fullPath.slice(b.length + 1);
  return fullPath;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

async function ensureVaultFolder(app: App, path: string): Promise<void> {
  if (!path) return;
  const existing = app.vault.getFolderByPath(path);
  if (existing) return;
  await app.vault.createFolder(path).catch((e) => {
    if (!/already exists/i.test(String(e))) throw e;
  });
}

/**
 * Last-resort lookup for case-insensitive filesystem collisions. On macOS/
 * Windows, `getFileByPath("Foo.md")` returns null even if `foo.md` exists,
 * but vault.create then fails because the underlying disk has the file.
 */
function findFileCaseInsensitive(app: App, path: string): TFile | null {
  const lower = path.toLowerCase();
  for (const f of app.vault.getFiles()) {
    if (f.path.toLowerCase() === lower) return f;
  }
  return null;
}

/**
 * Wrap a thrown error so the user-facing message includes which vault path
 * the operation was acting on. Preserves the original Error type when the
 * inner value is an Error; otherwise produces a fresh Error.
 */
function annotateWithPath(err: unknown, path: string): Error {
  const original = err instanceof Error ? err.message : String(err);
  if (original.includes(path)) return err instanceof Error ? err : new Error(original);
  const wrapped = new Error(`${original} (at "${path}")`);
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => window.setTimeout(res, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(9000, 1000 * Math.pow(3, attempt - 1));
}

export { renameForConflict };
