import { expect, test } from "nsh/test";
import {
  deviceHubReadiness, discoveryWarningText, emptyListMessage, groupDevices, hostDiagnostics, hostUpdateDetail, incompleteListings, loadingMessage, needsSetup,
  platformSetupStatus, readDeviceState, showsAndroidHint,
} from "./deviceLogic";

// A DeviceServiceState wire payload: EAS and Simlock hosts travel apart from `hosts`.
const wire = {
  hosts: [{ id: "local", label: "This machine", kind: "local", platforms: [{ platform: "ios", available: true }, { platform: "android", available: false, reason: "No Android SDK" }], hubInstalled: true, agentDeviceInstalled: false }],
  easHosts: [{ id: "eas1", label: "EAS", kind: "eas", platforms: [{ platform: "ios", available: true }], hubInstalled: true, agentDeviceInstalled: true }],
  simlockHosts: [{ id: "sim1", label: "Lab", kind: "simlock", platforms: [], hubInstalled: false, agentDeviceInstalled: false }],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready", detail: "adb timed out", incompletePlatforms: ["android"] }, eas1: { status: "failed", detail: "no token" } },
  devices: [
    { hostId: "local", id: "B", platform: "ios", name: "iPhone B", version: "17", booted: false, physical: false },
    { hostId: "local", id: "A", platform: "ios", name: "iPhone A", version: "17", booted: true, physical: false },
    { hostId: "local", id: "X", platform: "android", name: "Pixel", version: "14", booted: false, physical: false },
    { bad: true },
  ],
  sessions: [{ threadId: "t1", hostId: "local", deviceId: "A", platform: "ios", openedAt: "now" }],
  bootingDevices: [{ hostId: "local", id: "B", platform: "ios", name: "iPhone B", version: "17", booted: false, physical: false, threadId: "t1" }],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  supportsHostRetry: true,
  hubBasePath: "/api/device-hub",
  revision: 4,
};

test("the wire state merges EAS and Simlock hosts into one list and drops unreadable rows", () => {
  const state = readDeviceState(wire)!;
  expect(state.hosts.map((host) => `${host.id}:${host.kind}`)).toEqual(["local:local", "eas1:eas", "sim1:simlock"]);
  expect(state.devices.length).toBe(3);
  expect(state.sessions[0]!.deviceId).toBe("A");
  expect(state.bootingDevices[0]!.threadId).toBe("t1");
  expect(state.supportsHostRetry).toBe(true);
  expect(readDeviceState({})).toBeNull();
});

test("devices group by platform, running first, then by name", () => {
  const groups = groupDevices(readDeviceState(wire)!);
  expect(groups.map((group) => group.platform)).toEqual(["ios", "android"]);
  expect(groups[0]!.devices.map((device) => device.name)).toEqual(["iPhone A", "iPhone B"]);
});

test("a ready host's incomplete listing and warning are reported", () => {
  const state = readDeviceState(wire)!;
  expect(incompleteListings(state.hostStatuses.local)).toEqual(["android"]);
  expect(incompleteListings(state.hostStatuses.eas1)).toEqual([]);
  expect(hostDiagnostics(state)).toEqual([{ hostId: "local", label: "This machine", detail: "adb timed out", incompletePlatforms: ["android"] }]);
  expect(discoveryWarningText("This machine", ["android"])).toBe("Android list on This machine may be incomplete.");
  expect(discoveryWarningText("Mac", ["ios", "android"])).toBe("iOS and Android lists on Mac may be incomplete.");
  expect(discoveryWarningText("Mac", [])).toBe("Device discovery on Mac reported a warning.");
});

test("readiness counts remote hosts and tells busy from ready", () => {
  const state = readDeviceState({ ...wire, hostStatus: "disabled", hostStatuses: { h: { status: "ready" } } })!;
  expect(deviceHubReadiness(state)).toEqual({ ready: true, busy: false });
  expect(deviceHubReadiness(readDeviceState({ ...wire, hostStatus: "installing", hostStatuses: {} })!)).toEqual({ ready: false, busy: true });
});

test("setup is needed until onboarding completes or while the hub is off, but only once loaded", () => {
  const state = readDeviceState(wire)!;
  expect(needsSetup(state, true)).toBe(false);
  expect(needsSetup({ ...state, onboardingCompleted: false }, true)).toBe(true);
  expect(needsSetup({ ...state, hostStatus: "disabled" }, true)).toBe(true);
  expect(needsSetup({ ...state, onboardingCompleted: false }, false)).toBe(false);
});

test("the setup step names what each platform needs", () => {
  const state = readDeviceState({ ...wire, devices: [], hostStatuses: { local: { status: "ready" } } })!;
  expect(platformSetupStatus(state, "ios").message).toContain("Xcode is installed, but no iOS Simulator is available.");
  expect(platformSetupStatus(state, "android")).toEqual({ ready: false, message: "No Android SDK" });
  expect(platformSetupStatus(readDeviceState(wire)!, "ios")).toEqual({ ready: true, message: "Xcode and iOS Simulator are available." });
});

test("the loading and empty copy follows the panel", () => {
  const state = readDeviceState(wire)!;
  const booted = state.devices.find((device) => device.booted)!;
  expect(loadingMessage({ loadError: null, pending: booted, hostStatus: "ready" })).toBe("Opening device…");
  expect(loadingMessage({ loadError: null, pending: state.devices[0]!, hostStatus: "ready" })).toBe("Starting device…");
  expect(loadingMessage({ loadError: null, pending: null, hostStatus: "installing" })).toBe("Installing device support…");
  expect(loadingMessage({ loadError: null, pending: null, hostStatus: "ready" })).toBe("Finding devices…");
  expect(loadingMessage({ loadError: "boom", pending: null, hostStatus: "ready" })).toBe("boom");
  expect(emptyListMessage({ hostStatus: "failed" })).toBe("The device hub failed to start.");
  expect(emptyListMessage({ hostStatus: "ready" })).toBe("No simulators or emulators were found on this environment.");
  expect(hostUpdateDetail({ status: "failed" })).toBe("Device support could not start.");
});

test("the Android hint shows only when nothing explains the missing devices", () => {
  const none = readDeviceState({ ...wire, devices: [], hosts: [{ id: "local", label: "m", kind: "local", platforms: [{ platform: "android", available: true }], hubInstalled: true, agentDeviceInstalled: true }], easHosts: [], simlockHosts: [], hostStatuses: { local: { status: "ready" } } })!;
  expect(showsAndroidHint(none)).toBe(true);
  expect(showsAndroidHint(readDeviceState(wire)!)).toBe(false);
});
