import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import {
  ConflictEntry,
  FileAction,
  FileSyncRecord,
  FolderMapping,
  LastSyncState,
  LocalFileEntry,
  PluginSettings,
  RemoteFileEntry,
  SyncResult,
} from "../types";
import { GitHubClient, GitHubApiError } from "../github/client";
import {
  NewTreeEntry,
  createBlob,
  createCommit,
  createTree,
  getBlobContent,
  getBranchHead,
  listRemoteFolderFiles,
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

export interface SyncEngineDeps {
  app: App;
  settings: PluginSettings;
  saveSettings: () => Promise<void>;
  /** Resolve conflicts. Returns the same list with `resolution` set, or null
   * if the user cancelled. */
  resolveConflicts: (
    mapping: FolderMapping,
    conflicts: ConflictEntry[],
  ) => Promise<ConflictEntry[] | null>;
}

const MAX_NON_FF_RETRIES = 3;

export class SyncEngine {
  constructor(private deps: SyncEngineDeps) {}

  async syncMapping(mapping: FolderMapping): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = {
      mappingId: mapping.id,
      ok: false,
      added: 0,
      modified: 0,
      deleted: 0,
      conflicts: [],
      durationMs: 0,
    };

    const auth = this.deps.settings.auth;
    if (auth.method === "none" || !auth.token) {
      result.error = "Not signed in. Configure GitHub auth in settings.";
      result.durationMs = Date.now() - start;
      return result;
    }

    const client = new GitHubClient({ token: auth.token });

    let attempt = 0;
    while (attempt < MAX_NON_FF_RETRIES) {
      attempt += 1;
      try {
        const outcome = await this.runOnce(client, mapping);
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
  ): Promise<SyncResult | "retry"> {
    const baseResult: SyncResult = {
      mappingId: mapping.id,
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
      mapping.repoOwner,
      mapping.repoName,
      mapping.branch,
    );

    // 2. Read remote tree.
    const remote = await listRemoteFolderFiles(
      client,
      mapping.repoOwner,
      mapping.repoName,
      head.treeSha,
      mapping.remoteFolder,
    );

    // 3. Read local files.
    const localScan = await this.scanLocalFolder(mapping);
    baseResult.skippedLarge = localScan.skipped;

    // 4. Load last-sync state.
    const lastState: Record<string, FileSyncRecord> =
      mapping.lastSyncState?.files ?? {};

    // 5. Classify.
    const plan = classify({
      local: localScan.files,
      remote,
      lastState,
      direction: mapping.direction,
    });

    // 6. Resolve conflicts.
    let conflictPlan: ResolvedConflictPlan = { extraActions: [], keepBothRenames: [] };
    if (plan.conflicts.length > 0) {
      const resolved = await this.deps.resolveConflicts(mapping, plan.conflicts);
      if (!resolved) {
        baseResult.conflicts = plan.conflicts;
        baseResult.error = "Sync cancelled at conflict resolution.";
        return baseResult;
      }
      conflictPlan = planFromResolvedConflicts(resolved, mapping.direction);
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

    // 7. Apply pull-side actions.
    for (const action of actions) {
      if (action.op === "pull-add" || action.op === "pull-modify") {
        await this.applyPullModify(mapping, action, client);
      } else if (action.op === "pull-delete") {
        await this.applyPullDelete(mapping, action);
      }
    }

    // 8. Build remote commit if push actions exist.
    const pushActions = actions.filter(
      (a) =>
        a.op === "push-add" || a.op === "push-modify" || a.op === "push-delete",
    );

    let newCommitSha: string | undefined;
    if (pushActions.length > 0) {
      const commitResult = await this.buildAndPushCommit(
        client,
        mapping,
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

    // 9. Persist new last-sync state.
    const newState = computeNewState(
      mapping,
      newCommitSha ?? head.commitSha,
      head.treeSha,
      actions,
      localScan.files,
      remote,
      lastState,
    );
    mapping.lastSyncState = newState;
    mapping.lastSyncAt = Date.now();
    mapping.lastSyncError = undefined;
    await this.deps.saveSettings();

    // 10. Counts for the result.
    for (const a of actions) {
      if (a.op === "push-add" || a.op === "pull-add") baseResult.added += 1;
      else if (a.op === "push-modify" || a.op === "pull-modify") baseResult.modified += 1;
      else if (a.op === "push-delete" || a.op === "pull-delete") baseResult.deleted += 1;
    }
    baseResult.commitSha = newCommitSha;
    baseResult.conflicts = plan.conflicts.map((c) => ({ ...c }));

    if (mapping.direction === "push" && plan.informationalRemoteChanges.length > 0) {
      const n = plan.informationalRemoteChanges.length;
      if (this.deps.settings.showNotifications) {
        new Notice(
          `Easy Git (${mapping.name}): ${n} file${n === 1 ? "" : "s"} changed on remote (not pulled — push-only mapping).`,
        );
      }
    }
    if (mapping.direction === "pull" && plan.informationalLocalChanges.length > 0) {
      const n = plan.informationalLocalChanges.length;
      if (this.deps.settings.showNotifications) {
        new Notice(
          `Easy Git (${mapping.name}): ${n} file${n === 1 ? "" : "s"} changed locally (not pushed — pull-only mapping).`,
        );
      }
    }
    return baseResult;
  }

  private async scanLocalFolder(
    mapping: FolderMapping,
  ): Promise<{ files: Record<string, LocalFileEntry>; skipped: string[] }> {
    const folder = this.deps.app.vault.getFolderByPath(mapping.vaultFolder);
    const files: Record<string, LocalFileEntry> = {};
    const skipped: string[] = [];
    const excludePatterns = this.deps.settings.excludedPaths;
    const maxBytes = this.deps.settings.maxFileSizeBytes;

    if (!folder) return { files, skipped };

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
    return { files, skipped };
  }

  private async computeLocalSha(file: TFile): Promise<string> {
    if (isLikelyTextPath(file.path)) {
      const text = await this.deps.app.vault.read(file);
      return computeGitBlobShaFromString(text);
    }
    const buf = await this.deps.app.vault.readBinary(file);
    return computeGitBlobShaFromArrayBuffer(buf);
  }

  private async applyPullModify(
    mapping: FolderMapping,
    action: FileAction,
    client: GitHubClient,
  ): Promise<void> {
    if (!action.remoteSha) return;
    const blob = await getBlobContent(
      client,
      mapping.repoOwner,
      mapping.repoName,
      action.remoteSha,
    );
    const fullPath = vaultPathFor(mapping, action.path);
    await ensureVaultFolder(this.deps.app, parentOf(fullPath));
    const existing = this.deps.app.vault.getFileByPath(fullPath);
    const isText = isLikelyTextPath(fullPath) && blob.encoding !== "base64-binary";
    if (isText) {
      const text = base64ToString(blob.content);
      if (existing) {
        await this.deps.app.vault.modify(existing, text);
      } else {
        await this.deps.app.vault.create(fullPath, text);
      }
    } else {
      const buf = base64ToArrayBuffer(blob.content);
      if (existing) {
        await this.deps.app.vault.modifyBinary(existing, buf);
      } else {
        await this.deps.app.vault.createBinary(fullPath, buf);
      }
    }
  }

  private async applyPullDelete(
    mapping: FolderMapping,
    action: FileAction,
  ): Promise<void> {
    const fullPath = vaultPathFor(mapping, action.path);
    const existing = this.deps.app.vault.getFileByPath(fullPath);
    if (existing) await this.deps.app.vault.delete(existing);
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

  private async buildAndPushCommit(
    client: GitHubClient,
    mapping: FolderMapping,
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
      const fullRepoPath = repoPathFor(mapping, action.path);
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
        mapping.repoOwner,
        mapping.repoName,
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
      mapping.repoOwner,
      mapping.repoName,
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
      mapping.repoOwner,
      mapping.repoName,
      message,
      newTreeSha,
      [baseCommitSha],
    );
    const ok = await updateRef(
      client,
      mapping.repoOwner,
      mapping.repoName,
      mapping.branch,
      newCommitSha,
    );
    if (!ok) return null;
    return newCommitSha;
  }

  private async readVaultFile(
    mapping: FolderMapping,
    relPath: string,
  ): Promise<{ base64: string }> {
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

function computeNewState(
  mapping: FolderMapping,
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
  const folder = mapping.vaultFolder.replace(/^\/+|\/+$/g, "");
  return normalizePath(folder ? `${folder}/${relPath}` : relPath);
}

function repoPathFor(mapping: FolderMapping, relPath: string): string {
  const folder = mapping.remoteFolder.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${relPath}` : relPath;
}

function relativeTo(base: string, fullPath: string): string {
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

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(9000, 1000 * Math.pow(3, attempt - 1));
}

export { renameForConflict };
