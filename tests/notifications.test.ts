/**
 * Pins issue #12: an "Errors only" notification level, so failed syncs are
 * never silent while success notices stay out of the way (on mobile with
 * sync-on-save in particular).
 */

import { describe, expect, test } from "vitest";
import {
  FailureNotifier,
  notificationLevel,
  notifyInfo,
} from "../src/notifications";

describe("notificationLevel", () => {
  test("settings from before levels keep their notices exactly", () => {
    expect(notificationLevel({ showNotifications: true })).toBe("all");
    expect(notificationLevel({ showNotifications: false })).toBe("off");
  });

  test("an explicit level wins over the legacy switch", () => {
    expect(
      notificationLevel({ showNotifications: true, notificationLevel: "errors" }),
    ).toBe("errors");
  });

  test("a hand-edited level falls back to the legacy switch", () => {
    const s = { showNotifications: false, notificationLevel: "loud" } as unknown as Parameters<
      typeof notificationLevel
    >[0];
    expect(notificationLevel(s)).toBe("off");
  });

  test("success notices show only at 'all'", () => {
    expect(notifyInfo({ showNotifications: true, notificationLevel: "all" })).toBe(true);
    expect(notifyInfo({ showNotifications: true, notificationLevel: "errors" })).toBe(false);
    expect(notifyInfo({ showNotifications: false, notificationLevel: "off" })).toBe(false);
  });
});

describe("FailureNotifier", () => {
  const EXPIRED = "Invalid or expired token. Please sign in again.";

  test("'all' announces every failure, repeats included, as before", () => {
    const n = new FailureNotifier();
    expect(n.shouldNotify("all", "d1", EXPIRED, false)).toBe(true);
    expect(n.shouldNotify("all", "d1", EXPIRED, false)).toBe(true);
  });

  test("'off' never announces", () => {
    const n = new FailureNotifier();
    expect(n.shouldNotify("off", "d1", EXPIRED, true)).toBe(false);
    expect(n.shouldNotify("off", "d1", EXPIRED, false)).toBe(false);
  });

  test("'errors' announces the first failure of an automatic sync", () => {
    const n = new FailureNotifier();
    expect(n.shouldNotify("errors", "d1", EXPIRED, false)).toBe(true);
  });

  test("'errors' stays quiet on repeats while sync-on-save keeps failing", () => {
    const n = new FailureNotifier();
    n.shouldNotify("errors", "d1", EXPIRED, false);
    expect(n.shouldNotify("errors", "d1", EXPIRED, false)).toBe(false);
    expect(n.shouldNotify("errors", "d1", EXPIRED, false)).toBe(false);
  });

  test("'errors' always answers an explicit sync", () => {
    const n = new FailureNotifier();
    n.shouldNotify("errors", "d1", EXPIRED, false);
    expect(n.shouldNotify("errors", "d1", EXPIRED, true)).toBe(true);
  });

  test("'errors' announces a different failure, and again after a success", () => {
    const n = new FailureNotifier();
    n.shouldNotify("errors", "d1", EXPIRED, false);
    expect(n.shouldNotify("errors", "d1", "Rate limited.", false)).toBe(true);
    expect(n.shouldNotify("errors", "d1", undefined, false)).toBe(false);
    expect(n.shouldNotify("errors", "d1", "Rate limited.", false)).toBe(true);
  });

  test("destinations are tracked separately", () => {
    const n = new FailureNotifier();
    n.shouldNotify("errors", "d1", EXPIRED, false);
    expect(n.shouldNotify("errors", "d2", EXPIRED, false)).toBe(true);
  });
});
