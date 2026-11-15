// agentOpenedPreviews.ts applyDeviceSnapshot: the first snapshot is a baseline, a new session floats (or opens a tab),
// the sheet layout gets neither, a session with no device summary yet waits, an ended session closes its float.
import { expect, test } from "nsh/test";
import { EMPTY_DEVICE_STATE, type DeviceServiceState } from "../device/deviceLogic";
import { applyDeviceSnapshot } from "./agentOpenedDevices";

const device = { hostId: "local", id: "sim-1", platform: "ios" as const, name: "iPhone 17", version: "iOS 26", booted: true, physical: false };
const session = { threadId: "thread-1", hostId: "local", deviceId: "sim-1", platform: "ios" as const, openedAt: "2026-11-12T10:00:00Z" };
const withSession = (extra: Partial<DeviceServiceState> = {}): DeviceServiceState => ({ ...EMPTY_DEVICE_STATE, devices: [device], sessions: [session], ...extra });
const on = { sheetLayout: false, autoShowFloatingPreview: true };

test("the first snapshot is only a baseline: an existing session does not float", () => {
  const result = applyDeviceSnapshot(undefined, withSession(), [], on);
  expect(result.float).toEqual([]);
  expect(result.baseline.size).toBe(1);
});

test("a session new since the baseline floats over its thread", () => {
  const first = applyDeviceSnapshot(undefined, EMPTY_DEVICE_STATE, [], on);
  const result = applyDeviceSnapshot(first.baseline, withSession(), [], on);
  expect(result.float).toEqual([{ threadId: "thread-1", target: { hostId: "local", deviceId: "sim-1", platform: "ios", name: "iPhone 17" } }]);
  expect(result.openTab).toEqual([]);
});

test("with floating previews off it becomes a panel tab, and the sheet layout gets neither", () => {
  const first = applyDeviceSnapshot(undefined, EMPTY_DEVICE_STATE, [], on);
  expect(applyDeviceSnapshot(first.baseline, withSession(), [], { ...on, autoShowFloatingPreview: false }).openTab.length).toBe(1);
  const sheet = applyDeviceSnapshot(first.baseline, withSession(), [], { ...on, sheetLayout: true });
  expect(sheet.float).toEqual([]);
  expect(sheet.openTab).toEqual([]);
});

test("a session with no device summary yet waits for a snapshot that has one", () => {
  const first = applyDeviceSnapshot(undefined, EMPTY_DEVICE_STATE, [], on);
  const early = applyDeviceSnapshot(first.baseline, withSession({ devices: [] }), [], on);
  expect(early.float).toEqual([]);
  expect(applyDeviceSnapshot(early.baseline, withSession(), [], on).float.length).toBe(1);
});

test("a floating device whose session ended closes", () => {
  const result = applyDeviceSnapshot(new Set(), EMPTY_DEVICE_STATE, [{ threadId: "thread-1", target: { hostId: "local", deviceId: "sim-1" } }], on);
  expect(result.close).toEqual(["thread-1"]);
});
