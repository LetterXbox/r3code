import { expect, open, test } from "nsh/test";
import { hasDeviceKeyboard, hubWsBase, phoneUnavailableReason, readViewerReport, resolveDeviceModelId, viewerPage } from "./deviceViewer";

const none = { isDuo: false, supportsHingeAngle: false, phoneUnavailable: false, mjpeg: false, axOverlay: false };

test("3D is unavailable for the reference's reasons, in its order", () => {
  expect(phoneUnavailableReason(none)).toBeNull();
  expect(phoneUnavailableReason({ ...none, isDuo: true, phoneUnavailable: true, mjpeg: true, axOverlay: true })).toBe("iPhone Duo 3D requires Device Hub 0.11.0 or newer");
  expect(phoneUnavailableReason({ ...none, isDuo: true, supportsHingeAngle: true })).toBeNull();
  expect(phoneUnavailableReason({ ...none, phoneUnavailable: true, mjpeg: true, axOverlay: true })).toBe("3D is unavailable on this browser");
  expect(phoneUnavailableReason({ ...none, mjpeg: true, axOverlay: true })).toBe("3D requires the H.264 stream");
  expect(phoneUnavailableReason({ ...none, axOverlay: true })).toBe("Turn off accessibility frames to use 3D");
});

test("models follow deviceModels.ts: iOS names only, and the iPad has the keyboard", () => {
  expect(resolveDeviceModelId("ios", "iPhone 18 Pro")).toBe("iphone-18-pro");
  expect(resolveDeviceModelId("ios", "iPhone 18 Pro Max")).toBe("iphone-18-pro-max");
  expect(resolveDeviceModelId("ios", "iPhone Duo")).toBe("iphone-duo");
  expect(resolveDeviceModelId("ios", "iPad Pro 13-inch (M5)")).toBe("ipad-pro-13-m5");
  expect(resolveDeviceModelId("ios", "iPhone SE")).toBeNull();
  expect(resolveDeviceModelId("android", "iPhone 18 Pro")).toBeNull();
  expect(hasDeviceKeyboard("ios", "iPad Pro 13-inch (M5)")).toBe(true);
  expect(hasDeviceKeyboard("ios", "iPhone 18 Pro")).toBe(false);
});

test("the page carries the device's config, models and a ws hub base, and nothing in it can close the script", () => {
  const html = viewerPage("<script>window.T3_VIEWER=__T3_VIEWER_CONFIG__;</script>", { platform: "ios", deviceId: "A", deviceName: "</script><b>", serveSimOnly: false, access: { httpBase: "https://h/api/device-hub", query: { hostId: "local" } }, keyboardAttached: false, foldAngle: null }, { model: "R0xC", accessory: null });
  expect(html).not.toContain("</script><b>");
  expect(html).toContain('"wsBase":"wss://h/api/device-hub"');
  expect(html).toContain('"model":"R0xC"');
  expect(hubWsBase("http://127.0.0.1:3773/x")).toBe("ws://127.0.0.1:3773/x");
  expect(readViewerReport('{"t3":"viewer","status":"streaming"}')?.status).toBe("streaming");
  expect(readViewerReport('{"t3":"stream"}')).toBeNull();
});

test("an iPad starts in 3D; when the 3D page cannot start, the rail falls back to Flat with 3D disabled and its reason", async () => {
  const app = await open("./DeviceViewerFixture.tsx", { width: 1000, height: 900, platform: "macos" });
  await app.waitFor("label:3D view");
  await expect(app.shows("label:Flat view")).toBe(true);
  // No environment address in the fixture: the page is never built, so the panel shows the flat view at once.
  await app.waitUntil(() => !app.shows("label:Restore 3D view"));
  await expect(app.shows("label:Attach Magic Keyboard")).toBe(false);
  let refused = "";
  try { await app.press("label:3D view"); } catch (cause) { refused = String(cause); }
  await expect(refused).toContain("disabled");
});
