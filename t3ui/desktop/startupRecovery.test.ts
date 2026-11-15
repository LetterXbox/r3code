import { expect, test } from "nsh/test";
import { configureDesktop } from "./runtime";
import {
  lastStartedVersion,
  recordStartedVersion,
  resolveStartupRecoveryOffer,
  startupRecoveryOffer,
  presentStartupRecovery,
  clearStartupRecovery,
  resetStartupRecoveryForTest,
  STARTUP_RECOVERY_RELEASES_URL,
} from "./startupRecovery";

test("a managed-policy failure always wins, even over a version mismatch", () => {
  expect(resolveStartupRecoveryOffer({ managedPolicyError: "it is not valid JSON", lastStartedVersion: "1.0.0", currentVersion: "1.1.0" }))
    .toEqual({ kind: "managed-policy", message: "it is not valid JSON" });
});

test("a different build that last started here offers Reinstall", () => {
  expect(resolveStartupRecoveryOffer({ managedPolicyError: null, lastStartedVersion: "1.0.0", currentVersion: "1.1.0" }))
    .toEqual({ kind: "reinstall", version: "1.0.0" });
});

test("no managed policy error and no prior build (or the same one) offers Releases", () => {
  expect(resolveStartupRecoveryOffer({ managedPolicyError: null, lastStartedVersion: null, currentVersion: "1.1.0" })).toEqual({ kind: "releases" });
  expect(resolveStartupRecoveryOffer({ managedPolicyError: null, lastStartedVersion: "1.1.0", currentVersion: "1.1.0" })).toEqual({ kind: "releases" });
});

test("STARTUP_RECOVERY_RELEASES_URL points at the project's own releases page", () => {
  expect(STARTUP_RECOVERY_RELEASES_URL).toBe("https://github.com/pingdotgg/t3code/releases");
});

test("present/clear drive the signal other code (the screen, the coordinators) reads", () => {
  resetStartupRecoveryForTest();
  expect(startupRecoveryOffer()).toBeNull();
  presentStartupRecovery({ kind: "releases" });
  expect(startupRecoveryOffer()).toEqual({ kind: "releases" });
  clearStartupRecovery();
  expect(startupRecoveryOffer()).toBeNull();
});

test("the last-started version round-trips through storage, and is null before anything recorded it", async () => {
  const store = new Map<string, string>();
  configureDesktop({ getItem: async (key) => store.get(key) ?? null, setItem: async (key, value) => { store.set(key, value); } });
  expect(await lastStartedVersion()).toBeNull();
  await recordStartedVersion("1.2.3");
  expect(await lastStartedVersion()).toBe("1.2.3");
});
