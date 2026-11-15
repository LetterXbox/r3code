import { expect, test } from "nsh/test";
import { bridgeAvailable, bridgeMarker, detectBridge, rendersServerTabNatively } from "./desktopBrowserBridge";

test("the marker carries the tab key the host parses", () => {
  const marker = bridgeMarker("thread-1", "tab-2");
  expect(marker.startsWith("/*t3-desktop-browser ")).toBe(true);
  expect(marker.endsWith("*/")).toBe(true);
  expect(JSON.parse(marker.slice("/*t3-desktop-browser ".length, -2))).toEqual({ threadId: "thread-1", tabId: "tab-2" });
});

test("only primary, non-headless server tabs are drawn natively, and only with the relay", () => {
  const server = { runtime: "server" };
  expect(rendersServerTabNatively({ available: true, primary: true, snapshot: server })).toBe(true);
  expect(rendersServerTabNatively({ available: false, primary: true, snapshot: server })).toBe(false);
  expect(rendersServerTabNatively({ available: true, primary: false, snapshot: server })).toBe(false);
  expect(rendersServerTabNatively({ available: true, primary: true, snapshot: { runtime: "server", headless: true } })).toBe(false);
  expect(rendersServerTabNatively({ available: true, primary: true, snapshot: { runtime: "desktop" } })).toBe(false);
});

test("a host without patch 0014 (it rejects desktopBrowser.supported) leaves the bridge off", async () => {
  await detectBridge(() => Promise.reject(new Error("unknown host call")));
  expect(bridgeAvailable()).toBe(false);
  await detectBridge(() => Promise.resolve(false));
  expect(bridgeAvailable()).toBe(false);
  await detectBridge(() => Promise.resolve(true));
  expect(bridgeAvailable()).toBe(true);
  await detectBridge(() => { throw new Error("no host"); });
  expect(bridgeAvailable()).toBe(false);
});
