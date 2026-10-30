/**
 * Minimal runtime stand-in for the `obsidian` package, which ships type
 * declarations only (no JS), so any module importing it cannot run under
 * vitest without this alias (wired in vitest.config.ts). Provides just the
 * names the engine's import graph touches at runtime; tests build their own
 * fake `app` objects, so these are deliberately inert.
 */

export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

export class App {}

export class Notice {
  constructor(_message?: string, _timeout?: number) {}
}

/** Obsidian's normalizePath trims slashes and collapses separators; the
 * tests only need the trim part. */
export function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in tests");
}
