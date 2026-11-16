/**
 * The encryption lifecycle behind the dialogs (turn on, unlock, turn off,
 * state), with the real keychain over an in-memory secret store. The same
 * functions run against GitHub in tests/e2e/encryption-github.e2e.ts.
 */

import { describe, expect, test } from "vitest";
import type { App } from "obsidian";
import { EncryptionKeychain } from "../src/crypto/keychain";
import {
  LifecycleContext,
  disableEncryption,
  enableEncryption,
  encryptionState,
  unlockDestination,
} from "../src/crypto/lifecycle";
import { base64ToBytes } from "../src/sync/blob-sha";
import { DEFAULT_SETTINGS, MappingDestination, PluginSettings } from "../src/types";

// Low PBKDF2 cost: these tests exercise the flow, not the KDF.
const ITER = 1000;

function device(opts: { keystore?: boolean } = {}) {
  const secrets = new Map<string, string>();
  const settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  const app = (
    opts.keystore === false
      ? {}
      : {
          secretStorage: {
            getSecret: (id: string) => secrets.get(id) ?? null,
            setSecret: (id: string, v: string) => void secrets.set(id, v),
          },
        }
  ) as unknown as App;
  let saves = 0;
  const keychain = new EncryptionKeychain(app, () => settings, async () => {});
  const ctx: LifecycleContext = {
    keychain,
    settings,
    save: async () => {
      saves += 1;
    },
  };
  const dest: MappingDestination = {
    id: "d",
    repoOwner: "o",
    repoName: "r",
    branch: "main",
    remoteFolder: "",
  };
  return { ctx, keychain, settings, dest, secrets, saves: () => saves };
}

describe("encryption lifecycle", () => {
  test("a new destination is off", () => {
    const d = device();
    expect(encryptionState(d.dest, d.keychain)).toBe("off");
  });

  test("turning on stores the key, saves, and returns a 32-byte recovery key", async () => {
    const d = device();
    const recovery = await enableEncryption(d.ctx, d.dest, "a long passphrase", ITER);
    expect(base64ToBytes(recovery).byteLength).toBe(32);
    expect(encryptionState(d.dest, d.keychain)).toBe("on");
    expect(d.dest.encryption?.metaUploaded).toBeUndefined();
    expect(d.settings.encryptionMeta?.[d.dest.encryption!.keyId]).toBeDefined();
    expect(d.secrets.get(`easy-git-key-${d.dest.encryption!.keyId}`)).toBe(recovery);
    expect(d.saves()).toBe(1);
  });

  test("without a system keychain the key lands in data.json, and the UI is told", async () => {
    const d = device({ keystore: false });
    expect(d.keychain.usesFallbackStorage()).toBe(true);
    await enableEncryption(d.ctx, d.dest, "a long passphrase", ITER);
    expect(d.settings.encryptionKeys?.[d.dest.encryption!.keyId]).toBeDefined();
  });

  test("a second device is locked until it unlocks with the passphrase", async () => {
    const a = device();
    await enableEncryption(a.ctx, a.dest, "a long passphrase", ITER);
    const meta = a.settings.encryptionMeta![a.dest.encryption!.keyId];

    const b = device();
    b.dest.encryption = { keyId: meta.keyId, metaUploaded: true };
    expect(encryptionState(b.dest, b.keychain)).toBe("locked");

    await expect(
      unlockDestination(b.ctx, b.dest, meta, "wrong", false, true),
    ).rejects.toThrow(/Wrong passphrase/);
    expect(encryptionState(b.dest, b.keychain)).toBe("locked");

    await unlockDestination(b.ctx, b.dest, meta, "a long passphrase", false, true);
    expect(encryptionState(b.dest, b.keychain)).toBe("on");
    expect(b.dest.encryption?.metaUploaded).toBe(true);
  });

  test("the recovery key unlocks too", async () => {
    const a = device();
    const recovery = await enableEncryption(a.ctx, a.dest, "a long passphrase", ITER);
    const meta = a.settings.encryptionMeta![a.dest.encryption!.keyId];
    const b = device();
    await unlockDestination(b.ctx, b.dest, meta, recovery, true, true);
    expect(encryptionState(b.dest, b.keychain)).toBe("on");
  });

  test("unlocking from this device's own copy keeps the pending upload", async () => {
    const a = device();
    await enableEncryption(a.ctx, a.dest, "a long passphrase", ITER);
    const meta = a.settings.encryptionMeta![a.dest.encryption!.keyId];
    await a.keychain.forget(meta.keyId);
    await unlockDestination(a.ctx, a.dest, meta, "a long passphrase", false, false);
    expect(a.dest.encryption?.metaUploaded).toBeUndefined();
  });

  test("turning off marks the remote metadata for removal and keeps the key", async () => {
    const d = device();
    await enableEncryption(d.ctx, d.dest, "a long passphrase", ITER);
    const keyId = d.dest.encryption!.keyId;
    disableEncryption(d.dest);
    expect(encryptionState(d.dest, d.keychain)).toBe("off");
    expect(d.dest.pendingCryptoMetaRemoval).toBe(true);
    expect(d.keychain.hasKey(keyId)).toBe(true);
  });

  test("turning on again cancels a pending removal", async () => {
    const d = device();
    d.dest.pendingCryptoMetaRemoval = true;
    await enableEncryption(d.ctx, d.dest, "a long passphrase", ITER);
    expect(d.dest.pendingCryptoMetaRemoval).toBeUndefined();
  });
});
