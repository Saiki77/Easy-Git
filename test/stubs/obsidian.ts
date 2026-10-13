/**
 * Minimal stand-in for the real "obsidian" package, which ships types only
 * (package.json "main": "") and has no runtime module to import outside the
 * Obsidian app. vitest.config.ts aliases "obsidian" to this file so tests
 * can import sync/github modules without a real Obsidian environment.
 *
 * Covers only what src/sync/engine.ts and src/github/client.ts touch at
 * runtime. Add to it if a test needs to import a module that reaches a
 * symbol not stubbed here.
 */

export class Notice {
  constructor(
    public message: string,
    public timeout?: number,
  ) {}
}

export class TFile {
  path = "";
}

export class TFolder {
  path = "";
  children: unknown[] = [];
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export async function requestUrl(): Promise<never> {
  throw new Error(
    "requestUrl stub called directly — tests should mock GitHubClient.request instead",
  );
}
