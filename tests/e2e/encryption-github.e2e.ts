/**
 * End-to-end: optional encryption against the real GitHub API, with two
 * simulated devices (separate vaults, separate keychains) sharing one
 * destination. Runs the shipped SyncEngine, keychain and lifecycle code;
 * only the Obsidian vault is in memory.
 *
 *   EASY_GIT_E2E_TOKEN=<token> EASY_GIT_E2E_REPO=owner/name \
 *   EASY_GIT_E2E_BRANCH=<scratch branch> npm run test:e2e
 *
 * Each run writes under e2e-runs/<run id>/ on the scratch branch, which must
 * already exist. The steps share state and run in order.
 */

import { beforeAll, describe, expect, test } from "vitest";
import type { App } from "obsidian";
import { SyncEngine } from "../../src/sync/engine";
import { EncryptionKeychain } from "../../src/crypto/keychain";
import {
  LifecycleContext,
  disableEncryption,
  enableEncryption,
  encryptionState,
  unlockDestination,
} from "../../src/crypto/lifecycle";
import { decryptContent } from "../../src/crypto/cipher";
import { hasEnvelopeMagic } from "../../src/crypto/format";
import { CRYPTO_METADATA_FILENAME, parseMetadata } from "../../src/crypto/metadata";
import { GitHubClient } from "../../src/github/client";
import { getBlobContent, listRemoteFolderFiles } from "../../src/github/git-data";
import { base64ToBytes, bytesToBase64 } from "../../src/sync/blob-sha";
import {
  DEFAULT_SETTINGS,
  FolderMapping,
  GITHUB_API_BASE,
  MappingDestination,
  PluginSettings,
  SyncResult,
} from "../../src/types";
import { FakeVault } from "./fake-vault";

const TOKEN = process.env.EASY_GIT_E2E_TOKEN ?? "";
const [OWNER, REPO] = (process.env.EASY_GIT_E2E_REPO ?? "/").split("/");
const BRANCH = process.env.EASY_GIT_E2E_BRANCH ?? "";
const CONFIGURED = !!(TOKEN && OWNER && REPO && BRANCH);
const RUN_FOLDER = `e2e-runs/${new Date().toISOString().replace(/[:.]/g, "-")}`;

const PASSPHRASE = "correct horse battery staple";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01,
]);
const SEED: Record<string, string | Uint8Array> = {
  "Notes/a.md": "# Alpha\n\nFirst version.\n",
  "Notes/sub/b.md": "# Beta\n\nline 1\nline 2\nline 3\nline 4\nline 5\n",
  "Notes/empty.md": "",
  "Notes/Ümlaut & space.md": "Unicode path, ünïcödé content 東京\n",
  "Notes/pic.png": PNG,
};

class Device {
  readonly vault = new FakeVault();
  readonly secrets = new Map<string, string>();
  readonly settings: PluginSettings;
  readonly mapping: FolderMapping;
  readonly keychain: EncryptionKeychain;
  readonly engine: SyncEngine;

  constructor(name: string) {
    // The mapping dialog only lets a user pick an existing folder, so a new
    // device has the (empty) folder before its first sync.
    this.vault.mkdir("Notes");
    this.mapping = {
      id: `mapping-${name}`,
      name: `E2E ${name}`,
      vaultFolder: "Notes",
      direction: "both",
      autoMode: { kind: "off" },
      rewriteWikilinks: false,
      rewriteWikilinksMigrated: true,
      destinations: [
        { id: "dest", repoOwner: OWNER, repoName: REPO, branch: BRANCH, remoteFolder: RUN_FOLDER },
      ],
    };
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      auth: { method: "pat", token: TOKEN, provider: "github" },
      mappings: [this.mapping],
      // Deterministic conflict handling: exercise the 3-way merge path.
      autoResolveByMtime: false,
      showNotifications: false,
    };
    const app = {
      vault: this.vault,
      fileManager: this.vault.fileManager,
      metadataCache: this.vault.metadataCache,
      secretStorage: {
        getSecret: (id: string) => this.secrets.get(id) ?? null,
        setSecret: (id: string, value: string) => {
          this.secrets.set(id, value);
        },
      },
    } as unknown as App;
    this.keychain = new EncryptionKeychain(app, () => this.settings, async () => {});
    this.engine = new SyncEngine({
      app,
      settings: this.settings,
      saveSettings: async () => {},
      resolveConflicts: async (_m, _d, conflicts) => {
        throw new Error(`unexpected conflict dialog: ${conflicts.map((c) => c.path).join(", ")}`);
      },
      resolveEncryptionKeys: (keyId) => this.keychain.resolve(keyId),
    });
  }

  get dest(): MappingDestination {
    return this.mapping.destinations[0];
  }

  ctx(): LifecycleContext {
    return { keychain: this.keychain, settings: this.settings, save: async () => {} };
  }

  async sync(): Promise<SyncResult> {
    // GitHub serves a just-moved ref from replicas that can lag a moment.
    await new Promise((r) => setTimeout(r, 1500));
    const [result] = await this.engine.syncMapping(this.mapping);
    return result;
  }
}

