import { LocalFileEntry, RemoteFileEntry } from "../types";

/**
 * "Prune local-only files" support.
 *
 * The classifier deliberately leaves a local file alone when it is on no
 * remote and not in lastSyncState: from local + remote alone it cannot tell
 * a note the user added from the stale half of a move or rename that
 * happened on remote. This module is the explicit, user-driven escape hatch
 * for that bucket. The pure candidate computation lives here, the I/O in
 * SyncEngine, the UI in ui/prune-modal.ts. Nothing in the normal sync path
 * calls any of it.
 */

/** One vault file that exists in the mapping folder but at none of the
 * mapping's destinations. */
export interface LocalOnlyCandidate {
  /** Mapping-relative path, same key space the classifier uses. */
  path: string;
  sha: string;
  size: number;
  mtime: number;
  /**
   * Remote paths (across all destinations) whose blob has exactly this
   * content. Non-empty means the bytes still live on remote under another
   * name, which is what a remote-side move or rename looks like from the
   * vault: pruning the file drops the old path, never the content.
   */
  sameContentAt: string[];
}

/** What one destination looked like when the candidates were computed. */
export interface RemoteSnapshot {
  destinationId: string;
  label: string;
  headCommit: string;
  /** Files under the remote folder after the exclude filter. Zero usually
   * means a wrong branch or folder; the UI warns because in that case every
   * local file shows up as a candidate. */
  fileCount: number;
}

export interface LocalOnlyScan {
  candidates: LocalOnlyCandidate[];
  localFileCount: number;
  remotes: RemoteSnapshot[];
}

export interface PruneResult {
  /** Mapping-relative paths that were backed up and moved to trash. */
  pruned: string[];
  /** Requested paths that no longer existed when the prune ran. */
  missing: string[];
  backupsCreated: number;
  /** Vault-relative backup folder, set when at least one backup was written. */
  backupFolder?: string;
  emptyFoldersRemoved: number;
  /** Set when the run stopped early; `pruned` holds what was done before. */
  error?: string;
}

/**
 * Given the engine's view of the vault folder and every destination's
 * remote tree, return the files that exist locally and on no remote, each
 * with a content-match hint. Sorted by path so the preview is stable.
 */
export function findLocalOnlyCandidates(
  local: Record<string, LocalFileEntry>,
  remotes: Record<string, RemoteFileEntry>[],
): LocalOnlyCandidate[] {
  const remotePaths = new Set<string>();
  const pathsBySha = new Map<string, Set<string>>();
  for (const remote of remotes) {
    for (const [path, entry] of Object.entries(remote)) {
      remotePaths.add(path);
      let paths = pathsBySha.get(entry.sha);
      if (!paths) {
        paths = new Set<string>();
        pathsBySha.set(entry.sha, paths);
      }
      paths.add(path);
    }
  }

  const out: LocalOnlyCandidate[] = [];
  for (const [path, entry] of Object.entries(local)) {
    if (remotePaths.has(path)) continue;
    const same = pathsBySha.get(entry.sha);
    out.push({
      path,
      sha: entry.sha,
      size: entry.size,
      mtime: entry.mtime,
      sameContentAt: same ? [...same].sort() : [],
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Every ancestor folder of the given mapping-relative file paths, deepest
 * first, without the mapping root itself. Deepest-first lets a caller
 * remove a folder and then find its parent empty in the same pass.
 */
export function ancestorFoldersDeepestFirst(paths: string[]): string[] {
  const folders = new Set<string>();
  for (const p of paths) {
    let cut = p.lastIndexOf("/");
    while (cut > 0) {
      folders.add(p.slice(0, cut));
      cut = p.lastIndexOf("/", cut - 1);
    }
  }
  const depth = (f: string) => f.split("/").length;
  return [...folders].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}
