import { App } from "obsidian";

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
 * manifest.minAppVersion is 1.6.6, so the property simply does not exist on
 * older builds. It is deliberately reached through a local structural type
 * rather than Obsidian's own `App.secretStorage` declaration: the typings
 * declare it as always present, which would let a plain member access
 * type-check while throwing at runtime on every supported build below
 * 1.11.4. Describing only the shape we use keeps the optionality honest and
 * forces every caller through the feature check in secretStorage().
 *
 * The API has no delete method, only get/set/list, so clearing a secret
 * means storing an empty string.
 */
interface SecretStorageApi {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

interface AppWithSecretStorage {
  secretStorage?: SecretStorageApi;
}

function secretStorage(app: App): SecretStorageApi | null {
  const store = (app as unknown as AppWithSecretStorage).secretStorage;
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

/**
 * The stored token, or null if there is none, the build is too old, or the
 * keystore could not be read (a locked keychain, for instance). Callers
 * treat all three the same way: fall back to whatever data.json holds.
 */
export function readStoredToken(app: App): string | null {
  const store = secretStorage(app);
  if (!store) return null;
  try {
    return store.getSecret(TOKEN_SECRET_ID) || null;
  } catch {
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
  } catch {
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
