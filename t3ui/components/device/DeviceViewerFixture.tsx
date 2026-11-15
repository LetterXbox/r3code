// The device workspace for an iPad Pro 13-inch (M5), which has a 3D model and the Magic Keyboard accessory.
(globalThis as { DEVICE_FIXTURE_NAME?: string }).DEVICE_FIXTURE_NAME = "iPad Pro 13-inch (M5)";
import { overrideViewerAssets } from "./deviceViewer";
overrideViewerAssets(async (name) => (name === "document" ? "<!doctype html><script>window.T3_VIEWER=__T3_VIEWER_CONFIG__;</script>" : "R0xC"));
await import("./DeviceWorkspaceFixture");
