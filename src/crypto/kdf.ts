/**
 * Passphrase handling: PBKDF2-SHA-256 derives a key-encryption key (KEK)
 * that wraps the random 32-byte master key. Only wrapped material ever
 * leaves the device (inside the repo's metadata file); the passphrase is
 * never stored anywhere. A passphrase change re-wraps the master key and
 * touches no content.
 *
 * PBKDF2 over Argon2 is a deliberate trade: WebCrypto provides it natively
 * on desktop and mobile, so there is no WASM bundle, and the metadata file
 * records the algorithm and iteration count for future agility.
 */

import { bytesToBase64, base64ToBytes } from "../sync/blob-sha";
import { KEY_ID_BYTES, asBufferSource, bytesToHex } from "./format";

export const KDF_ALGO = "PBKDF2-SHA-256";
export const KDF_DEFAULT_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
const WRAP_IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;

/** The wrapped master key failed to unwrap: wrong passphrase, or damaged
 * metadata. Callers show the message as-is. */
export class UnwrapFailedError extends Error {}

export function generateMasterKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));
}

export function generateKeyId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(KEY_ID_BYTES)));
}

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** Exposed separately so tests can pin the derivation as a vector. */
export async function deriveKekBits(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    asBufferSource(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: asBufferSource(salt), iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const bits = await deriveKekBits(passphrase, salt, iterations);
  return crypto.subtle.importKey(
    "raw",
    asBufferSource(bits),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** base64(random IV || AES-256-GCM(masterKey)). A random IV is fine here:
 * the wrap is only rewritten on setup and passphrase change, so determinism
 * is not needed and freshness costs nothing. */
export async function wrapMasterKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  masterKey: Uint8Array,
): Promise<string> {
  const kek = await deriveKek(passphrase, salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      kek,
      asBufferSource(masterKey),
    ),
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, iv.byteLength);
  return bytesToBase64(out);
}

export async function unwrapMasterKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  wrappedB64: string,
): Promise<Uint8Array> {
  let wrapped: Uint8Array;
  try {
    wrapped = base64ToBytes(wrappedB64);
  } catch {
    throw new UnwrapFailedError("The stored key data is not valid base64.");
  }
  if (wrapped.byteLength < WRAP_IV_BYTES + MASTER_KEY_BYTES) {
    throw new UnwrapFailedError("The stored key data is truncated.");
  }
  const iv = wrapped.slice(0, WRAP_IV_BYTES);
  const ciphertext = wrapped.slice(WRAP_IV_BYTES);
  const kek = await deriveKek(passphrase, salt, iterations);
  try {
    const masterKey = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asBufferSource(iv) },
        kek,
        asBufferSource(ciphertext),
      ),
    );
    if (masterKey.byteLength !== MASTER_KEY_BYTES) {
      throw new Error("bad length");
    }
    return masterKey;
  } catch {
    throw new UnwrapFailedError("Wrong passphrase.");
  }
}
