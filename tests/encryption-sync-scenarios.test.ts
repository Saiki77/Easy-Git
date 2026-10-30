/**
 * Sync-lifecycle scenarios with the REAL cipher and the REAL classifier.
 * This is the architectural contract of the encryption feature: because
 * encryption is deterministic, the engine's SHA-comparison machinery
 * (classifier, lastSyncState, move detection) stays correct when the local
 * scan records envelope SHAs instead of plaintext SHAs. Each scenario
 * mirrors one lifecycle moment the plan calls out.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { ContentKeys, deriveContentKeys, encryptContent } from "../src/crypto/cipher";
import { classify, detectMoves } from "../src/sync/classifier";
import { computeGitBlobShaFromBytes } from "../src/sync/blob-sha";
import { FileSyncRecord, LocalFileEntry, RemoteFileEntry } from "../src/types";

const KEY_ID = "5f2c010203040506070809aabbccddee";
let keys: ContentKeys;

beforeAll(async () => {
  keys = await deriveContentKeys(
    new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256),
    KEY_ID,
  );
});

async function plainSha(text: string): Promise<string> {
  return computeGitBlobShaFromBytes(new TextEncoder().encode(text));
}

/** What the engine's scanLocalFolder records for an encrypted destination. */
async function cipherSha(text: string): Promise<string> {
  const envelope = await encryptContent(keys, new TextEncoder().encode(text));
  return computeGitBlobShaFromBytes(envelope);
}

function local(path: string, sha: string): LocalFileEntry {
  return { path, sha, size: 100, mtime: 1_700_000_000_000 };
}
function remote(path: string, sha: string): RemoteFileEntry {
  return { path, sha, size: 100 };
}
function tracked(sha: string): FileSyncRecord {
  return { sha, size: 100, mtime: 1_700_000_000_000 };
}

describe("enable migration", () => {
  test("every unchanged file classifies as push-modify (the encrypt-all commit)", async () => {
    // Before enabling: remote and lastSyncState hold plaintext SHAs. After
    // enabling: the local scan records envelope SHAs. Locally 'changed',
    // remotely unchanged → push-modify for everything, zero conflicts.
    const pA = await plainSha("# Note A\n");
    const pB = await plainSha("# Note B\n");
    const out = classify({
      local: {
        "a.md": local("a.md", await cipherSha("# Note A\n")),
        "b.md": local("b.md", await cipherSha("# Note B\n")),
      },
      remote: { "a.md": remote("a.md", pA), "b.md": remote("b.md", pB) },
      lastState: { "a.md": tracked(pA), "b.md": tracked(pB) },
      direction: "both",
    });
    expect(out.conflicts).toEqual([]);
    const ops = out.actions.filter((a) => a.op !== "noop").map((a) => `${a.op}:${a.path}`);
    expect(ops.sort()).toEqual(["push-modify:a.md", "push-modify:b.md"]);
  });
});

describe("steady state", () => {
  test("unchanged files are noops because envelopes are deterministic", async () => {
    const cA = await cipherSha("# Note A\n");
    const out = classify({
      local: { "a.md": local("a.md", cA) },
      remote: { "a.md": remote("a.md", cA) },
      lastState: { "a.md": tracked(cA) },
      direction: "both",
    });
    expect(out.actions.filter((a) => a.op !== "noop")).toEqual([]);
    expect(out.noopCount).toBe(1);
  });

  test("a local edit pushes, a remote edit pulls, both-edited conflicts", async () => {
    const cOld = await cipherSha("v1\n");
    const cLocalNew = await cipherSha("v2 local\n");
    const cRemoteNew = await cipherSha("v2 remote\n");

    const localEdit = classify({
      local: { "n.md": local("n.md", cLocalNew) },
      remote: { "n.md": remote("n.md", cOld) },
      lastState: { "n.md": tracked(cOld) },
      direction: "both",
    });
    expect(localEdit.actions.map((a) => a.op)).toContain("push-modify");

    const remoteEdit = classify({
      local: { "n.md": local("n.md", cOld) },
      remote: { "n.md": remote("n.md", cRemoteNew) },
      lastState: { "n.md": tracked(cOld) },
      direction: "both",
    });
    expect(remoteEdit.actions.map((a) => a.op)).toContain("pull-modify");

    const bothEdit = classify({
      local: { "n.md": local("n.md", cLocalNew) },
      remote: { "n.md": remote("n.md", cRemoteNew) },
      lastState: { "n.md": tracked(cOld) },
      direction: "both",
    });
    expect(bothEdit.conflicts.map((c) => c.kind)).toEqual(["both-edited"]);
  });
});

describe("move detection", () => {
  test("a moved file pairs by envelope SHA, exactly like plaintext moves", async () => {
    const c = await cipherSha("moved content\n");
    const cOther = await cipherSha("unrelated\n");
    const out = classify({
      local: {
        "new/spot.md": local("new/spot.md", c),
        "other.md": local("other.md", cOther),
      },
      remote: {
        "old/spot.md": remote("old/spot.md", c),
        "other.md": remote("other.md", cOther),
      },
      lastState: { "old/spot.md": tracked(c), "other.md": tracked(cOther) },
      direction: "both",
    });
    const moves = detectMoves(out.actions);
    expect(moves.push).toEqual([
      expect.objectContaining({ from: "old/spot.md", to: "new/spot.md" }),
    ]);
  });
});

describe("mixed-content convergence", () => {
  test("a plaintext file pulled onto an encrypted destination re-uploads encrypted on the next sync", async () => {
    // After the pull, lastSyncState recorded the REMOTE (plaintext) SHA.
    // The next local scan records the envelope SHA → looks locally
    // modified while remote matches lastState → push-modify. One extra
    // sync converges the stray plaintext file to ciphertext.
    const p = await plainSha("pasted from elsewhere\n");
    const out = classify({
      local: { "s.md": local("s.md", await cipherSha("pasted from elsewhere\n")) },
      remote: { "s.md": remote("s.md", p) },
      lastState: { "s.md": tracked(p) },
      direction: "both",
    });
    expect(out.actions.map((a) => `${a.op}:${a.path}`)).toContain("push-modify:s.md");
    expect(out.conflicts).toEqual([]);
  });

  test("disable migration mirrors enable: everything classifies as push-modify back to plaintext", async () => {
    const c = await cipherSha("# Note A\n");
    const out = classify({
      local: { "a.md": local("a.md", await plainSha("# Note A\n")) },
      remote: { "a.md": remote("a.md", c) },
      lastState: { "a.md": tracked(c) },
      direction: "both",
    });
    expect(out.actions.map((a) => `${a.op}:${a.path}`)).toContain("push-modify:a.md");
    expect(out.conflicts).toEqual([]);
  });
});
