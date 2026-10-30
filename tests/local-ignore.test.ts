/**
 * Pins the .easygitignore fix: Obsidian's vault layer hides dotfiles
 * (getFileByPath returns null for them), so loadLocalIgnore must fall back
 * to the filesystem-faithful adapter or the documented per-mapping ignore
 * file silently never applies and excluded files get pushed. The fake vault
 * here mirrors the real API's dotfile blindness exactly.
 */

import { describe, expect, test } from "vitest";
import type { App } from "obsidian";
import { SyncEngine } from "../src/sync/engine";
import { isExcluded } from "../src/sync/exclusion";
import { DEFAULT_SETTINGS, FolderMapping } from "../src/types";

interface EngineInternals {
  loadLocalIgnore(mapping: FolderMapping): Promise<string[]>;
}

function makeEngine(opts: {
  onDisk?: Record<string, string>;
  adapterReadThrows?: boolean;
}): EngineInternals {
  const onDisk = opts.onDisk ?? {};
  const app = {
    vault: {
      // Obsidian filters dotfiles out of getFileByPath()/getFiles(); the
      // fake does the same so a regression back to the vault-only lookup
      // fails this suite.
      getFileByPath: (p: string) => {
        const base = p.slice(p.lastIndexOf("/") + 1);
        if (base.startsWith(".")) return null;
        return null;
      },
      read: async () => {
        throw new Error("vault.read must not be reachable for dotfiles");
      },
      adapter: {
        exists: async (p: string) => p in onDisk,
        read: async (p: string) => {
          if (opts.adapterReadThrows) throw new Error("locked file");
          const text = onDisk[p];
          if (text === undefined) throw new Error(`missing: ${p}`);
          return text;
        },
      },
    },
  };
  const engine = new SyncEngine({
    app: app as unknown as App,
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: async () => {},
    resolveConflicts: async () => null,
  });
  return engine as unknown as EngineInternals;
}

function mapping(vaultFolder: string): FolderMapping {
  return {
    id: "m1",
    name: "Test",
    vaultFolder,
    direction: "push",
    autoMode: { kind: "off" },
    destinations: [],
  };
}

describe("loadLocalIgnore", () => {
  test("reads the dotfile through the adapter although the vault layer cannot see it", async () => {
    // The reporter's exact repro from issue #8: wiki/.easygitignore with
    // "schema/" must exclude wiki/schema/config.md from the push.
    const engine = makeEngine({
      onDisk: { "wiki/.easygitignore": "# per-mapping excludes\nschema/\n*.tmp\n" },
    });
    const patterns = await engine.loadLocalIgnore(mapping("wiki"));
    expect(patterns).toContain("schema/");
    expect(isExcluded("schema/config.md", patterns)).toBe(true);
    expect(isExcluded("notes/kept.md", patterns)).toBe(false);
    expect(isExcluded("scratch.tmp", patterns)).toBe(true);
  });

  test("whole-vault mapping reads .easygitignore at the vault root", async () => {
    const engine = makeEngine({
      onDisk: { ".easygitignore": "private/\n" },
    });
    const patterns = await engine.loadLocalIgnore(mapping(""));
    expect(isExcluded("private/secret.md", patterns)).toBe(true);
  });

  test("no file anywhere returns no patterns", async () => {
    const engine = makeEngine({ onDisk: {} });
    expect(await engine.loadLocalIgnore(mapping("wiki"))).toEqual([]);
  });

  test("an adapter read failure degrades to no patterns instead of throwing", async () => {
    const engine = makeEngine({
      onDisk: { "wiki/.easygitignore": "schema/\n" },
      adapterReadThrows: true,
    });
    expect(await engine.loadLocalIgnore(mapping("wiki"))).toEqual([]);
  });
});
