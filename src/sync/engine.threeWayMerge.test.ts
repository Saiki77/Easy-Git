import { describe, expect, it, vi } from "vitest";
import { SyncEngine, SyncEngineDeps } from "./engine";
import { GitHubClient } from "../github/client";
import { stringToBase64 } from "./blob-sha";
import { ConflictEntry, FileSyncRecord, LocalFileEntry, PluginSettings } from "../types";
import { fakeApp, fakeDestination, fakeMapping } from "../../test/fakes";

/** tryThreeWayMerges is private — reached through the same instance the
 * engine itself uses internally. Casting to this narrow shape (rather than
 * `any`) keeps the call checked against the real signature. */
type WithThreeWayMerge = {
  tryThreeWayMerges(
    client: GitHubClient,
    destination: ReturnType<typeof fakeDestination>,
    mapping: ReturnType<typeof fakeMapping>,
    conflicts: ConflictEntry[],
    localFiles: Record<string, LocalFileEntry>,
    lastState: Record<string, FileSyncRecord>,
    backupTimestamp: string,
  ): Promise<number>;
};

function makeEngine(appFiles: Record<string, string>): WithThreeWayMerge {
  const deps: SyncEngineDeps = {
    app: fakeApp(appFiles),
    settings: {} as PluginSettings,
    saveSettings: async () => {},
    resolveConflicts: async () => null,
  };
  return new SyncEngine(deps) as unknown as WithThreeWayMerge;
}

/** Mocks client.request for the two GET .../git/blobs/<sha> calls
 * tryThreeWayMerges makes, keyed by the trailing sha in the URL. */
function mockBlobs(client: GitHubClient, bySha: Record<string, string>) {
  return vi.spyOn(client, "request").mockImplementation(async (_method, urlPath) => {
    const sha = String(urlPath).split("/").pop() ?? "";
    const text = bySha[sha];
    if (text === undefined) throw new Error(`no fixture blob for sha ${sha}`);
    return { sha, size: text.length, encoding: "base64", content: stringToBase64(text) };
  });
}

