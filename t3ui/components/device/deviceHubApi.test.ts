import { expect, test } from "nsh/test";
import { appendDeviceEventLog, eventLogUrl, foregroundUrl, parseAxPayload, readEventLogMessage, readForegroundMessage } from "./deviceHubApi";

const t = { access: { httpBase: "http://h/api/device-hub", query: { hostId: "local", wsTicket: "T" } }, platform: "ios" as const, deviceId: "S1" };

test("hub stream URLs carry the device and the hub query", () => {
  expect(eventLogUrl(t)).toBe("http://h/api/device-hub/vendor/serve-sim/api/event-log/events?device=S1&limit=100&hostId=local&wsTicket=T");
  expect(foregroundUrl(t)).toBe("http://h/api/device-hub/vendor/serve-sim/appstate?device=S1&hostId=local&wsTicket=T");
});

test("the iOS AX tree flattens to normalized frames without the full-screen root", () => {
  const tree = parseAxPayload("ios", [{ frame: { x: 0, y: 0, width: 400, height: 800 }, children: [{ AXUniqueId: "b", AXLabel: "Sign in", type: "Button", frame: { x: 100, y: 200, width: 200, height: 40 } }] }]);
  expect(tree.elements).toEqual([{ id: "b", label: "Sign in", role: "Button", x: 0.25, y: 0.25, width: 0.5, height: 0.05 }]);
  expect(parseAxPayload("ios", { error: "busy" }).errors).toEqual(["busy"]);
});

test("event log batches reset, single events append, capped at 100; foreground messages", () => {
  const batch = readEventLogMessage({ events: [{ id: 1, timestamp: "2026-11-12T10:00:01Z", summary: "launch" }] })!;
  expect(batch.reset).toBe(true);
  const one = readEventLogMessage({ event: { id: 2, msg: "tap" } })!;
  const log = appendDeviceEventLog(appendDeviceEventLog([], batch.entries, true), one.entries, false);
  expect(log.map((e) => e.summary)).toEqual(["launch", "tap"]);
  expect(appendDeviceEventLog([], Array.from({ length: 150 }, (_, i) => ({ id: i, timestamp: "", kind: "", summary: "" })), true).length).toBe(100);
  expect(readForegroundMessage({ bundleId: "com.apple.Preferences" })).toEqual({ id: "com.apple.Preferences" });
  expect(readForegroundMessage({ bundleId: "" })).toBeNull();
});

test("a screenshot is the hub's POST /api/screenshot PNG; a failure names its status (fm13)", async () => {
  const { captureDeviceScreenshot, deviceScreenshotFileName } = await import("./deviceHubApi");
  const asked: string[] = [];
  const ok = (async (url: string, init?: RequestInit) => { asked.push(`${init?.method} ${url}`); return new Response(new Uint8Array([137, 80, 78, 71])); }) as unknown as typeof fetch;
  expect((await captureDeviceScreenshot(t, ok)).length).toBe(4);
  expect(asked[0]!.startsWith("POST http://h/api/device-hub/vendor/serve-sim/api/screenshot?device=S1")).toBe(true);
  const denied = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  let message = "";
  try { await captureDeviceScreenshot(t, denied); } catch (cause) { message = (cause as Error).message; }
  expect(message).toBe("Screenshot capture failed (401). Try again.");
  expect(deviceScreenshotFileName("iPhone 15 Pro", 5)).toBe("iPhone-15-Pro-5.png");
});
