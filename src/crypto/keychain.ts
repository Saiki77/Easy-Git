/**
 * Where master keys live on this device, resolved in order: in-memory
 * cache, OS keystore (Obsidian 1.11.4+), data.json fallback. Mirrors the
 * token handling in main.ts: with a keystore, keys are never written to
 * data.json; without one, they stay in settings.encryptionKeys and the
 * settings UI warns about it. A locked keychain must never lose a key, so
 * every keystore write failure falls back to data.json instead of throwing.
 */

import { App } from "obsidian";
import {
  clearStoredKey,
  readStoredKey,
  secretStorageAvailable,
  writeStoredKey,
} from "../secret-storage";
import { base64ToBytes, bytesToBase64 } from "../sync/blob-sha";
import { PluginSettings } from "../types";
import { ContentKeys, deriveContentKeys } from "./cipher";

export class EncryptionKeychain {
  private cache = new Map<string, ContentKeys>();

  constructor(
    private app: App,
    private getSettings: () => PluginSettings,
    private saveSettings: () => Promise<void>,
  ) {}

  /**
   * Content keys for this key id, or null when the key is not on this
   * device (a locked destination). Never prompts; the UI owns prompting.
   */
  async resolve(keyId: string): Promise<ContentKeys | null> {
    const cached = this.cache.get(keyId);
    if (cached) return cached;
    const b64 =
      readStoredKey(this.app, keyId) ??
      this.getSettings().encryptionKeys?.[keyId] ??
      null;
    if (!b64) return null;
    let masterKey: Uint8Array;
    try {
      masterKey = base64ToBytes(b64);
    } catch {
      return null;
    }
    if (masterKey.byteLength !== 32) return null;
    const keys = await deriveContentKeys(masterKey, keyId);
    this.cache.set(keyId, keys);
    return keys;
  }

  /** True when key material exists on this device, without deriving. */
  hasKey(keyId: string): boolean {
    if (this.cache.has(keyId)) return true;
    if (readStoredKey(this.app, keyId)) return true;
    return !!this.getSettings().encryptionKeys?.[keyId];
  }

  /** Persist a master key and warm the cache. */
  async store(keyId: string, masterKey: Uint8Array): Promise<void> {
    const b64 = bytesToBase64(masterKey);
    const s = this.getSettings();
    if (writeStoredKey(this.app, keyId, b64)) {
      // In the keystore; drop any stale fallback copy from data.json.
      if (s.encryptionKeys && keyId in s.encryptionKeys) {
        delete s.encryptionKeys[keyId];
      }
    } else {
      s.encryptionKeys = s.encryptionKeys ?? {};
      s.encryptionKeys[keyId] = b64;
    }
    this.cache.set(keyId, await deriveContentKeys(masterKey, keyId));
    await this.saveSettings();
  }

  /** Remove a key from every store on this device. The remote metadata
   * file is untouched; the passphrase can always unlock again. */
  async forget(keyId: string): Promise<void> {
    clearStoredKey(this.app, keyId);
    const s = this.getSettings();
    if (s.encryptionKeys && keyId in s.encryptionKeys) {
      delete s.encryptionKeys[keyId];
    }
    this.cache.delete(keyId);
    await this.saveSettings();
  }

  /**
   * Move any data.json fallback keys into the keystore, exactly like
   * hydrateToken() promotes an old plaintext token. Called from
   * loadSettings(); returns true when data.json needs rewriting. Keys the
   * keystore refuses (locked keychain) stay in the fallback.
   */
  promoteFallbackKeys(): boolean {
    if (!secretStorageAvailable(this.app)) return false;
    const s = this.getSettings();
    if (!s.encryptionKeys) return false;
    let dirty = false;
    for (const [keyId, b64] of Object.entries(s.encryptionKeys)) {
      if (writeStoredKey(this.app, keyId, b64)) {
        delete s.encryptionKeys[keyId];
        dirty = true;
      }
    }
    return dirty;
  }

  /** True when keys can only live in data.json on this build, so the
   * settings UI can warn. */
  usesFallbackStorage(): boolean {
    return !secretStorageAvailable(this.app);
  }
}
