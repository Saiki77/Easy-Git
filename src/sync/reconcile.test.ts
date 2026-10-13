import { describe, expect, it } from "vitest";
import { ancestorFoldersDeepestFirst, findLocalOnlyCandidates } from "./reconcile";
import { LocalFileEntry, RemoteFileEntry } from "../types";

describe("findLocalOnlyCandidates", () => {
  it("ignores a file that exists on at least one remote", () => {
    const local: Record<string, LocalFileEntry> = {
      "note.md": { path: "note.md", sha: "X", size: 1, mtime: 0 },
    };
    const remote: Record<string, RemoteFileEntry> = {
      "note.md": { path: "note.md", sha: "X", size: 1 },
    };
    expect(findLocalOnlyCandidates(local, [remote])).toEqual([]);
  });

  it("flags a local-only file and hints at its remote-side new path when content matches elsewhere", () => {
    const local: Record<string, LocalFileEntry> = {
      "old/note.md": { path: "old/note.md", sha: "X", size: 4, mtime: 100 },
    };
    const remote: Record<string, RemoteFileEntry> = {
      "new/note.md": { path: "new/note.md", sha: "X", size: 4 },
    };
    const candidates = findLocalOnlyCandidates(local, [remote]);
    expect(candidates).toEqual([
      {
        path: "old/note.md",
        sha: "X",
        size: 4,
        mtime: 100,
        sameContentAt: ["new/note.md"],
      },
    ]);
  });

  it("reports no content hint for a genuinely local-only note (no remote has that SHA)", () => {
    const local: Record<string, LocalFileEntry> = {
      "mine.md": { path: "mine.md", sha: "Y", size: 1, mtime: 0 },
    };
    const candidates = findLocalOnlyCandidates(local, [{}]);
    expect(candidates[0].sameContentAt).toEqual([]);
  });

  it("checks content across every destination's remote, not just the first", () => {
    const local: Record<string, LocalFileEntry> = {
      "old.md": { path: "old.md", sha: "X", size: 1, mtime: 0 },
    };
    const remoteA: Record<string, RemoteFileEntry> = {};
    const remoteB: Record<string, RemoteFileEntry> = { "elsewhere.md": { path: "elsewhere.md", sha: "X", size: 1 } };
    const candidates = findLocalOnlyCandidates(local, [remoteA, remoteB]);
    expect(candidates[0].sameContentAt).toEqual(["elsewhere.md"]);
  });
});

describe("ancestorFoldersDeepestFirst", () => {
  it("lists every ancestor folder, deepest first, without duplicates", () => {
    const folders = ancestorFoldersDeepestFirst(["a/b/c/note.md", "a/b/other.md"]);
    expect(folders).toEqual(["a/b/c", "a/b", "a"]);
  });

  it("returns nothing for a root-level file", () => {
    expect(ancestorFoldersDeepestFirst(["note.md"])).toEqual([]);
  });
});
