/**
 * The encryption lifecycle of one destination, without any UI: turn on,
 * unlock on another device, turn off, and the state the settings show. The
 * dialogs in main.ts call these, and so does the end-to-end test against
 * GitHub, so the tested code is the shipped code.
 */

import { bytesToBase64 } from "../sync/blob-sha";
import { MappingDestination, PluginSettings } from "../types";
import { EncryptionKeychain } from "./keychain";
import { EncryptionMetadataFile } from "./metadata";
import {
  provisionEncryption,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from "./provision";

export interface LifecycleContext {
  keychain: EncryptionKeychain;
  settings: PluginSettings;
  save: () => Promise<void>;
}

/** "off": plaintext. "on": encrypted, key on this device. "locked":
 * encrypted, but this device has no key yet (the passphrase unlocks it). */
export type EncryptionState = "off" | "on" | "locked";

export function encryptionState(
  destination: MappingDestination,
  keychain: EncryptionKeychain,
): EncryptionState {
  if (!destination.encryption) return "off";
  return keychain.hasKey(destination.encryption.keyId) ? "on" : "locked";
}

/**
 * Turn encryption on with a new key. Returns the recovery key (the base64
 * master key), which the UI shows exactly once. The next sync uploads the
 * metadata file and re-uploads every file encrypted.
 */
export async function enableEncryption(
  ctx: LifecycleContext,
  destination: MappingDestination,
  passphrase: string,
  iterations?: number,
): Promise<string> {
  const result = await provisionEncryption(passphrase, iterations);
  await ctx.keychain.store(result.meta.keyId, result.masterKey);
  rememberMetadata(ctx.settings, result.meta);
  destination.encryption = { keyId: result.meta.keyId };
  destination.pendingCryptoMetaRemoval = undefined;
  await ctx.save();
  return bytesToBase64(result.masterKey);
}

/**
 * Unlock an encrypted destination on this device with the passphrase or the
 * recovery key. `fromRemote` says whether `meta` was read from the remote
 * (it is there, so nothing to upload) or from this device's own copy after
 * an interrupted enable (the next sync still has to upload it). Throws with
 * a user-showable message on a wrong secret.
 */
export async function unlockDestination(
  ctx: LifecycleContext,
  destination: MappingDestination,
  meta: EncryptionMetadataFile,
  secret: string,
  useRecoveryKey: boolean,
  fromRemote: boolean,
): Promise<void> {
  const unlocked = useRecoveryKey
    ? await unlockWithRecoveryKey(meta, secret)
    : await unlockWithPassphrase(meta, secret);
  await ctx.keychain.store(meta.keyId, unlocked.masterKey);
  rememberMetadata(ctx.settings, meta);
  destination.encryption = {
    keyId: meta.keyId,
    metaUploaded: fromRemote ? true : destination.encryption?.metaUploaded,
  };
  destination.pendingCryptoMetaRemoval = undefined;
  await ctx.save();
}

/**
 * Turn encryption off. The next sync re-uploads every file as plaintext and
 * deletes the remote metadata file. The key stays on this device. The
 * caller saves settings.
 */
export function disableEncryption(destination: MappingDestination): void {
  destination.encryption = undefined;
  destination.pendingCryptoMetaRemoval = true;
}

function rememberMetadata(settings: PluginSettings, meta: EncryptionMetadataFile): void {
  settings.encryptionMeta = { ...(settings.encryptionMeta ?? {}), [meta.keyId]: meta };
}
