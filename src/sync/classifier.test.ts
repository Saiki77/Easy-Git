import { describe, expect, it } from "vitest";
import {
  classify,
  detectMoves,
  planFromResolvedConflicts,
  renameForConflict,
} from "./classifier";
import { ConflictEntry, FileAction, FileSyncRecord, LocalFileEntry, RemoteFileEntry } from "../types";

function local(path: string, sha: string): Record<string, LocalFileEntry> {
  return { [path]: { path, sha, size: sha.length, mtime: 0 } };
}
function remote(path: string, sha: string): Record<string, RemoteFileEntry> {
  return { [path]: { path, sha, size: sha.length } };
}
function last(path: string, sha: string): Record<string, FileSyncRecord> {
  return { [path]: { sha, size: sha.length } };
}

describe("classify — bidirectional (both)", () => {
  it("flags both-edited as a conflict when local and remote diverge from the last-synced base", () => {
    const out = classify({
      local: local("note.md", "L"),
      remote: remote("note.md", "R"),
      lastState: last("note.md", "BASE"),
      direction: "both",
    });
    expect(out.conflicts).toEqual([
      { path: "note.md", kind: "both-edited", localSha: "L", remoteSha: "R" },
    ]);
    expect(out.actions).toEqual([]);
  });

  it("does not conflict when both sides changed to the identical content", () => {
    const out = classify({
      local: local("note.md", "SAME"),
      remote: remote("note.md", "SAME"),
      lastState: last("note.md", "BASE"),
      direction: "both",
    });
    expect(out.conflicts).toEqual([]);
    expect(out.noopCount).toBe(1);
  });

  it("is a plain push-modify when only local changed", () => {
    const out = classify({
      local: local("note.md", "L2"),
      remote: remote("note.md", "BASE"),
      lastState: last("note.md", "BASE"),
      direction: "both",
    });
    expect(out.actions).toEqual([{ path: "note.md", op: "push-modify", localSha: "L2" }]);
  });

  it("flags both-added-different when neither side was tracked before", () => {
    const out = classify({
      local: local("new.md", "L"),
      remote: remote("new.md", "R"),
      lastState: {},
      direction: "both",
    });
    expect(out.conflicts).toEqual([
      { path: "new.md", kind: "both-added-different", localSha: "L", remoteSha: "R" },
    ]);
  });
});

describe("classify — pull-only", () => {
  it("pulls a remote-only file regardless of stale lastSyncState", () => {
    const out = classify({
      local: {},
      remote: remote("note.md", "R"),
      lastState: last("note.md", "STALE"),
      direction: "pull",
    });
    expect(out.actions).toEqual([{ path: "note.md", op: "pull-add", remoteSha: "R" }]);
  });

  it("leaves a user-added local-only file alone (never tracked, not on remote)", () => {
    const out = classify({
      local: local("mine.md", "L"),
      remote: {},
      lastState: {},
      direction: "pull",
    });
    expect(out.actions).toEqual([]);
    expect(out.informationalLocalChanges).toEqual([]);
  });

  it("reports (but does not push) a locally-edited file whose remote copy was deleted", () => {
    const out = classify({
      local: local("note.md", "EDITED"),
      remote: {},
      lastState: last("note.md", "BASE"),
      direction: "pull",
    });
    expect(out.actions).toEqual([]);
    expect(out.informationalLocalChanges).toEqual(["note.md"]);
  });
});

describe("classify — push-only", () => {
  it("mirrors pull-only: pushes a local-only file regardless of stale lastSyncState", () => {
    const out = classify({
      local: local("note.md", "L"),
      remote: {},
      lastState: last("note.md", "STALE"),
      direction: "push",
    });
    expect(out.actions).toEqual([{ path: "note.md", op: "push-add", localSha: "L" }]);
  });

  it("leaves a remote-only file we never pushed alone", () => {
    const out = classify({
      local: {},
      remote: remote("theirs.md", "R"),
      lastState: {},
      direction: "push",
    });
    expect(out.actions).toEqual([]);
  });
});

describe("detectMoves", () => {
  it("pairs a push-add/push-delete with matching content SHA into a move", () => {
    const actions: FileAction[] = [
      { path: "folder/note.md", op: "push-add", localSha: "X" },
      { path: "note.md", op: "push-delete", remoteSha: "X" },
    ];
    expect(detectMoves(actions).push).toEqual([
      { from: "note.md", to: "folder/note.md", sha: "X" },
    ]);
  });

  it("prefers the delete with the same basename when several share a SHA (duplicate files)", () => {
    const actions: FileAction[] = [
      { path: "a/dup.md", op: "push-delete", remoteSha: "X" },
      { path: "b/dup.md", op: "push-delete", remoteSha: "X" },
      { path: "c/dup.md", op: "push-add", localSha: "X" },
    ];
    const moves = detectMoves(actions).push;
    expect(moves).toHaveLength(1);
    expect(moves[0].to).toBe("c/dup.md");
  });

  it("does not pair adds/deletes on opposite sides (push-add with pull-delete)", () => {
    const actions: FileAction[] = [
      { path: "note.md", op: "push-add", localSha: "X" },
      { path: "old.md", op: "pull-delete", localSha: "X" },
    ];
    expect(detectMoves(actions).push).toEqual([]);
    expect(detectMoves(actions).pull).toEqual([]);
  });
});

describe("planFromResolvedConflicts", () => {
  it("keep-both renames the local copy and still pulls remote onto the original path", () => {
    const conflicts: ConflictEntry[] = [
      { path: "note.md", kind: "both-edited", localSha: "L", remoteSha: "R", resolution: "keep-both" },
    ];
    const plan = planFromResolvedConflicts(conflicts, "both");
    expect(plan.keepBothRenames).toHaveLength(1);
    expect(plan.keepBothRenames[0].from).toBe("note.md");
    expect(plan.extraActions).toContainEqual({ path: "note.md", op: "pull-modify", remoteSha: "R" });
    expect(plan.extraActions.some((a) => a.op === "push-add")).toBe(true);
  });

  it("keep-local on a push-only mapping is a no-op (nothing to pull)", () => {
    const conflicts: ConflictEntry[] = [
      { path: "note.md", kind: "both-edited", localSha: "L", remoteSha: "R", resolution: "keep-local" },
    ];
    expect(planFromResolvedConflicts(conflicts, "push").extraActions).toEqual([
      { path: "note.md", op: "push-modify", localSha: "L" },
    ]);
  });
});

describe("renameForConflict", () => {
  it("inserts the conflict marker before the extension", () => {
    const renamed = renameForConflict("folder/note.md");
    expect(renamed).toMatch(/^folder\/note-conflict-local-.+\.md$/);
  });
});
