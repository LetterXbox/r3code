import { expect, open, test } from "nsh/test";
import { parseClientSettings } from "./providers/clientSettings";
import { loadPreferenceForWeight, summarizeLoadPreferences } from "./providers/LoadBalancingSettings";

const SIZE = { width: 900, height: 600 };
const envs = [{ environmentId: "a", label: "Mac" }, { environmentId: "b", label: "Box" }];

test("weights map to the four preferences and the summary names only the non-default machines", () => {
  expect(loadPreferenceForWeight(undefined)).toBe(50);
  expect(loadPreferenceForWeight(50)).toBe(50);
  expect(loadPreferenceForWeight(0)).toBe(0);
  expect(loadPreferenceForWeight(10)).toBe(25);
  expect(loadPreferenceForWeight(75)).toBe(100);
  expect(summarizeLoadPreferences(envs, {})).toBeNull();
  expect(summarizeLoadPreferences(envs, { a: 100, b: 0 })).toBe("Mac prefer · Box manual only");
  expect(summarizeLoadPreferences(envs, { b: 25 })).toBe("Box less often");
});

test("stored client settings keep only the schema's weights", () => {
  expect(parseClientSettings(null)).toEqual({ loadBalancingEnabled: false, loadBalancingWeights: {} });
  expect(parseClientSettings("nope")).toEqual({ loadBalancingEnabled: false, loadBalancingWeights: {} });
  expect(parseClientSettings(JSON.stringify({ loadBalancingEnabled: true, loadBalancingWeights: { a: 25, b: 101, c: 1.5, " ": 5, d: "x" } }))).toEqual({ loadBalancingEnabled: true, loadBalancingWeights: { a: 25 } });
});

test("the section folds, starts Off, switches on and sets a machine's preference", async () => {
  const app = await open("./LoadBalancingFixture.tsx", SIZE);
  await expect(app.texts()).toContain("Load balancing");
  await expect(app.texts()).toContain("Off");
  await expect(app.texts().includes("This machine")).toBe(false);
  await app.press("label:Expand Load balancing");
  await expect(app.texts()).toContain("New threads in shared projects start on the machine with the most free CPU and memory, weighted by each machine's preference.");
  await expect(app.texts()).toContain("This Mac");
  await expect(app.texts()).toContain("SSH build@box");
  await app.press("label:Automatically balance load");
  await expect(app.shows("id:Automatically balance load on")).toBe(true);
  await app.press("label:Build box load preference");
  await app.press("text:Manual only");
  await expect(app.texts()).toContain("Build box manual only");
  await expect(app.texts().some((text) => text.includes('"loadBalancingEnabled":true') && text.includes('"env-b":0'))).toBe(true);
});

test("one environment shows nothing", async () => {
  const app = await open("./LoadBalancingFixture.tsx", SIZE);
  await app.press("label:One environment");
  await expect(app.texts().includes("Load balancing")).toBe(false);
});
