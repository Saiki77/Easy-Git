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

    if (!wasTracked) {
      if (localExists && !remoteExists) {
        if (direction === "pull") {
          informationalLocalChanges.push(path);
        } else {
          actions.push({ path, op: "push-add", localSha });
        }
      } else if (!localExists && remoteExists) {
        if (direction === "push") {
          informationalRemoteChanges.push(path);
        } else {
          actions.push({ path, op: "pull-add", remoteSha });
        }
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
        if (direction === "pull") {
          informationalLocalChanges.push(path);
        } else {
          actions.push({ path, op: "push-modify", localSha });
        }
      } else if (!localChanged && remoteChanged) {
        if (direction === "push") {
          informationalRemoteChanges.push(path);
        } else {
          actions.push({ path, op: "pull-modify", remoteSha });
        }
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
        if (direction === "pull") {
          informationalLocalChanges.push(path);
        } else {
          actions.push({ path, op: "push-delete", remoteSha });
        }
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
        if (direction === "push") {
          informationalRemoteChanges.push(path);
        } else {
          actions.push({ path, op: "pull-delete", localSha });
        }
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
