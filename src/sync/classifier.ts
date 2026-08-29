import {
  ConflictEntry,
  FileAction,
  FileSyncRecord,
  LocalFileEntry,
  RemoteFileEntry,
  SyncDirection,
} from "../types";

export interface ClassifyInput {
  local: Record<string, LocalFileEntry>;
  remote: Record<string, RemoteFileEntry>;
  lastState: Record<string, FileSyncRecord>;
  direction: SyncDirection;
}

export interface ClassifyOutput {
  actions: FileAction[];
  conflicts: ConflictEntry[];
  noopCount: number;
  /** Remote-only changes when direction = "push" (informational; not applied). */
  informationalRemoteChanges: string[];
  /** Local-only changes when direction = "pull" (informational; not pushed). */
  informationalLocalChanges: string[];
}

export function classify(input: ClassifyInput): ClassifyOutput {
  const { local, remote, lastState, direction } = input;

  const allPaths = new Set<string>([
    ...Object.keys(local),
    ...Object.keys(remote),
    ...Object.keys(lastState),
  ]);

  const actions: FileAction[] = [];
  const conflicts: ConflictEntry[] = [];
  const informationalRemoteChanges: string[] = [];
  const informationalLocalChanges: string[] = [];
  let noopCount = 0;

  for (const path of allPaths) {
    const last = lastState[path];
    const l = local[path];
    const r = remote[path];

    const lastSha = last?.sha;
    const localSha = l?.sha;
    const remoteSha = r?.sha;

    const localExists = !!l;
    const remoteExists = !!r;
    const wasTracked = !!last;

    // -----------------------------------------------------------------
    // PULL-ONLY: remote is the source of truth. Reconcile against what
    // is on remote NOW, not against what lastSyncState recorded. This
    // means a new remote file is pulled even when lastSyncState carries
    // a stale entry for it from a previous failed/partial sync — drift
    // self-heals on every sync instead of compounding.
    //
    // lastSyncState is still consulted, but only for one narrow purpose:
    // distinguishing "remote deleted a file we previously pulled" (→
    // pull-delete) from "user added a local-only file remote never had"
    // (→ leave alone). That's the one signal we can't get from local +
    // remote alone.
    // -----------------------------------------------------------------
    if (direction === "pull") {
      if (remoteExists) {
        if (!localExists) {
          actions.push({ path, op: "pull-add", remoteSha });
        } else if (localSha !== remoteSha) {
          // Local file present but different. Engine backs up local
          // before pull-modify writes, so user content is preserved.
          actions.push({ path, op: "pull-modify", remoteSha });
        } else {
          noopCount += 1;
        }
      } else {
        // Not on remote.
        if (!localExists) {
          // Gone everywhere; drop from state next round.
          noopCount += 1;
        } else if (wasTracked && localSha === lastSha) {
          // We previously pulled this from remote, user hasn't touched
          // it, remote removed it → pull-delete (with backup).
          actions.push({ path, op: "pull-delete", localSha });
        } else if (wasTracked && localSha !== lastSha) {
          // We previously pulled this AND user edited it locally AND
          // remote removed it. Conservative: keep the user's edit.
          // Log so the user knows.
          informationalLocalChanges.push(path);
        } else {
          // Never on remote, user-added local-only file. Leave alone.
          // (Not even an info entry — this is a permanent state, not
          // a "change since last sync".)
        }
      }
      continue;
    }

    // -----------------------------------------------------------------
    // PUSH-ONLY: local is the source of truth. Mirror semantics to pull-
    // only, just flipped. lastSyncState distinguishes "user deleted a
    // file we previously pushed" (→ push-delete) from "someone else
    // added a file directly on the remote we should leave alone".
    // -----------------------------------------------------------------
    if (direction === "push") {
      if (localExists) {
        if (!remoteExists) {
          actions.push({ path, op: "push-add", localSha });
        } else if (localSha !== remoteSha) {
          actions.push({ path, op: "push-modify", localSha });
        } else {
          noopCount += 1;
        }
      } else {
        if (!remoteExists) {
          noopCount += 1;
        } else if (wasTracked && remoteSha === lastSha) {
          // We previously pushed this, remote still matches, user
          // deleted locally → push the deletion through.
          actions.push({ path, op: "push-delete", remoteSha });
        } else if (wasTracked && remoteSha !== lastSha) {
          // We previously pushed this, someone changed it on remote,
          // user deleted locally → conservative: leave remote alone.
          informationalRemoteChanges.push(path);
        } else {
          // Remote-only file we never pushed. Leave alone (don't delete
          // remote content the user didn't put there).
        }
      }
      continue;
    }

    // -----------------------------------------------------------------
    // BIDIRECTIONAL ("both"): the original 3-way logic. lastSyncState
    // is essential here as the common ancestor — without it we can't
    // tell which side edited.
    // -----------------------------------------------------------------
    if (!wasTracked) {
      if (localExists && !remoteExists) {
        actions.push({ path, op: "push-add", localSha });
      } else if (!localExists && remoteExists) {
        actions.push({ path, op: "pull-add", remoteSha });
      } else if (localExists && remoteExists) {
        if (localSha === remoteSha) {
          noopCount += 1;
        } else {
          conflicts.push({
            path,
            kind: "both-added-different",
            localSha,
            remoteSha,
          });
        }
      }
      continue;
    }

    if (localExists && remoteExists) {
      const localChanged = localSha !== lastSha;
      const remoteChanged = remoteSha !== lastSha;
      if (!localChanged && !remoteChanged) {
        noopCount += 1;
      } else if (localChanged && !remoteChanged) {
        actions.push({ path, op: "push-modify", localSha });
      } else if (!localChanged && remoteChanged) {
        actions.push({ path, op: "pull-modify", remoteSha });
      } else {
        if (localSha === remoteSha) {
          noopCount += 1;
        } else {
          conflicts.push({
            path,
            kind: "both-edited",
            localSha,
            remoteSha,
          });
        }
      }
    } else if (!localExists && remoteExists) {
      const remoteChanged = remoteSha !== lastSha;
      if (!remoteChanged) {
        actions.push({ path, op: "push-delete", remoteSha });
      } else {
        conflicts.push({
          path,
          kind: "remote-edited-local-deleted",
          remoteSha,
        });
      }
    } else if (localExists && !remoteExists) {
      const localChanged = localSha !== lastSha;
      if (!localChanged) {
        actions.push({ path, op: "pull-delete", localSha });
      } else {
        conflicts.push({
          path,
          kind: "local-edited-remote-deleted",
          localSha,
        });
      }
    } else {
      noopCount += 1;
    }
  }

  return {
    actions,
    conflicts,
    noopCount,
    informationalRemoteChanges,
    informationalLocalChanges,
  };
}