function changes(r: SyncResult): number {
  return r.added + r.modified + r.deleted + (r.moved ?? 0);
}

function expectOk(r: SyncResult): void {
  expect(r.error, r.error).toBeUndefined();
  expect(r.ok).toBe(true);
}

const client = () => new GitHubClient({ token: TOKEN, baseUrl: GITHUB_API_BASE });

/**
 * Raw bytes of every remote file in the run folder at `commitSha`, keyed by
 * relative path. Pinned to the commit a sync made, never "the branch now":
 * right after a push, GitHub can still serve the previous head.
 */
async function remoteSnapshot(commitSha: string | undefined): Promise<Record<string, Uint8Array>> {
  if (!commitSha) throw new Error("the sync made no commit to inspect");
  const c = client();
  const commit = await c.request<{ tree: { sha: string } }>(
    "GET",
    `/repos/${OWNER}/${REPO}/git/commits/${commitSha}`,
  );
  const scan = await listRemoteFolderFiles(c, OWNER, REPO, commit.tree.sha, RUN_FOLDER);
  const out: Record<string, Uint8Array> = {};
  for (const [path, entry] of Object.entries(scan.files)) {
    out[path] = base64ToBytes((await getBlobContent(c, OWNER, REPO, entry.sha)).content);
  }
  return out;
}

/** What another tool would do: write a plaintext file straight to the repo. */
async function putPlaintextOnRemote(rel: string, text: string): Promise<void> {
  const path = `${RUN_FOLDER}/${rel}`.split("/").map(encodeURIComponent).join("/");
  await client().request("PUT", `/repos/${OWNER}/${REPO}/contents/${path}`, {
    message: "e2e: plaintext written by another tool",
    content: bytesToBase64(new TextEncoder().encode(text)),
    branch: BRANCH,
  });
}

