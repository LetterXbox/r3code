import { expect, test } from "nsh/test";
import { alternatePreviewRuntime, isPrimaryEnvironmentEndpoint, moveTabLabel, previewRuntimeFor } from "./previewRuntime";

test("fm13: previewRuntimeFor and alternatePreviewRuntime follow previewRuntime.ts", () => {
  expect(isPrimaryEnvironmentEndpoint("ws://127.0.0.1:3773/ws")).toBe(true);
  expect(isPrimaryEnvironmentEndpoint("wss://10.0.0.4:3773/ws")).toBe(false);
  expect(previewRuntimeFor({ serverBrowser: false, primary: true })).toBe(undefined);
  expect(previewRuntimeFor({ serverBrowser: true, primary: false })).toBe(undefined);
  expect(previewRuntimeFor({ serverBrowser: true, primary: true })).toBe("server");
  // A tab moves only on a remote environment that has a browser of its own.
  expect(alternatePreviewRuntime({ primary: true, serverBrowser: true, runtime: "desktop" })).toBe(null);
  expect(alternatePreviewRuntime({ primary: false, serverBrowser: false, runtime: "desktop" })).toBe(null);
  expect(alternatePreviewRuntime({ primary: false, serverBrowser: true, runtime: null })).toBe(null);
  expect(alternatePreviewRuntime({ primary: false, serverBrowser: true, runtime: "desktop" })).toBe("server");
  expect(alternatePreviewRuntime({ primary: false, serverBrowser: true, runtime: "server" })).toBe("desktop");
  expect(moveTabLabel("server", "Studio")).toBe("Open in Studio's browser");
  expect(moveTabLabel("desktop", "Studio")).toBe("Open on this computer");
});
