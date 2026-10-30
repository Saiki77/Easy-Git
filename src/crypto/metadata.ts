/**
 * The public key-material file stored at the destination's remoteFolder
 * root. Nothing in it is secret: it carries the KDF parameters, the
 * passphrase-wrapped master key, and a verifier, which is exactly what a
 * second device needs to unlock with the passphrase alone. The file is
 * excluded from sync classification on both sides; the engine writes it
 * once on the first encrypted push and otherwise leaves it alone.
 */

export const CRYPTO_METADATA_FILENAME = ".easy-git-crypto.json";

export interface EncryptionMetadataFile {
  version: 1;
  /** Hex id of the master key; matches every envelope's header. */
  keyId: string;
  kdf: {
    algo: string;
    iterations: number;
    /** base64 */
    salt: string;
  };
  /** base64; see kdf.ts wrapMasterKey. */
  wrappedKey: string;
  /** base64 EGE1 envelope of a fixed string; see cipher.ts makeVerifier. */
  verifier: string;
}

export function serializeMetadata(meta: EncryptionMetadataFile): string {
  return JSON.stringify(meta, null, 2) + "\n";
}

/** Parse and validate. Throws with a user-showable message on anything
 * malformed, since this file may have been hand-edited or corrupted. */
export function parseMetadata(text: string): EncryptionMetadataFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${CRYPTO_METADATA_FILENAME} is not valid JSON.`);
  }
  const meta = raw as Partial<EncryptionMetadataFile>;
  if (meta.version !== 1) {
    throw new Error(
      `${CRYPTO_METADATA_FILENAME} has version ${String(meta.version)}; this Easy Git build supports version 1. Update the plugin.`,
    );
  }
  if (typeof meta.keyId !== "string" || !/^[0-9a-f]{32}$/.test(meta.keyId)) {
    throw new Error(`${CRYPTO_METADATA_FILENAME} has a malformed key id.`);
  }
  const kdf = meta.kdf;
  if (
    !kdf ||
    typeof kdf.algo !== "string" ||
    typeof kdf.salt !== "string" ||
    typeof kdf.iterations !== "number" ||
    !Number.isFinite(kdf.iterations) ||
    kdf.iterations < 1
  ) {
    throw new Error(`${CRYPTO_METADATA_FILENAME} has malformed KDF parameters.`);
  }
  if (typeof meta.wrappedKey !== "string" || !meta.wrappedKey) {
    throw new Error(`${CRYPTO_METADATA_FILENAME} is missing the wrapped key.`);
  }
  if (typeof meta.verifier !== "string" || !meta.verifier) {
    throw new Error(`${CRYPTO_METADATA_FILENAME} is missing the verifier.`);
  }
  return {
    version: 1,
    keyId: meta.keyId,
    kdf: { algo: kdf.algo, iterations: kdf.iterations, salt: kdf.salt },
    wrappedKey: meta.wrappedKey,
    verifier: meta.verifier,
  };
}
