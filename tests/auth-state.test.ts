/**
 * Pins the issue #13 fix. The token lives in the per-device keystore while
 * `method` lives in data.json, which travels between devices. Older code
 * reset `method` to "none" on any device without the token, and that
 * shared file then signed out devices whose keystore still had one. These
 * tests drive the real load/save rules against an in-memory keystore.
 */

import { describe, expect, test } from "vitest";
import type { App } from "obsidian";
import {
  TokenStore,
  authForDisk,
  authProblem,
  hydrateAuth,
  inferAuthMethod,
  isSignedIn,
} from "../src/auth-state";
import { describeAuth } from "../src/github/auth";
import { SyncEngine } from "../src/sync/engine";
import { DEFAULT_SETTINGS, FolderMapping, GitHubAuth } from "../src/types";

const FORGEJO_TOKEN = "0123456789abcdef0123456789abcdef01234567";

interface FakeKeystore {
  store: TokenStore;
  value(): string | null;
  writes: string[];
  setReadable(readable: boolean): void;
}

function keystore(
  initial: string | null,
  opts: { available?: boolean; readable?: boolean; writable?: boolean } = {},
): FakeKeystore {
  let value = initial;
  let readable = opts.readable ?? true;
  const writes: string[] = [];
  return {
    store: {
      available: opts.available ?? true,
      read: () => (readable ? value : null),
      write: (token) => {
        if (opts.writable === false) return false;
        writes.push(token);
        value = token;
        return true;
      },
    },
    value: () => value,
    writes,
    setReadable: (r) => {
      readable = r;
    },
  };
}

describe("issue #13: shared data.json says signed out, keystore has the token", () => {
  test("the reporter's exact data.json: Forgejo, method none, token in the keychain", () => {
    const auth: GitHubAuth = {
      method: "none",
      token: "",
      provider: "forgejo",
      instanceUrl: "https://git.example.org",
    };
    const ks = keystore(FORGEJO_TOKEN);

    expect(hydrateAuth(auth, ks.store)).toBe(true);
    expect(auth.token).toBe(FORGEJO_TOKEN);
    expect(auth.method).toBe("pat");
    expect(isSignedIn(auth)).toBe(true);
    expect(authProblem(auth)).toBeNull();
    expect(describeAuth(auth)).toBe("Signed in via PAT");
  });

  test("a GitHub device-flow token comes back as an OAuth sign-in", () => {
    const auth: GitHubAuth = { method: "none", token: "", provider: "github" };
    hydrateAuth(auth, keystore("gho_abc123").store);
    expect(auth.method).toBe("oauth");
    expect(describeAuth(auth)).toBe("Signed in via GitHub");
  });

  test("the repaired data.json carries no token", () => {
    const auth: GitHubAuth = { method: "none", token: "", provider: "github" };
    const ks = keystore("ghp_abc");
    hydrateAuth(auth, ks.store);
    const onDisk = authForDisk(auth, ks.store);
    expect(onDisk.token).toBe("");
    expect(onDisk.method).toBe("pat");
    expect(auth.token).toBe("ghp_abc");
  });
});

describe("a device without the token", () => {
  test("leaves the shared method alone, so it cannot sign out other devices", () => {
    const auth: GitHubAuth = {
      method: "pat",
      token: "",
      username: "alice",
      provider: "github",
    };
    expect(hydrateAuth(auth, keystore(null).store)).toBe(false);
    expect(auth.method).toBe("pat");
    expect(auth.username).toBe("alice");
  });

  test("says why it cannot sync, in the sync error and the settings status", () => {
    const auth: GitHubAuth = { method: "pat", token: "", provider: "github" };
    hydrateAuth(auth, keystore(null).store);
    expect(isSignedIn(auth)).toBe(false);
    expect(authProblem(auth)).toMatch(/on this device/);
    expect(describeAuth(auth)).toBe(
      "Not signed in on this device (tokens are stored per device)",
    );
  });

  test("a device that never signed in anywhere keeps the plain message", () => {
    const auth: GitHubAuth = { method: "none", token: "", provider: "github" };
    hydrateAuth(auth, keystore(null).store);
    expect(authProblem(auth)).toBe("Not signed in. Configure auth in settings.");
    expect(describeAuth(auth)).toBe("Not signed in");
  });
});