describe("tryThreeWayMerges", () => {
  it("merges non-overlapping edits cleanly and marks the conflict keep-local", async () => {
    const path = "notes.txt";
    const localText = "LOCAL1\nline2\nline3";
    const engine = makeEngine({ [path]: localText });
    const client = new GitHubClient({ token: "t" });
    mockBlobs(client, {
      "base-sha": "line1\nline2\nline3",
      "remote-sha": "line1\nline2\nREMOTE3",
    });

    const conflicts: ConflictEntry[] = [
      { path, kind: "both-edited", localSha: "local-sha", remoteSha: "remote-sha" },
    ];
    const localFiles: Record<string, LocalFileEntry> = {
      [path]: { path, sha: "local-sha", size: localText.length, mtime: 0 },
    };
    const lastState: Record<string, FileSyncRecord> = { [path]: { sha: "base-sha", size: 0 } };

    const merged = await engine.tryThreeWayMerges(
      client,
      fakeDestination(),
      fakeMapping(),
      conflicts,
      localFiles,
      lastState,
      "ts",
    );

    expect(merged).toBe(1);
    expect(conflicts[0].resolution).toBe("keep-local");
    expect(localFiles[path].sha).not.toBe("local-sha");
  });

  it("leaves the conflict for manual resolution when both sides edited the same line", async () => {
    const path = "notes.txt";
    const localText = "LOCAL\nline2";
    const engine = makeEngine({ [path]: localText });
    const client = new GitHubClient({ token: "t" });
    mockBlobs(client, {
      "base-sha": "line1\nline2",
      "remote-sha": "REMOTE\nline2",
    });

    const conflicts: ConflictEntry[] = [
      { path, kind: "both-edited", localSha: "local-sha", remoteSha: "remote-sha" },
    ];
    const localFiles: Record<string, LocalFileEntry> = {
      [path]: { path, sha: "local-sha", size: localText.length, mtime: 0 },
    };
    const lastState: Record<string, FileSyncRecord> = { [path]: { sha: "base-sha", size: 0 } };

    const merged = await engine.tryThreeWayMerges(
      client,
      fakeDestination(),
      fakeMapping(),
      conflicts,
      localFiles,
      lastState,
      "ts",
    );

    expect(merged).toBe(0);
    expect(conflicts[0].resolution).toBeUndefined();
    expect(localFiles[path].sha).toBe("local-sha");
  });

  it("skips .md files when wikilink rewrite is on and the mapping isn't pull-only", async () => {
    const path = "note.md";
    const engine = makeEngine({ [path]: "local" });
    const client = new GitHubClient({ token: "t" });
    const spy = mockBlobs(client, {});

    const conflicts: ConflictEntry[] = [
      { path, kind: "both-edited", localSha: "local-sha", remoteSha: "remote-sha" },
    ];
    const localFiles: Record<string, LocalFileEntry> = {
      [path]: { path, sha: "local-sha", size: 1, mtime: 0 },
    };
    const lastState: Record<string, FileSyncRecord> = { [path]: { sha: "base-sha", size: 0 } };

    const merged = await engine.tryThreeWayMerges(
      client,
      fakeDestination(),
      fakeMapping({ rewriteWikilinks: true, direction: "push" }),
      conflicts,
      localFiles,
      lastState,
      "ts",
    );

    expect(merged).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(conflicts[0].resolution).toBeUndefined();
  });

  it("never attempts a text merge on a binary file", async () => {
    const path = "image.png";
    const engine = makeEngine({});
    const client = new GitHubClient({ token: "t" });
    const spy = mockBlobs(client, {});

    const conflicts: ConflictEntry[] = [
      { path, kind: "both-edited", localSha: "local-sha", remoteSha: "remote-sha" },
    ];
    const lastState: Record<string, FileSyncRecord> = { [path]: { sha: "base-sha", size: 0 } };

    const merged = await engine.tryThreeWayMerges(
      client,
      fakeDestination(),
      fakeMapping(),
      conflicts,
      {},
      lastState,
      "ts",
    );

    expect(merged).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips when there's no recorded base SHA (never synced before)", async () => {
    const path = "notes.txt";
    const engine = makeEngine({ [path]: "local" });
    const client = new GitHubClient({ token: "t" });
    const spy = mockBlobs(client, {});

    const conflicts: ConflictEntry[] = [
      { path, kind: "both-edited", localSha: "local-sha", remoteSha: "remote-sha" },
    ];

    const merged = await engine.tryThreeWayMerges(
      client,
      fakeDestination(),
      fakeMapping(),
      conflicts,
      { [path]: { path, sha: "local-sha", size: 1, mtime: 0 } },
      {},
      "ts",
    );

    expect(merged).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves the local file untouched when the remote blob fetch fails mid-merge", async () => {
    const path = "notes.txt";
    const localText = "local content";
    const engine = makeEngine({ [path]: localText });
    const client = new GitHubClient({ token: "t" });
    vi.spyOn(client, "request").mockRejectedValue(new Error("network down"));

    const conflicts: ConflictEntry[] = [
      { path, kind: "both-edited", localSha: "local-sha", remoteSha: "remote-sha" },
    ];
    const localFiles: Record<string, LocalFileEntry> = {
      [path]: { path, sha: "local-sha", size: localText.length, mtime: 0 },
    };
    const lastState: Record<string, FileSyncRecord> = { [path]: { sha: "base-sha", size: 0 } };

    const merged = await engine.tryThreeWayMerges(
      client,
      fakeDestination(),
      fakeMapping(),
      conflicts,
      localFiles,
      lastState,
      "ts",
    );

    expect(merged).toBe(0);
    expect(conflicts[0].resolution).toBeUndefined();
    expect(localFiles[path].sha).toBe("local-sha");
  });
});
