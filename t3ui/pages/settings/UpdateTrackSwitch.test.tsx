import { expect, open, test } from "nsh/test";
import { channelSwitchBlockReason, channelSwitchLabel, localUpdaterStaysPut, readNpmRelease, switchPlan, updateChannelOf } from "./updateTrackSwitch";

test("a switch across tracks needs the target to know every migration", () => {
  expect(updateChannelOf("1.2.3")).toBe("latest");
  expect(updateChannelOf("1.2.3-nightly.20261111")).toBe("nightly");
  expect(channelSwitchLabel("latest")).toBe("Stable");
  const release = { channel: "nightly" as const, version: "1.3.0-nightly.1", databaseMigration: 5 };
  expect(channelSwitchBlockReason("1.2.3", release, undefined)).toBe("its server predates database checks; update it on Stable first");
  expect(channelSwitchBlockReason("1.2.3", { ...release, databaseMigration: undefined }, 4)).toBe("1.3.0-nightly.1 predates database checks; wait for a newer Nightly release");
  expect(channelSwitchBlockReason("1.2.3", release, 6)).toContain("its database has changes 1.3.0-nightly.1 does not support yet");
  expect(channelSwitchBlockReason("1.2.3", release, 5)).toBe(null);
  expect(channelSwitchBlockReason("1.2.3-nightly.1", release, 99)).toBe(null);
  expect(localUpdaterStaysPut({ enabled: false }, "nightly")).toBe(true);
  expect(localUpdaterStaysPut({ enabled: false, channelBlockedByPolicy: true }, "latest")).toBe(false);
  expect(readNpmRelease("latest", { version: "1.2.4", databaseMigration: 7 })).toEqual({ channel: "latest", version: "1.2.4", databaseMigration: 7 });
  expect(readNpmRelease("latest", {})).toBe(null);
});

test("without an updater the plan is shown and the switch is refused, with the reason", () => {
  const release = { channel: "nightly" as const, version: "1.3.0-nightly.1", databaseMigration: 5 };
  const plan = switchPlan({ release, appVersion: "1.2.3", updater: null, databaseMigration: 5 });
  expect(plan.title).toBe("Switch to Nightly?");
  expect(plan.confirmLabel).toBe("Switch to Nightly");
  expect(plan.disabledReason).toBe("This build has no updater, so it cannot switch track.");
  expect(plan.notes[0]).toContain("has no updater");
  expect(switchPlan({ release, appVersion: "1.2.3", updater: { enabled: true }, databaseMigration: 5 }).disabledReason).toBe(null);
  expect(switchPlan({ release, appVersion: "1.2.3", updater: { enabled: false }, databaseMigration: 5 }).notes).toEqual(["This app's updates are off here, so reinstall it yourself to switch."]);
});

test("the dialog fetches the release and disables Switch where it cannot run", async () => {
  const app = await open("./UpdateTrackSwitchFixture.tsx", { width: 900, height: 800 });
  await app.wait(100);
  await expect(app.texts()).toContain("Switch to Nightly?");
  await expect(app.texts()).toContain("Version 1.3.0-nightly.1");
  await expect(app.texts()).toContain("This build has no updater, so it cannot switch track.");
  await expect(app.enabled("label:Switch to Nightly")).toBe(false);
  await expect(app.texts()).toContain("call server.getNpmRelease {\"spec\":\"nightly\"}");
});

test("a server without registry lookups says so and is never asked", async () => {
  const app = await open("./UpdateTrackSwitchUnsupportedFixture.tsx", { width: 900, height: 800 });
  await app.wait(100);
  await expect(app.texts()).toContain("Switch to Nightly");
  await expect(app.texts()).toContain("Could not check the configured npm registry: This server does not support registry lookups. Update it before switching tracks.");
  await expect(app.texts()).not.toContain("call server.getNpmRelease");
});

test("a registry failure shows the contract error's text and any other failure one generic line", async () => {
  const { npmReleaseFailureMessage, npmReleaseLookupBlock } = await import("./updateTrackSwitch");
  const { RequestFailure } = await import("../../backend/client");
  expect(npmReleaseFailureMessage(new RequestFailure("Could not check the configured npm registry: ENOTFOUND", "ServerNpmReleaseError"))).toBe("Could not check the configured npm registry: ENOTFOUND");
  expect(npmReleaseFailureMessage(new RequestFailure("Not allowed", "EnvironmentAuthorizationError"))).toBe("Could not check this environment's npm registry. Check the connection and registry settings.");
  expect(npmReleaseFailureMessage(new Error("socket closed"))).toBe("Could not check this environment's npm registry. Check the connection and registry settings.");
  expect(npmReleaseLookupBlock(null)).toBe("Connect to this server to check releases.");
  expect(npmReleaseLookupBlock({ capabilities: { npmReleaseLookup: true } })).toBeNull();
});

test("server.getNpmRelease is asked once within its 60 s stale time, again after it", async () => {
  const { readNpmReleaseCached } = await import("./UpdateTrackSwitchDialog");
  let calls = 0;
  const request = async () => { calls += 1; return { version: "1.0.0" }; };
  await readNpmReleaseCached("nightly-staletest", request, 1000);
  await readNpmReleaseCached("nightly-staletest", request, 30000);
  expect(calls).toBe(1);
  await readNpmReleaseCached("nightly-staletest", request, 62000);
  expect(calls).toBe(2);
});
