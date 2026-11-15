import { expect, open, test } from "nsh/test";
import { deviceToolFooter, deviceToolRows, deviceToolTrigger, deviceToolVersion, readDeviceToolVersions } from "./DeviceToolVersions";

const tools = { hub: { runningVersion: null, requiredVersion: "0.12.0", installedVersions: ["0.9.0", "0.12.0"] }, agent: { runningVersion: "1.4.2", requiredVersion: "1.4.0", installedVersions: [] } };

test("the version is the running one, else the required one when installed, else the highest installed", () => {
  expect(deviceToolVersion({ runningVersion: "2.0.0", requiredVersion: "1.0.0", installedVersions: [] })).toBe("2.0.0");
  expect(deviceToolVersion({ requiredVersion: "0.12.0", installedVersions: ["0.9.0", "0.12.0"] })).toBe("0.12.0");
  expect(deviceToolVersion({ requiredVersion: "0.13.0", installedVersions: ["0.9.0", "0.10.0"] })).toBe("0.10.0");
  expect(deviceToolVersion({ requiredVersion: "0.13.0", installedVersions: [] })).toBeUndefined();
});

test("trigger text and label follow DeviceToolVersions", () => {
  expect(deviceToolTrigger(tools, "hub")).toEqual({ text: "v0.12.0", label: "Device hub: version 0.12.0. Show details" });
  expect(deviceToolTrigger({ ...tools, agent: { requiredVersion: "1", installedVersions: [] } }, "agent")).toEqual({ text: "Not installed", label: "Agent device: not installed. Show details" });
  expect(deviceToolTrigger(undefined, "hub")).toEqual({ text: "Version unknown", label: "Device hub: version unknown. Show details" });
  expect(deviceToolTrigger(undefined, undefined).text).toBe("Versions");
  expect(deviceToolTrigger(undefined, undefined, "boom").text).toBe("Versions unavailable");
});

test("rows are Running / Required / Installed with Not running and None", () => {
  expect(deviceToolRows(tools)).toEqual([["Device hub", "Not running", "0.12.0", "0.9.0, 0.12.0"], ["Agent device", "1.4.2", "1.4.0", "None"]]);
  expect(deviceToolRows(tools, "agent")).toEqual([["Agent device", "1.4.2", "1.4.0", "None"]]);
  expect(deviceToolFooter("Acme IT")).toBe("Managed by Acme IT. Tools update automatically on this host when needed.");
  expect(readDeviceToolVersions({ hub: { requiredVersion: "1", installedVersions: ["1"] } })).toBeUndefined();
  expect(readDeviceToolVersions(tools)?.hub.requiredVersion).toBe("0.12.0");
});

test("the popover shows the table, and before a check says versions have not been checked", async () => {
  const app = await open("./DeviceToolVersionsFixture.tsx", { width: 600, height: 500, platform: "macos" });
  await app.waitFor("label:Device hub: version 0.12.0. Show details");
  await app.press("label:Device hub: version 0.12.0. Show details");
  await app.waitFor("text:Running");
  await expect(app.shows("text:Not running")).toBe(true);
  await expect(app.shows("text:0.9.0, 0.12.0")).toBe(true);
  await expect(app.shows("text:Managed by Acme IT. Tools update automatically on this host when needed.")).toBe(true);
  await app.press("label:Agent device: version unknown. Show details");
  await app.waitFor("text:Versions have not been checked.");
});