/**
 * After conflicts are resolved by the user, translate each resolution
 * into a FileAction (or pair of actions, for keep-both).
 *
 * - keep-local  → push the local version onto remote (push-add if remote-deleted, push-modify otherwise)
 * - keep-remote → pull the remote version onto local (pull-add if local-deleted, pull-modify otherwise)
 * - keep-both   → rename local file (push-add new path), then pull remote onto original path
 *
 * Renames are emitted as `keepBothRenames` so the engine can apply the vault
 * rename before recomputing the push side.
 */
export interface ResolvedConflictPlan {
  extraActions: FileAction[];
  keepBothRenames: { from: string; to: string }[];
}

export function planFromResolvedConflicts(
  resolved: ConflictEntry[],
  direction: SyncDirection,
): ResolvedConflictPlan {
  const extraActions: FileAction[] = [];
  const keepBothRenames: { from: string; to: string }[] = [];

  for (const c of resolved) {
    if (!c.resolution) continue;

    if (c.resolution === "keep-local") {
      if (direction === "pull") continue;
      if (c.kind === "local-edited-remote-deleted") {
        // Local has edits, remote was deleted. Keep local → push it back as add.
        extraActions.push({ path: c.path, op: "push-add", localSha: c.localSha });
      } else if (c.kind === "remote-edited-local-deleted") {
        // Local was deleted, remote was edited. Keep local (the deletion) →
        // push the deletion to remote.
        extraActions.push({ path: c.path, op: "push-delete", remoteSha: c.remoteSha });
      } else {
        extraActions.push({ path: c.path, op: "push-modify", localSha: c.localSha });
      }
    } else if (c.resolution === "keep-remote") {
      if (direction === "push") continue;
      if (c.kind === "remote-edited-local-deleted") {
        // Remote has edits, local was deleted. Keep remote → pull it back as add.
        extraActions.push({ path: c.path, op: "pull-add", remoteSha: c.remoteSha });
      } else if (c.kind === "local-edited-remote-deleted") {
        // Remote was deleted, local was edited. Keep remote (the deletion) →
        // pull the deletion locally.
        extraActions.push({ path: c.path, op: "pull-delete", localSha: c.localSha });
      } else {
        extraActions.push({ path: c.path, op: "pull-modify", remoteSha: c.remoteSha });
      }
    } else if (c.resolution === "keep-both") {
      const renamed = renameForConflict(c.path);
      keepBothRenames.push({ from: c.path, to: renamed });
      if (direction !== "pull") {
        extraActions.push({
          path: renamed,
          op: "push-add",
          localSha: c.localSha,
        });
      }
      if (direction !== "push") {
        if (c.remoteSha) {
          extraActions.push({
            path: c.path,
            op: c.kind === "remote-edited-local-deleted" ? "pull-add" : "pull-modify",
            remoteSha: c.remoteSha,
          });
        }
      }
    }
  }

  return { extraActions, keepBothRenames };
}