const rel = (vaultPath: string) => vaultPath.replace(/^Notes\//, "");

describe.skipIf(!CONFIGURED)("encryption end to end on GitHub (two devices)", () => {
  const A = new Device("A");
  const B = new Device("B");
  let recoveryKey = "";

  beforeAll(() => {
    for (const [path, content] of Object.entries(SEED)) A.vault.put(path, content);
  });

  test("1. baseline: device A pushes plaintext; a second sync changes nothing", async () => {
    const r1 = await A.sync();
    expectOk(r1);
    expect(r1.added).toBe(5);
    const snap = await remoteSnapshot(r1.commitSha);
    expect(Object.keys(snap).sort()).toEqual(Object.keys(SEED).map(rel).sort());
    for (const bytes of Object.values(snap)) expect(hasEnvelopeMagic(bytes)).toBe(false);
    expect(changes(await A.sync())).toBe(0);
  });

  test("2. turn on: every file is re-uploaded encrypted, and the next sync changes nothing", async () => {
    recoveryKey = await enableEncryption(A.ctx(), A.dest, PASSPHRASE);
    expect(encryptionState(A.dest, A.keychain)).toBe("on");

    const r = await A.sync();
    expectOk(r);
    expect(r.modified).toBe(5);
    expect(A.dest.encryption?.metaUploaded).toBe(true);

    const snap = await remoteSnapshot(r.commitSha);
    const meta = parseMetadata(new TextDecoder().decode(snap[CRYPTO_METADATA_FILENAME]));
    expect(meta.keyId).toBe(A.dest.encryption?.keyId);
    const keys = (await A.keychain.resolve(meta.keyId))!;
    for (const [path, content] of Object.entries(SEED)) {
      const remote = snap[rel(path)];
      expect(hasEnvelopeMagic(remote), path).toBe(true);
      const plain = await decryptContent(keys, remote);
      const want = typeof content === "string" ? new TextEncoder().encode(content) : content;
      expect(Array.from(plain), path).toEqual(Array.from(want));
    }

    // The key property: local ciphertext SHAs equal GitHub's blob SHAs.
    expect(changes(await A.sync())).toBe(0);
  });

  test("3. device B without the passphrase is stopped before it writes anything", async () => {
    const r = await B.sync();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/end-to-end encrypted/);
    expect(r.encryptionAction).toBe("unlock");
    expect(B.vault.filesUnder("Notes")).toEqual([]);
  });

  test("4. a wrong passphrase is refused", async () => {
    const meta = await B.engine.fetchRemoteCryptoMetadata(B.dest);
    expect(meta).not.toBeNull();
    await expect(
      unlockDestination(B.ctx(), B.dest, meta!, "not the passphrase", false, true),
    ).rejects.toThrow(/Wrong passphrase/);
    expect(B.dest.encryption).toBeUndefined();
  });

  test("5. the passphrase unlocks device B, which pulls every file decrypted", async () => {
    const meta = await B.engine.fetchRemoteCryptoMetadata(B.dest);
    await unlockDestination(B.ctx(), B.dest, meta!, PASSPHRASE, false, true);
    expect(encryptionState(B.dest, B.keychain)).toBe("on");

    const r = await B.sync();
    expectOk(r);
    expect(r.added).toBe(5);
    for (const path of Object.keys(SEED)) {
      expect(Array.from(B.vault.bytes(path)), path).toEqual(Array.from(A.vault.bytes(path)));
    }
    expect(changes(await B.sync())).toBe(0);
  });

  test("6. edits travel encrypted in both directions", async () => {
    const path = "Notes/sub/b.md";
    B.vault.put(path, B.vault.text(path) + "line 6 from B\n");
    const rb = await B.sync();
    expectOk(rb);
    expect(rb.modified).toBe(1);
    expect(hasEnvelopeMagic((await remoteSnapshot(rb.commitSha))["sub/b.md"])).toBe(true);

    const ra = await A.sync();
    expectOk(ra);
    expect(ra.modified).toBe(1);
    expect(A.vault.text(path)).toBe(B.vault.text(path));
  });

  test("7. edits on different lines from both devices merge on the decrypted text", async () => {
    const path = "Notes/sub/b.md";
    A.vault.put(path, A.vault.text(path).replace("line 1", "line 1 edited on A"));
    B.vault.put(path, B.vault.text(path).replace("line 5", "line 5 edited on B"));
    expectOk(await A.sync());

    const rb = await B.sync();
    expectOk(rb);
    expect(rb.mergedConflicts).toBe(1);
    const merged = B.vault.text(path);
    expect(merged).toContain("line 1 edited on A");
    expect(merged).toContain("line 5 edited on B");

    const ra = await A.sync();
    expectOk(ra);
    expect(A.vault.text(path)).toBe(merged);
  });

  test("8. a moved file is reported as a move, with encrypted content", async () => {
    A.vault.move("Notes/sub/b.md", "Notes/moved/b.md");
    const ra = await A.sync();
    expectOk(ra);
    expect(ra.moved).toBe(1);
    const snap = await remoteSnapshot(ra.commitSha);
    expect(snap["sub/b.md"]).toBeUndefined();
    expect(hasEnvelopeMagic(snap["moved/b.md"])).toBe(true);

    const rb = await B.sync();
    expectOk(rb);
    expect(rb.moved).toBe(1);
    expect(B.vault.has("Notes/moved/b.md")).toBe(true);
    expect(B.vault.has("Notes/sub/b.md")).toBe(false);
  });

  test("9. a plaintext file written by another tool is pulled, then re-encrypted", async () => {
    const text = "Written on github.com, not encrypted.\n";
    await putPlaintextOnRemote("from-web.md", text);

    const r1 = await A.sync();
    expectOk(r1);
    expect(r1.plaintextRemoteFiles).toBe(1);
    expect(A.vault.text("Notes/from-web.md")).toBe(text);

    const r2 = await A.sync();
    expectOk(r2);
    expect(r2.modified).toBe(1);
    expect(hasEnvelopeMagic((await remoteSnapshot(r2.commitSha))["from-web.md"])).toBe(true);
    expect(changes(await A.sync())).toBe(0);
  });

  test("10. a device that lost its key is locked; the recovery key unlocks it", async () => {
    await B.keychain.forget(B.dest.encryption!.keyId);
    expect(encryptionState(B.dest, B.keychain)).toBe("locked");
    const locked = await B.sync();
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/locked on this device/);
    expect(locked.encryptionAction).toBe("unlock");

    const meta = await B.engine.fetchRemoteCryptoMetadata(B.dest);
    await unlockDestination(B.ctx(), B.dest, meta!, recoveryKey, true, true);
    const r = await B.sync();
    expectOk(r);
    expect(B.vault.text("Notes/from-web.md")).toBe(A.vault.text("Notes/from-web.md"));
    expect(changes(await B.sync())).toBe(0);
  });

  test("11. turn off: every file goes back to plaintext and the metadata file is removed", async () => {
    disableEncryption(A.dest);
    const r = await A.sync();
    expectOk(r);
    expect(r.modified).toBe(6);
    expect(A.dest.pendingCryptoMetaRemoval).toBeUndefined();
    const snap = await remoteSnapshot(r.commitSha);
    expect(snap[CRYPTO_METADATA_FILENAME]).toBeUndefined();
    for (const [path, bytes] of Object.entries(snap)) {
      expect(hasEnvelopeMagic(bytes), path).toBe(false);
    }
    expect(changes(await A.sync())).toBe(0);
  });

  test("12. device B is told to turn it off too, then syncs plaintext with no changes", async () => {
    const r = await B.sync();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/metadata file is missing/);
    expect(r.encryptionAction).toBe("review");

    disableEncryption(B.dest);
    const r2 = await B.sync();
    expectOk(r2);
    expect(changes(r2)).toBe(0);
    expect(B.dest.pendingCryptoMetaRemoval).toBeUndefined();
    expect(changes(await B.sync())).toBe(0);
  });
});
