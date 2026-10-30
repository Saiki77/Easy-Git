import { describe, expect, test } from "vitest";
import {
  CryptoFormatError,
  ENVELOPE_HEADER_BYTES,
  IV_BYTES,
  bytesToHex,
  decodeEnvelope,
  hasEnvelopeMagic,
  hexToBytes,
} from "../src/crypto/format";
import {
  ContentKeys,
  DecryptFailedError,
  WrongKeyIdError,
  checkVerifier,
  decryptContent,
  deriveContentKeys,
  encryptContent,
  makeVerifier,
} from "../src/crypto/cipher";
import { UnwrapFailedError, deriveKekBits, generateKeyId, generateMasterKey } from "../src/crypto/kdf";
import { parseMetadata, serializeMetadata } from "../src/crypto/metadata";
import {
  provisionEncryption,
  rewrapWithNewPassphrase,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from "../src/crypto/provision";
import {
  base64ToBytes,
  bytesToBase64,
  computeGitBlobShaFromBytes,
} from "../src/sync/blob-sha";

// ---------------------------------------------------------------------------
// Pinned vectors. These make the on-disk format a contract: if any of these
// assertions ever fails, the change would strand every existing encrypted
// repo. Bump the envelope version instead of editing the expectations.
// ---------------------------------------------------------------------------

const VEC_MASTER_KEY = new Uint8Array(32).map((_, i) => i);
const VEC_KEY_ID = "000102030405060708090a0b0c0d0e0f";
const VEC_PLAINTEXT = "hello easy git\n";
const VEC_ENV_HEX =
  "4547453101000102030405060708090a0b0c0d0e0f79d7e0969c657bca23a71963702a821a" +
  "e5f50f330786747dff474caba3ce2c9c2e03a6350ea80fb7af0e79";
const VEC_ENV_BLOB_SHA = "90f12f3a70102223a4856061eb45b0c03e6c0eb0";
const VEC_EMPTY_ENV_HEX =
  "4547453101000102030405060708090a0b0c0d0e0fa5742370699d078be83271aa81adceff" +
  "3dfe203710d2a4bd54e7fa6d";
const VEC_VERIFIER_B64 =
  "RUdFMQEAAQIDBAUGBwgJCgsMDQ4Pb6IERXu1/O419Q6Kj42uAvwH0uA1AmbiQxuYOUJcqzz6wcJ2o6qkf09a9lfXl43u";
const VEC_KEK_HEX = "a934bd572086d424cd71cd3eb676a6601a422eeea18ca4b633c645446e04ab13";

async function vectorKeys(): Promise<ContentKeys> {
  return deriveContentKeys(VEC_MASTER_KEY, VEC_KEY_ID);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("pinned format vectors", () => {
  test("envelope bytes for a known key and plaintext", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, encode(VEC_PLAINTEXT));
    expect(bytesToHex(env)).toBe(VEC_ENV_HEX);
  });

  test("git blob SHA of the envelope, as the sync engine computes it", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, encode(VEC_PLAINTEXT));
    expect(await computeGitBlobShaFromBytes(env)).toBe(VEC_ENV_BLOB_SHA);
  });

  test("empty plaintext envelope", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, new Uint8Array(0));
    expect(bytesToHex(env)).toBe(VEC_EMPTY_ENV_HEX);
  });

  test("verifier bytes", async () => {
    const keys = await vectorKeys();
    expect(bytesToBase64(await makeVerifier(keys))).toBe(VEC_VERIFIER_B64);
  });

  test("PBKDF2 KEK derivation", async () => {
    const salt = new Uint8Array(16).fill(0xaa);
    const kek = await deriveKekBits("correct horse battery", salt, 1000);
    expect(bytesToHex(kek)).toBe(VEC_KEK_HEX);
  });

  test("pinned envelope still decrypts", async () => {
    const keys = await vectorKeys();
    const plain = await decryptContent(keys, hexToBytes(VEC_ENV_HEX));
    expect(new TextDecoder().decode(plain)).toBe(VEC_PLAINTEXT);
  });
});