export function renameForConflict(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  if (dot > slash && dot !== -1) {
    return `${path.slice(0, dot)}-conflict-local-${stamp}${path.slice(dot)}`;
  }
  return `${path}-conflict-local-${stamp}`;
}

/** One detected move: the same blob content left `from` and appeared at `to`
 * within a single run. */
export interface MovePair {
  from: string;
  to: string;
  /** Content blob SHA shared by both sides. */
  sha: string;
}

export interface DetectedMoves {
  push: MovePair[];
  pull: MovePair[];
}

/**
 * Pair add+delete actions that carry the same blob content into moves.
 *
 * A vault-side move surfaces as push-add(new path, localSha S) plus
 * push-delete(old path, remoteSha S): the delete's remoteSha is the blob
 * being removed, which for a pure move equals the content that reappears at
 * the new path. A remote-side move symmetrically surfaces as pull-add(new,
 * remoteSha S) plus pull-delete(old, localSha S).
 *
 * Pairing is 1:1 and greedy: adds are visited in path order, each consuming
 * one same-SHA delete, preferring a delete with the same basename so
 * "moved into a subfolder" pairs naturally even when several identical
 * files move at once. Purely informational: callers use the pairs for the
 * commit message, notices, and the sync log. Nothing about what is pushed
 * or pulled changes.
 */
export function detectMoves(actions: FileAction[]): DetectedMoves {
  return {
    push: pairMoves(actions, "push-add", "push-delete"),
    pull: pairMoves(actions, "pull-add", "pull-delete"),
  };
}

function pairMoves(
  actions: FileAction[],
  addOp: FileAction["op"],
  deleteOp: FileAction["op"],
): MovePair[] {
  const deletesBySha = new Map<string, FileAction[]>();
  for (const a of actions) {
    if (a.op !== deleteOp) continue;
    const sha = a.localSha ?? a.remoteSha;
    if (!sha) continue;
    const list = deletesBySha.get(sha);
    if (list) list.push(a);
    else deletesBySha.set(sha, [a]);
  }
  if (deletesBySha.size === 0) return [];

  const adds = actions
    .filter((a) => a.op === addOp && (a.localSha ?? a.remoteSha))
    .sort((x, y) => x.path.localeCompare(y.path));

  const pairs: MovePair[] = [];
  for (const add of adds) {
    const sha = (add.localSha ?? add.remoteSha) as string;
    const candidates = deletesBySha.get(sha);
    if (!candidates || candidates.length === 0) continue;
    const base = basenameOf(add.path);
    let idx = candidates.findIndex((d) => basenameOf(d.path) === base);
    if (idx < 0) idx = 0;
    const del = candidates.splice(idx, 1)[0];
    pairs.push({ from: del.path, to: add.path, sha });
  }
  pairs.sort((a, b) => a.from.localeCompare(b.from));
  return pairs;
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
