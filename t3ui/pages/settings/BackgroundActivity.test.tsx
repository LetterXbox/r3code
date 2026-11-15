import { expect, open, test } from "nsh/test";
import { overridePatch, profileOption, profilePatch, readBackgroundActivity, resolveBackgroundActivity, sharedPolicyPatch } from "./backgroundActivity";
import { normalizeIntervalSeconds } from "./BackgroundActivityControl";

const custom = { backgroundActivity: { schemaVersion: 1, profile: "custom", baseProfile: "performance", overrides: { automaticGitFetchInterval: 45_000, pauseWhenOnBattery: true } } };

test("the policy resolves a profile and its overrides, and says Advanced only for a real custom policy", () => {
  expect(resolveBackgroundActivity({}).automaticGitFetchInterval).toBe(30_000);
  expect(resolveBackgroundActivity({ backgroundActivityProfile: "battery-saver" }).pauseWhenOnBattery).toBe(true);
  expect(resolveBackgroundActivity(custom)).toMatchObject({ profile: "performance", automaticGitFetchInterval: 45_000, providerHealthRefreshInterval: 60_000, pauseWhenOnBattery: true });
  expect(profileOption({})).toBe("balanced");
  expect(profileOption(custom)).toBe("advanced");
  // A custom policy equal to a preset is that preset.
  expect(profileOption({ backgroundActivity: { schemaVersion: 1, profile: "custom", baseProfile: "balanced", overrides: { automaticGitFetchInterval: 30_000 } } })).toBe("balanced");
  expect(readBackgroundActivity({ backgroundActivity: { profile: "performance" } })).toMatchObject({ profile: "performance", overrides: {} });
});

test("the patches pick a profile, change the shared policy and keep only the overrides that differ", () => {
  expect(profilePatch("performance")).toEqual({ backgroundActivity: { schemaVersion: 1, profile: "performance", overrides: {} } });
  expect(sharedPolicyPatch(custom, "balanced")).toEqual({ backgroundActivity: { schemaVersion: 1, profile: "custom", baseProfile: "balanced", overrides: custom.backgroundActivity.overrides } });
  expect(overridePatch({}, { automaticGitFetchInterval: 60_000 })).toEqual({ backgroundActivity: { schemaVersion: 1, profile: "custom", baseProfile: "balanced", overrides: { automaticGitFetchInterval: 60_000 } } });
  expect(overridePatch({}, { automaticGitFetchInterval: 30_000 })).toEqual({ backgroundActivity: { schemaVersion: 1, profile: "balanced", overrides: {} } });
  expect(normalizeIntervalSeconds(2.6, 5)).toBe(5);
  expect(normalizeIntervalSeconds(7.4, 5)).toBe(7);
});

test("Maintenance picks a profile and tunes the intervals in a dialog", async () => {
  const app = await open("./MaintenanceFixture.tsx", { width: 1100, height: 3000 });
  await expect(app.texts()).toContain("Pauses probes for idle clients, locked hosts, or low power mode.");
  await app.press("label:Background activity profile = balanced");
  await app.press("label:Advanced");
  await expect(app.texts()).toContain("Tune the shared power policy and the background intervals that feed it.");
  await app.press("label:Increase Git fetch interval");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"backgroundActivity":{"schemaVersion":1,"profile":"custom","baseProfile":"balanced","overrides":{"automaticGitFetchInterval":35000}}}}`);
  await expect(app.texts()).toContain("Uses custom intervals. Shared policy: Balanced.");
  await expect(app.shows("label:Background policy details")).toBe(true);
  await expect(app.shows("label:Configure advanced background activity")).toBe(true);
});
