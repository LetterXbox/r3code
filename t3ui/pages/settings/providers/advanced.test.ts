import { expect, test } from "nsh/test";
import { defaultProviderHealthSeconds, normalizeIntervalSeconds, providerHealthPatch, providerHealthSeconds } from "./advanced";

test("the health interval defaults to the balanced five minutes and follows the profile", () => {
  expect(providerHealthSeconds({})).toBe(300);
  expect(providerHealthSeconds({ backgroundActivity: { profile: "performance", overrides: {} } })).toBe(60);
  expect(providerHealthSeconds({ backgroundActivity: { profile: "custom", baseProfile: "balanced", overrides: { providerHealthRefreshInterval: 90_000 } } })).toBe(90);
  expect(defaultProviderHealthSeconds({ backgroundActivity: { profile: "custom", baseProfile: "battery-saver", overrides: { providerHealthRefreshInterval: 90_000 } } })).toBe(900);
});

test("legacy top-level interval fields still resolve", () => {
  expect(providerHealthSeconds({ providerHealthRefreshInterval: 120_000 })).toBe(120);
});

test("providerHealthPatch pins every resolved value as a custom profile and can drop the override", () => {
  const patch = providerHealthPatch({}, 0) as { backgroundActivity: { profile: string; baseProfile: string; overrides: Record<string, unknown> } };
  expect(patch.backgroundActivity.profile).toBe("custom");
  expect(patch.backgroundActivity.baseProfile).toBe("balanced");
  expect(patch.backgroundActivity.overrides.providerHealthRefreshInterval).toBe(0);
  expect(patch.backgroundActivity.overrides.automaticGitFetchInterval).toBe(30_000);
  const reset = providerHealthPatch({}, undefined) as { backgroundActivity: { overrides: Record<string, unknown> } };
  expect("providerHealthRefreshInterval" in reset.backgroundActivity.overrides).toBe(false);
});

test("normalizeIntervalSeconds rounds and floors at the minimum", () => {
  expect(normalizeIntervalSeconds(-5, 0)).toBe(0);
  expect(normalizeIntervalSeconds(10.6, 0)).toBe(11);
  expect(normalizeIntervalSeconds(null, 0)).toBe(0);
});
