/**
 * Binary envelope for encrypted file content ("EGE1" format, version 1).
 *
 * Layout:
 *
 *   offset  size   field
 *   0       4      magic "EGE1"
 *   4       1      format version (0x01)
 *   5       16     key id (identifies the master key)
 *   21      12     IV (deterministic; HMAC of the plaintext, see cipher.ts)
 *   33      n+16   AES-256-GCM ciphertext plus tag
 *
 * The AAD for GCM is bytes 0..20 (magic, version, key id). The path is
 * deliberately NOT bound: a moved file must keep byte-identical content so
 * the engine's same-SHA move detection keeps working.
 *
 * The pinned vectors in tests/crypto.test.ts make this layout a contract.
 * Any change here needs a new version byte, never a silent edit.
 */

export const ENVELOPE_MAGIC = new Uint8Array([0x45, 0x47, 0x45, 0x31]); // "EGE1"
export const ENVELOPE_VERSION = 1;
export const KEY_ID_BYTES = 16;
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + 1 + KEY_ID_BYTES;
const MIN_ENVELOPE_BYTES = ENVELOPE_HEADER_BYTES + IV_BYTES + GCM_TAG_BYTES;

/** Malformed envelope: wrong magic, truncated, or an unknown version. */
export class CryptoFormatError extends Error {}

export function hasEnvelopeMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < ENVELOPE_MAGIC.length) return false;
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) return false;
  }
  return true;
}

/** The 21-byte header (magic, version, key id), also used as the GCM AAD. */
export function envelopeHeader(keyIdHex: string): Uint8Array {
  const keyId = hexToBytes(keyIdHex);
  if (keyId.byteLength !== KEY_ID_BYTES) {
    throw new CryptoFormatError(
      `Key id must be ${KEY_ID_BYTES} bytes, got ${keyId.byteLength}.`,
    );
  }
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES);
  header.set(ENVELOPE_MAGIC, 0);
  header[ENVELOPE_MAGIC.length] = ENVELOPE_VERSION;
  header.set(keyId, ENVELOPE_MAGIC.length + 1);
  return header;
}

export function encodeEnvelope(
  keyIdHex: string,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  if (iv.byteLength !== IV_BYTES) {
    throw new CryptoFormatError(`IV must be ${IV_BYTES} bytes, got ${iv.byteLength}.`);
  }
  const header = envelopeHeader(keyIdHex);
  const out = new Uint8Array(header.byteLength + iv.byteLength + ciphertext.byteLength);
  out.set(header, 0);
  out.set(iv, header.byteLength);
  out.set(ciphertext, header.byteLength + iv.byteLength);
  return out;
}

export interface DecodedEnvelope {
  version: number;
  keyIdHex: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  /** Bytes 0..20 as found in the file, for use as GCM AAD. */
  aad: Uint8Array;
}

export function decodeEnvelope(bytes: Uint8Array): DecodedEnvelope {
  if (!hasEnvelopeMagic(bytes)) {
    throw new CryptoFormatError("Not an Easy Git encrypted file (magic missing).");
  }
  if (bytes.byteLength < MIN_ENVELOPE_BYTES) {
    throw new CryptoFormatError(
      `Encrypted file is truncated (${bytes.byteLength} bytes).`,
    );
  }
  const version = bytes[ENVELOPE_MAGIC.length];
  if (version !== ENVELOPE_VERSION) {
    throw new CryptoFormatError(
      `Encrypted file uses format version ${version}; this Easy Git build supports version ${ENVELOPE_VERSION}. Update the plugin.`,
    );
  }
  const keyIdStart = ENVELOPE_MAGIC.length + 1;
  const keyIdHex = bytesToHex(bytes.subarray(keyIdStart, keyIdStart + KEY_ID_BYTES));
  const iv = bytes.slice(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + IV_BYTES);
  const ciphertext = bytes.slice(ENVELOPE_HEADER_BYTES + IV_BYTES);
  const aad = bytes.slice(0, ENVELOPE_HEADER_BYTES);
  return { version, keyIdHex, iv, ciphertext, aad };
}

/**
 * TS 5.7+ types a bare `Uint8Array` as `Uint8Array<ArrayBufferLike>`,
 * which WebCrypto's BufferSource parameters reject (SharedArrayBuffer
 * could not be structured-cloned). Every buffer in this plugin is a plain
 * ArrayBuffer, so this is a type-level re-view, not a copy.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new CryptoFormatError(`Not a hex string: "${hex}".`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
