import assert from "node:assert/strict";
import esbuild from "esbuild";

const testSource = `
import assert from "node:assert/strict";
import { requestBodies, TFolder } from "obsidian";
import { startDeviceFlow } from "./src/github/auth";
import { GitHubApiError } from "./src/github/client";
import { createTree } from "./src/github/git-data";
import { SyncEngine } from "./src/sync/engine";
import { base64ToArrayBuffer } from "./src/sync/blob-sha";

const encoder = new TextEncoder();
const originalGitignore = encoder.encode("dist/\\r\\n.cache/\\r\\n");

await startDeviceFlow("test-client-id");
assert.equal(
  JSON.parse(requestBodies.at(-1)).scope,
  "repo workflow",
  "Device Flow must request workflow access when workflow files are supported",
);

const workflowPermissionError = new GitHubApiError({
  status: 403,
  url: "https://api.github.com/repos/example/repo/git/trees",
  message: "Forbidden",
  body: null,
});
await assert.rejects(
  createTree(
    { request: async () => { throw workflowPermissionError; } } as any,
    "example",
    "repo",
    "base",
    [{ path: ".github/workflows/test.yml", mode: "100644", type: "blob", sha: "sha" }],
  ),
  /workflow write access/,
  "Workflow permission failures must explain the required permission",
);
await assert.rejects(
  createTree(
    { request: async () => { throw workflowPermissionError; } } as any,
    "example",
    "repo",
    "base",
    [{ path: "notes/test.md", mode: "100644", type: "blob", sha: "sha" }],
  ),
  (error: unknown) => error === workflowPermissionError,
  "Non-workflow failures must preserve the original GitHub API error",
);

class MemoryAdapter {
  files = new Map<string, Uint8Array>([
    [".gitignore", originalGitignore],
    [".easygitignore", encoder.encode("*.tmp\\r\\n")],
    [".github/workflows/test.yml", encoder.encode("name: test\\r\\n")],
    [".git/config", encoder.encode("secret\\r\\n")],
  ]);
  trashed: string[] = [];
  listings = new Map([
    ["/", { files: [".gitignore", ".easygitignore"], folders: [".github", ".git"] }],
    [".github", { files: [], folders: [".github/workflows"] }],
    [".github/workflows", { files: [".github/workflows/test.yml"], folders: [] }],
    [".git", { files: [".git/config"], folders: [] }],
  ]);

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.listings.has(path);
  }
  async list(path: string) {
    const listing = this.listings.get(path);
    if (!listing) throw new Error("Folder not found: " + path);
    return listing;
  }
  async stat(path: string) {
    const bytes = this.files.get(path);
    return bytes ? { type: "file", ctime: 1, mtime: 2, size: bytes.byteLength } : null;
  }
  async read(path: string): Promise<string> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("File not found: " + path);
    return new TextDecoder().decode(bytes);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("File not found: " + path);
    return bytes.slice().buffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data.slice(0)));
  }
  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error("File not found: " + from);
    this.files.delete(from);
    this.files.set(to, bytes);
  }
  async trashLocal(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error("File not found: " + path);
    this.trashed.push(path);
  }
}

const adapter = new MemoryAdapter();
const root = new TFolder("");
const app: any = {
  vault: {
    adapter,
    configDir: ".obsidian",
    getFileByPath: () => null,
    getFolderByPath: () => null,
    getFiles: () => [],
    createFolder: async () => undefined,
  },
  fileManager: {},
  metadataCache: {},
};
const settings: any = {
  auth: { method: "none", token: "", provider: "github" },
  mappings: [],
  defaultCommitTemplate: "",
  excludedPaths: [],
  maxFileSizeBytes: 1024 * 1024,
  showNotifications: false,
  debugLogging: false,
};
const engine: any = new SyncEngine({
  app,
  settings,
  saveSettings: async () => undefined,
  resolveConflicts: async () => [],
});
const mapping: any = {
  id: "mapping",
  name: "Hidden paths",
  vaultFolder: "",
  direction: "push",
  autoMode: { kind: "off" },
  destinations: [],
};

assert.deepEqual(
  await engine.loadLocalIgnore(mapping),
  ["*.tmp", ""],
  ".easygitignore must be readable through the adapter even when the vault index hides it",
);

const scanned: Record<string, unknown> = {};
await engine.augmentScanWithHiddenPaths(
  root,
  mapping,
  scanned,
  [".git/**", ".easy-git-backup/**"],
  1024 * 1024,
);
assert.deepEqual(
  Object.keys(scanned).sort(),
  [".easygitignore", ".github/workflows/test.yml", ".gitignore"],
  "Hidden folders and files must be scanned while .git/** remains excluded",
);

const upload = await engine.readVaultFile(mapping, ".gitignore");
assert.deepEqual(
  new Uint8Array(base64ToArrayBuffer(upload.base64)),
  originalGitignore,
  "Hidden-file upload must preserve the original CRLF bytes",
);

await engine.backupVaultFile(mapping, ".gitignore", "2026-08-04-000000");
assert.deepEqual(
  adapter.files.get(".easy-git-backup/2026-08-04-000000/.gitignore"),
  originalGitignore,
  "Hidden-file backup must preserve exact bytes",
);

await engine.renameInVault(mapping, ".gitignore", ".renamed-gitignore");
assert.equal(adapter.files.has(".gitignore"), false);
assert.deepEqual(adapter.files.get(".renamed-gitignore"), originalGitignore);

await engine.applyPullDelete(mapping, { path: ".renamed-gitignore" });
assert.deepEqual(adapter.trashed, [".renamed-gitignore"]);
assert.equal(adapter.files.has(".renamed-gitignore"), false);
`;

const result = await esbuild.build({
  stdin: {
    contents: testSource,
    resolveDir: process.cwd(),
    sourcefile: "hidden-path-regression.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  plugins: [
    {
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({
          path: "obsidian",
          namespace: "obsidian-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
          loader: "js",
          contents: `
            export class TFolder {
              constructor(path = "") { this.path = path; this.children = []; }
            }
            export class TFile {}
            export class Notice { constructor() {} }
            export function normalizePath(path) {
              return path.replace(/\\\\/g, "/").replace(/^\\/+/, "");
            }
            export const requestBodies = [];
            export async function requestUrl(options) {
              requestBodies.push(options.body);
              return {
                status: 200,
                text: JSON.stringify({
                  device_code: "device",
                  user_code: "code",
                  verification_uri: "https://github.com/login/device",
                  expires_in: 900,
                  interval: 5,
                }),
              };
            }
          `,
        }));
      },
    },
  ],
});

assert.equal(result.outputFiles.length, 1);
const encoded = Buffer.from(result.outputFiles[0].contents).toString("base64");
await import(`data:text/javascript;base64,${encoded}`);
console.log("Hidden-path regression checks passed");
