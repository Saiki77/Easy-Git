/**
 * The two ends of the key lifecycle, composed from kdf + cipher + metadata:
 * provisioning a brand-new key on the first device, and unlocking from the
 * repo's metadata file on any later device. Pure and side-effect free; the
 * keychain and UI decide where the results get stored.
 */

import { bytesToBase64, base64ToBytes } from "../sync/blob-sha";
import { ContentKeys, checkVerifier, deriveContentKeys, makeVerifier } from "./cipher";
import {
  KDF_ALGO,
  KDF_DEFAULT_ITERATIONS,
  UnwrapFailedError,
  generateKeyId,
  generateMasterKey,
  generateSalt,
  unwrapMasterKey,
  wrapMasterKey,
} from "./kdf";
import { EncryptionMetadataFile } from "./metadata";

export interface UnlockedKey {
  masterKey: Uint8Array;
  keys: ContentKeys;
}

export interface ProvisionResult extends UnlockedKey {
  meta: EncryptionMetadataFile;
}

/** First-device setup: fresh master key, key id, salt, wrap, verifier. */
export async function provisionEncryption(
  passphrase: string,
  iterations: number = KDF_DEFAULT_ITERATIONS,
): Promise<ProvisionResult> {
  const masterKey = generateMasterKey();
  const keyId = generateKeyId();
  const salt = generateSalt();
  const keys = await deriveContentKeys(masterKey, keyId);
  const meta: EncryptionMetadataFile = {
    version: 1,
    keyId,
    kdf: { algo: KDF_ALGO, iterations, salt: bytesToBase64(salt) },
    wrappedKey: await wrapMasterKey(passphrase, salt, iterations, masterKey),
    verifier: bytesToBase64(await makeVerifier(keys)),
  };
  return { meta, masterKey, keys };
}

/** Second-device unlock from the repo's metadata file plus the passphrase. */
export async function unlockWithPassphrase(
  meta: EncryptionMetadataFile,
  passphrase: string,
): Promise<UnlockedKey> {
  if (meta.kdf.algo !== KDF_ALGO) {
    throw new UnwrapFailedError(
      `This destination uses the KDF "${meta.kdf.algo}", which this Easy Git build does not support. Update the plugin.`,
    );
  }
  const masterKey = await unwrapMasterKey(
    passphrase,
    base64ToBytes(meta.kdf.salt),
    meta.kdf.iterations,
    meta.wrappedKey,
  );
  const keys = await deriveContentKeys(masterKey, meta.keyId);
  // Belt and braces on top of GCM's own authentication: catches metadata
  // whose wrappedKey and verifier drifted apart (partial hand-edit).
  if (!(await checkVerifier(keys, base64ToBytes(meta.verifier)))) {
    throw new UnwrapFailedError(
      "Passphrase check failed against the destination's verifier.",
    );
  }
  return { masterKey, keys };
}

/** Unlock with the recovery key (the base64 master key shown at setup). */
export async function unlockWithRecoveryKey(
  meta: EncryptionMetadataFile,
  recoveryKeyB64: string,
): Promise<UnlockedKey> {
  let masterKey: Uint8Array;
  try {
    masterKey = base64ToBytes(recoveryKeyB64.trim());
  } catch {
    throw new UnwrapFailedError("The recovery key is not valid base64.");
  }
  if (masterKey.byteLength !== 32) {
    throw new UnwrapFailedError(
      `The recovery key must decode to 32 bytes, got ${masterKey.byteLength}.`,
    );
  }
  const keys = await deriveContentKeys(masterKey, meta.keyId);
  if (!(await checkVerifier(keys, base64ToBytes(meta.verifier)))) {
    throw new UnwrapFailedError(
      "This recovery key does not match this destination's key.",
    );
  }
  return { masterKey, keys };
}

/** Passphrase change: same master key and key id, fresh salt and wrap.
 * Content is untouched; only the metadata file changes. */
export async function rewrapWithNewPassphrase(
  unlocked: UnlockedKey,
  meta: EncryptionMetadataFile,
  newPassphrase: string,
  iterations: number = KDF_DEFAULT_ITERATIONS,
): Promise<EncryptionMetadataFile> {
  const salt = generateSalt();
  return {
    ...meta,
    kdf: { algo: KDF_ALGO, iterations, salt: bytesToBase64(salt) },
    wrappedKey: await wrapMasterKey(
      newPassphrase,
      salt,
      iterations,
      unlocked.masterKey,
    ),
  };
}
