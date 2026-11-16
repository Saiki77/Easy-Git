import type { App, TFile } from "obsidian";
import type { FolderMapping, MappingDestination } from "../src/types";

/** In-memory vault: path -> text content. Good enough for the engine paths
 * that only touch text files (tryThreeWayMerges' merge-and-backup flow). */
export function fakeApp(files: Record<string, string> = {}): App {
  const store = new Map(Object.entries(files));

  const vault = {
    getFileByPath(path: string): TFile | null {
      if (!store.has(path)) return null;
      return { path } as unknown as TFile;
    },
    async read(file: TFile): Promise<string> {
      const content = store.get(file.path);
      if (content === undefined) throw new Error(`fakeApp: no file at ${file.path}`);
      return content;
    },
    async modify(file: TFile, content: string): Promise<void> {
      store.set(file.path, content);
    },
    async create(path: string, content: string): Promise<void> {
      store.set(path, content);
    },
    async readBinary(): Promise<ArrayBuffer> {
      throw new Error("fakeApp: readBinary not implemented");
    },
    async createBinary(): Promise<void> {
      throw new Error("fakeApp: createBinary not implemented");
    },
    getFolderByPath(): object {
      // Pretend every backup folder already exists so ensureVaultFolder()
      // short-circuits without needing a real createFolder().
      return {};
    },
    adapter: {
      async exists(path: string): Promise<boolean> {
        return store.has(path);
      },
      async read(path: string): Promise<string> {
        const content = store.get(path);
        if (content === undefined) throw new Error(`fakeApp: no file at ${path}`);
        return content;
      },
      async write(path: string, content: string): Promise<void> {
        store.set(path, content);
      },
      async readBinary(): Promise<ArrayBuffer> {
        throw new Error("fakeApp: adapter.readBinary not implemented");
      },
      async writeBinary(): Promise<void> {
        throw new Error("fakeApp: adapter.writeBinary not implemented");
      },
    },
  };

  return { vault } as unknown as App;
}

export function fakeMapping(overrides: Partial<FolderMapping> = {}): FolderMapping {
  return {
    id: "m1",
    name: "Test mapping",
    vaultFolder: "",
    direction: "both",
    autoMode: { kind: "off" },
    destinations: [],
    ...overrides,
  };
}

export function fakeDestination(overrides: Partial<MappingDestination> = {}): MappingDestination {
  return {
    id: "d1",
    repoOwner: "owner",
    repoName: "repo",
    branch: "main",
    remoteFolder: "",
    ...overrides,
  };
}
