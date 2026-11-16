/**
 * Where the token lives, and what "signed in" means.
 *
 * On Obsidian 1.11.4+ the token sits in the OS keystore, which is per
 * device, while the rest of `auth` (method, username, provider) is saved in
 * data.json, which can travel between devices: Obsidian Sync, iCloud, or a
 * plugin that shares each plugin's data.json. So `method` describes
 * whichever device last wrote the file, not necessarily this one. Rules:
 *
 * 1. Signed in on this device means a token is in memory after hydration.
 *    `method` never decides it.
 * 2. A missing token on this device is never written back as a sign-out:
 *    another device may be signed in, and the shared file is theirs too.
 * 3. Only an explicit sign-out blanks the keystore. An empty in-memory token
 *    can also mean the keystore was unreadable at load; blanking it then
 *    would destroy a token the user never removed.
 *
 * The functions take a TokenStore instead of the App, so these rules are
 * testable without Obsidian. main.ts wires the real keystore.
 */

import { GitHubAuth, authConfigError } from "./types";

export interface TokenStore {
  /** True when tokens live in the keystore, so they are per device. */
  readonly available: boolean;
  /** The stored token, or null: none stored, or the keystore is unreadable. */
  read(): string | null;
  /** False when the write did not happen, for example a locked keystore. */
  write(token: string): boolean;
}

export function isSignedIn(auth: GitHubAuth): boolean {
  return !!auth.token;
}

/**
 * The sign-in method a token came from. GitHub prefixes its tokens: `gho_`
 * is an OAuth (device flow) token, `ghu_` a GitHub App user token,
 * `ghp_` / `github_pat_` are PATs. Forgejo only has PATs here.
 */
export function inferAuthMethod(auth: GitHubAuth): "pat" | "oauth" {
  if (auth.provider === "forgejo") return "pat";
  return /^gh[ou]_/.test(auth.token) ? "oauth" : "pat";
}

/**
 * The reason a sync cannot use this auth, or null when it can. The one
 * check behind sync, Test connection, the repo pickers and the encryption
 * commands, so a passing Test connection means sync can run.
 */
export function authProblem(auth: GitHubAuth): string | null {
  if (!isSignedIn(auth)) {
    return auth.method !== "none"
      ? "Not signed in on this device. Easy Git stores the token per device: sign in once in Easy Git settings on this device."
      : "Not signed in. Configure auth in settings.";
  }
  return authConfigError(auth);
}

/**
 * Load-time step: bring the token into memory, then make `method` agree
 * with it. Returns true when data.json needs rewriting.
 */
export function hydrateAuth(auth: GitHubAuth, store: TokenStore): boolean {
  let dirty = false;
  if (store.available) {
    if (auth.token) {
      // A plaintext token from an older version or a downgrade round-trip.
      // Move it into the keystore. If the keystore refuses, leave data.json
      // as it is rather than lose the token.
      if (store.write(auth.token)) dirty = true;
    } else {
      const stored = store.read();
      if (stored) auth.token = stored;
    }
  }
  if (reconcileAuthMethod(auth, store.available)) dirty = true;
  return dirty;
}

/**
 * Make `method` agree with the token actually on this device. Returns true
 * when it changed anything.
 *
 * - A token with method "none" (or an unknown value) is drift, not a
 *   sign-out. Older versions reset `method` on every device that lacked the
 *   token, and data.json carries that to devices that still have one, so
 *   this state exists in the wild and still arrives from devices running
 *   those versions. Infer the method back from the token.
 * - No token, keystore in use: this device has none, but another may. Leave
 *   the shared `method` alone (rule 2).
 * - No token, token kept in data.json: a method without a token is a
 *   half-cleared sign-out. Reset it.
 */
export function reconcileAuthMethod(
  auth: GitHubAuth,
  tokenIsPerDevice: boolean,
): boolean {
  const known =
    auth.method === "pat" || auth.method === "oauth" || auth.method === "none";
  if (auth.token) {
    if (known && auth.method !== "none") return false;
    auth.method = inferAuthMethod(auth);
    return true;
  }
  if (known && (auth.method === "none" || tokenIsPerDevice)) return false;
  auth.method = "none";
  auth.username = undefined;
  auth.scopes = undefined;
  return true;
}

/**
 * Save-time step: the auth object as written to data.json. With a
 * keystore, a token in memory goes there and is blanked in the copy, so the
 * credential exists in one place. An empty token never touches the
 * keystore (rule 3); explicit sign-out clears it on its own.
 */
export function authForDisk(auth: GitHubAuth, store: TokenStore): GitHubAuth {
  if (!store.available || !auth.token) return auth;
  if (!store.write(auth.token)) return auth;
  return { ...auth, token: "" };
}