describe("the keystore is only blanked by an explicit sign-out", () => {
  test("an unreadable keystore at load does not wipe the stored token on save", () => {
    const ks = keystore("ghp_real", { readable: false });
    const auth: GitHubAuth = { method: "pat", token: "", provider: "github" };
    hydrateAuth(auth, ks.store);
    expect(auth.token).toBe("");

    // Any settings change saves while the in-memory token is empty.
    authForDisk(auth, ks.store);
    expect(ks.writes).toEqual([]);
    expect(ks.value()).toBe("ghp_real");

    // Next load, keystore readable again: still signed in.
    ks.setReadable(true);
    const next: GitHubAuth = { method: "pat", token: "", provider: "github" };
    hydrateAuth(next, ks.store);
    expect(isSignedIn(next)).toBe(true);
  });
});

describe("unchanged behavior", () => {
  test("a plaintext token from an older version moves into the keystore", () => {
    const ks = keystore(null);
    const auth: GitHubAuth = { method: "pat", token: "ghp_legacy", provider: "github" };
    expect(hydrateAuth(auth, ks.store)).toBe(true);
    expect(ks.value()).toBe("ghp_legacy");
    expect(authForDisk(auth, ks.store).token).toBe("");
  });

  test("a locked keystore keeps the token in data.json rather than lose it", () => {
    const ks = keystore(null, { writable: false });
    const auth: GitHubAuth = { method: "pat", token: "ghp_legacy", provider: "github" };
    expect(hydrateAuth(auth, ks.store)).toBe(false);
    expect(authForDisk(auth, ks.store).token).toBe("ghp_legacy");
  });

  test("without a keystore, a method without a token is still a half-cleared sign-out", () => {
    const auth: GitHubAuth = { method: "pat", token: "", username: "bob", provider: "github" };
    expect(hydrateAuth(auth, keystore(null, { available: false }).store)).toBe(true);
    expect(auth.method).toBe("none");
    expect(auth.username).toBeUndefined();
  });

  test("without a keystore, the token stays in data.json", () => {
    const ks = keystore(null, { available: false });
    const auth: GitHubAuth = { method: "pat", token: "ghp_x", provider: "github" };
    expect(hydrateAuth(auth, ks.store)).toBe(false);
    expect(authForDisk(auth, ks.store)).toBe(auth);
  });

  test("Forgejo without an instance URL is still refused", () => {
    const auth: GitHubAuth = { method: "pat", token: FORGEJO_TOKEN, provider: "forgejo" };
    expect(authProblem(auth)).toMatch(/Instance URL/);
  });
});

describe("method inference", () => {
  test.each([
    ["gho_abc", "github", "oauth"],
    ["ghu_abc", "github", "oauth"],
    ["ghp_abc", "github", "pat"],
    ["github_pat_abc", "github", "pat"],
    ["0123456789abcdef", "github", "pat"],
    ["gho_looks_like_github", "forgejo", "pat"],
  ] as const)("%s on %s is %s", (token, provider, method) => {
    expect(inferAuthMethod({ method: "none", token, provider })).toBe(method);
  });

  test("a hand-edited method value is normalized", () => {
    const withToken = { method: "bogus", token: "gho_x", provider: "github" } as unknown as GitHubAuth;
    hydrateAuth(withToken, keystore(null).store);
    expect(withToken.method).toBe("oauth");

    const withoutToken = { method: "bogus", token: "", provider: "github" } as unknown as GitHubAuth;
    hydrateAuth(withoutToken, keystore(null).store);
    expect(withoutToken.method).toBe("none");
  });
});

describe("sync engine gate", () => {
  function engineWith(auth: GitHubAuth): SyncEngine {
    return new SyncEngine({
      app: {} as App,
      settings: { ...DEFAULT_SETTINGS, auth },
      saveSettings: async () => {},
      resolveConflicts: async () => null,
    });
  }

  const mapping: FolderMapping = {
    id: "m",
    name: "Notes",
    vaultFolder: "Notes",
    direction: "both",
    autoMode: { kind: "off" },
    destinations: [
      { id: "d", repoOwner: "o", repoName: "r", branch: "main", remoteFolder: "" },
    ],
  };

  test("a token with method none is no longer refused as 'not signed in'", async () => {
    // Past the gate, the run reaches the network layer, which the obsidian
    // test mock refuses. That error proves the gate let the run through.
    const [result] = await engineWith({
      method: "none",
      token: "ghp_x",
      provider: "github",
    }).syncMapping(mapping);
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/Not signed in/);
    expect(result.error).toMatch(/requestUrl is not available in tests/);
  });

  test("no token on this device is refused with the per-device hint", async () => {
    const [result] = await engineWith({
      method: "pat",
      token: "",
      provider: "github",
    }).syncMapping(mapping);
    expect(result.error).toMatch(/Not signed in on this device/);
  });
});
