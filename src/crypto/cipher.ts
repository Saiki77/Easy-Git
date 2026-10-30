/**
 * Deterministic AES-256-GCM for file content.
 *
 * The IV is an HMAC of the plaintext (SIV-style), so the same plaintext
 * under the same key always produces byte-identical envelopes. That is the
 * property the whole sync engine relies on: unchanged files keep unchanged
 * blob SHAs, and moved files keep byte-identical content for same-SHA move
 * detection. Distinct plaintexts get distinct IVs except with negligible
 * probability, so GCM's IV-reuse failure mode cannot occur across
 * different content. The accepted cost is an equality leak: an observer
 * can tell when two files (or two revisions) hold identical content.
 *
 * All primitives are WebCrypto; Obsidian provides crypto.subtle on both
 * desktop and mobile, so there is no bundled crypto dependency.
 */

import {
  DecodedEnvelope,
  IV_BYTES,
  asBufferSource,
  decodeEnvelope,
  encodeEnvelope,
  envelopeHeader,
} from "./format";

/** The per-key-id triple every encrypt/decrypt call needs. Derived once
 * from the 32-byte master key and cached by the keychain. */
export interface ContentKeys {
  /** Hex key id, matching the envelope header and the metadata file. */
  keyId: string;
  encKey: CryptoKey;
  ivKey: CryptoKey;
}

/** The envelope was made with a different master key than the one on hand. */
export class WrongKeyIdError extends Error {
  constructor(
    public readonly expected: string,
    public readonly found: string,
  ) {
    super(
      `File is encrypted with a different key (${found.slice(0, 8)}…) than this destination is unlocked with (${expected.slice(0, 8)}…).`,
    );
  }
}

/** GCM authentication failed: wrong key material or corrupted ciphertext. */
export class DecryptFailedError extends Error {}

const HKDF_INFO_ENC = "easy-git:enc:v1";
const HKDF_INFO_IV = "easy-git:iv:v1";
const VERIFIER_PLAINTEXT = "easy-git-verifier-v1";

export async function deriveContentKeys(
  masterKey: Uint8Array,
  keyId: string,
): Promise<ContentKeys> {
  const material = await crypto.subtle.importKey(
    "raw",
    asBufferSource(masterKey),
    "HKDF",
    false,
    ["deriveKey", "deriveBits"],
  );
  const encKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO_ENC),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const ivBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO_IV),
    },
    material,
    256,
  );
  const ivKey = await crypto.subtle.importKey(
    "raw",
    ivBits,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { keyId, encKey, ivKey };
}

/** Plaintext bytes to a complete EGE1 envelope. Deterministic. */
export async function encryptContent(
  keys: ContentKeys,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", keys.ivKey, asBufferSource(plaintext)),
  );
  const iv = mac.slice(0, IV_BYTES);
  const aad = envelopeHeader(keys.keyId);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: asBufferSource(aad),
        tagLength: 128,
      },
      keys.encKey,
      asBufferSource(plaintext),
    ),
  );
  return encodeEnvelope(keys.keyId, iv, ciphertext);
}

/** Complete envelope back to plaintext bytes. Throws CryptoFormatError on a
 * malformed envelope, WrongKeyIdError on a key-id mismatch, and
 * DecryptFailedError when authentication fails. */
export async function decryptContent(
  keys: ContentKeys,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  const decoded: DecodedEnvelope = decodeEnvelope(envelope);
  if (decoded.keyIdHex !== keys.keyId) {
    throw new WrongKeyIdError(keys.keyId, decoded.keyIdHex);
  }
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(decoded.iv),
        additionalData: asBufferSource(decoded.aad),
        tagLength: 128,
      },
      keys.encKey,
      asBufferSource(decoded.ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    throw new DecryptFailedError(
      "Encrypted file failed authentication (wrong key or corrupted data).",
    );
  }
}

/** Deterministic encryption of a fixed string. Stored in the metadata file
 * so an unlock can confirm the passphrase without fetching any content. */
export async function makeVerifier(keys: ContentKeys): Promise<Uint8Array> {
  return encryptContent(keys, new TextEncoder().encode(VERIFIER_PLAINTEXT));
}

export async function checkVerifier(
  keys: ContentKeys,
  verifier: Uint8Array,
): Promise<boolean> {
  try {
    const plain = await decryptContent(keys, verifier);
    return new TextDecoder().decode(plain) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}
