/* eslint-disable obsidianmd/no-unsupported-api --
 * This module is the guarded boundary for an API newer than minAppVersion
 * (1.11.4 vs 1.6.6). Every entry point below feature checks before touching
 * app.secretStorage and falls back to data.json when it is absent, which is
 * what the rule is asking for. The disable is deliberately file scoped so
 * the rule keeps firing on any unguarded use elsewhere in the plugin.
 */
import { App, SecretStorage } from "obsidian";

/**
 * Secret IDs must be lowercase alphanumeric with optional dashes; anything
 * else makes setSecret() throw.
 */
const TOKEN_SECRET_ID = "easy-git-token";

/**
 * Obsidian 1.11.4+ exposes `app.secretStorage`, backed by the OS keystore
 * (macOS Keychain, Windows DPAPI, Linux secret service) instead of the
 * plugin's data.json.
 *
 * The typings declare it as always present, but manifest.minAppVersion is
 * 1.6.6, so at runtime it is undefined on older builds. Everything here
 * feature checks first and degrades to leaving the token in data.json.
 *
 * The API has no delete method, only get/set/list, so clearing a secret
 * means storing an empty string.
 */
function secretStorage(app: App): SecretStorage | null {
  const store: SecretStorage | undefined = app.secretStorage;
  if (
    !store ||
    typeof store.getSecret !== "function" ||
    typeof store.setSecret !== "function"
  ) {
    return null;
  }
  return store;
}

/** True when this Obsidian build can store the token outside data.json. */
export function secretStorageAvailable(app: App): boolean {
  return secretStorage(app) !== null;
}

/** The stored token, or null if there is none (or no secret storage). */
export function readStoredToken(app: App): string | null {
  const store = secretStorage(app);
  if (!store) return null;
  try {
    return store.getSecret(TOKEN_SECRET_ID) || null;
  } catch (e) {
    console.error("Easy Git: could not read the token from secret storage.", e);
    return null;
  }
}

/**
 * Persist the token to the OS keystore. Returns false if the write did not
 * happen, which callers must treat as "keep the token in data.json" rather
 * than dropping it, otherwise a failing keystore would sign the user out.
 */
export function writeStoredToken(app: App, token: string): boolean {
  const store = secretStorage(app);
  if (!store) return false;
  try {
    store.setSecret(TOKEN_SECRET_ID, token);
    return true;
  } catch (e) {
    console.error("Easy Git: could not write the token to secret storage.", e);
    return false;
  }
}

/**
 * Blank the stored token. Called when the user signs out, so that the next
 * load cannot rehydrate a credential the user just cleared.
 */
export function clearStoredToken(app: App): void {
  writeStoredToken(app, "");
}