describe("round trips", () => {
  test("text, binary, empty, and megabyte-sized content", async () => {
    const keys = await vectorKeys();
    const big = new Uint8Array(1_048_576).map((_, i) => (i * 31 + 7) % 256);
    const cases = [
      encode("plain note with unicode: äöü 東京 🎉\n"),
      new Uint8Array([0, 255, 128, 1, 254, 0, 0, 7]),
      new Uint8Array(0),
      big,
    ];
    for (const plaintext of cases) {
      const env = await encryptContent(keys, plaintext);
      expect(hasEnvelopeMagic(env)).toBe(true);
      const back = await decryptContent(keys, env);
      expect(bytesToHex(back)).toBe(bytesToHex(plaintext));
    }
  });
});

describe("determinism", () => {
  test("same plaintext and key give byte-identical envelopes", async () => {
    const keys = await vectorKeys();
    const a = await encryptContent(keys, encode("stable content"));
    const b = await encryptContent(keys, encode("stable content"));
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  test("one flipped plaintext bit changes the IV, not just the ciphertext", async () => {
    const keys = await vectorKeys();
    const a = await encryptContent(keys, encode("stable content"));
    const b = await encryptContent(keys, encode("stable_content"));
    const ivA = bytesToHex(a.slice(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + IV_BYTES));
    const ivB = bytesToHex(b.slice(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + IV_BYTES));
    expect(ivA).not.toBe(ivB);
  });

  test("different master keys give different envelopes for the same plaintext", async () => {
    const keysA = await vectorKeys();
    const otherMk = new Uint8Array(32).map((_, i) => 255 - i);
    const keysB = await deriveContentKeys(otherMk, VEC_KEY_ID);
    const a = await encryptContent(keysA, encode("same"));
    const b = await encryptContent(keysB, encode("same"));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

describe("tampering and wrong keys", () => {
  test("every flipped ciphertext or IV byte fails authentication", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, encode("integrity matters"));
    // Flip one byte in each region past the key id (a key-id flip is a
    // different error, tested below): IV and ciphertext+tag.
    for (const offset of [ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + IV_BYTES, env.byteLength - 1]) {
      const tampered = env.slice();
      tampered[offset] ^= 0x01;
      await expect(decryptContent(keys, tampered)).rejects.toBeInstanceOf(DecryptFailedError);
    }
  });

  test("a flipped key-id byte reports a key mismatch, not corruption", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, encode("hello"));
    const tampered = env.slice();
    tampered[5] ^= 0x01;
    await expect(decryptContent(keys, tampered)).rejects.toBeInstanceOf(WrongKeyIdError);
  });

  test("truncated envelopes fail as format errors", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, encode("hello"));
    await expect(decryptContent(keys, env.slice(0, 40))).rejects.toBeInstanceOf(CryptoFormatError);
    expect(() => decodeEnvelope(env.slice(0, 40))).toThrow(CryptoFormatError);
  });

  test("unknown version byte is rejected with an update hint", async () => {
    const keys = await vectorKeys();
    const env = await encryptContent(keys, encode("hello"));
    const future = env.slice();
    future[4] = 9;
    expect(() => decodeEnvelope(future)).toThrow(/version 9/);
  });

  test("same key id but different master key fails authentication", async () => {
    const keys = await vectorKeys();
    const impostor = await deriveContentKeys(generateMasterKey(), VEC_KEY_ID);
    const env = await encryptContent(keys, encode("hello"));
    await expect(decryptContent(impostor, env)).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test("plaintext is never mistaken for an envelope", () => {
    expect(hasEnvelopeMagic(encode("# My note\n"))).toBe(false);
    expect(hasEnvelopeMagic(new Uint8Array(0))).toBe(false);
    expect(hasEnvelopeMagic(encode("EGE"))).toBe(false);
  });
});

describe("verifier", () => {
  test("accepts the right key and rejects a wrong one", async () => {
    const keys = await vectorKeys();
    const verifier = await makeVerifier(keys);
    expect(await checkVerifier(keys, verifier)).toBe(true);
    const wrong = await deriveContentKeys(generateMasterKey(), VEC_KEY_ID);
    expect(await checkVerifier(wrong, verifier)).toBe(false);
  });
});

describe("provisioning and unlock", () => {
  // Small iteration count: these tests exercise the flow, not PBKDF2 cost.
  const ITER = 1000;

  test("provision then unlock with the passphrase on a 'second device'", async () => {
    const first = await provisionEncryption("open sesame please", ITER);
    const env = await encryptContent(first.keys, encode("note body"));

    const second = await unlockWithPassphrase(first.meta, "open sesame please");
    const plain = await decryptContent(second.keys, env);
    expect(new TextDecoder().decode(plain)).toBe("note body");
    expect(bytesToHex(second.masterKey)).toBe(bytesToHex(first.masterKey));
  });

  test("wrong passphrase is rejected", async () => {
    const first = await provisionEncryption("open sesame please", ITER);
    await expect(
      unlockWithPassphrase(first.meta, "open sesame pleas"),
    ).rejects.toBeInstanceOf(UnwrapFailedError);
  });

  test("recovery key unlocks; a wrong one is rejected", async () => {
    const first = await provisionEncryption("open sesame please", ITER);
    const recovery = bytesToBase64(first.masterKey);
    const unlocked = await unlockWithRecoveryKey(first.meta, `  ${recovery}\n`);
    expect(bytesToHex(unlocked.masterKey)).toBe(bytesToHex(first.masterKey));
    await expect(
      unlockWithRecoveryKey(first.meta, bytesToBase64(generateMasterKey())),
    ).rejects.toBeInstanceOf(UnwrapFailedError);
  });

  test("passphrase change re-wraps without touching content keys", async () => {
    const first = await provisionEncryption("old passphrase!", ITER);
    const env = await encryptContent(first.keys, encode("survives rewrap"));

    const newMeta = await rewrapWithNewPassphrase(first, first.meta, "new passphrase!", ITER);
    expect(newMeta.keyId).toBe(first.meta.keyId);
    expect(newMeta.wrappedKey).not.toBe(first.meta.wrappedKey);

    await expect(
      unlockWithPassphrase(newMeta, "old passphrase!"),
    ).rejects.toBeInstanceOf(UnwrapFailedError);
    const reopened = await unlockWithPassphrase(newMeta, "new passphrase!");
    const plain = await decryptContent(reopened.keys, env);
    expect(new TextDecoder().decode(plain)).toBe("survives rewrap");
  });

  test("generated key ids are well-formed and unique", () => {
    const a = generateKeyId();
    const b = generateKeyId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("metadata file", () => {
  const ITER = 1000;

  test("serialize/parse round trip", async () => {
    const { meta } = await provisionEncryption("roundtrip", ITER);
    const parsed = parseMetadata(serializeMetadata(meta));
    expect(parsed).toEqual(meta);
  });

  test("malformed inputs produce user-showable errors", () => {
    expect(() => parseMetadata("not json")).toThrow(/not valid JSON/);
    expect(() => parseMetadata(`{"version":2}`)).toThrow(/version 2/);
    expect(() =>
      parseMetadata(
        `{"version":1,"keyId":"nope","kdf":{"algo":"a","iterations":1,"salt":"s"},"wrappedKey":"w","verifier":"v"}`,
      ),
    ).toThrow(/key id/);
    expect(() =>
      parseMetadata(
        `{"version":1,"keyId":"000102030405060708090a0b0c0d0e0f","kdf":{"algo":"a","iterations":0,"salt":"s"},"wrappedKey":"w","verifier":"v"}`,
      ),
    ).toThrow(/KDF/);
  });

  test("unsupported KDF algo is rejected at unlock, not at parse", async () => {
    const { meta } = await provisionEncryption("kdf agility", ITER);
    const future = { ...meta, kdf: { ...meta.kdf, algo: "Argon2id" } };
    const parsed = parseMetadata(serializeMetadata(future));
    await expect(unlockWithPassphrase(parsed, "kdf agility")).rejects.toThrow(/Argon2id/);
  });
});

describe("base64 helpers", () => {
  test("bytesToBase64 respects subarray bounds", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 5);
    expect(Array.from(base64ToBytes(bytesToBase64(view)))).toEqual([3, 4, 5]);
  });
});
