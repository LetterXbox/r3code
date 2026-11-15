import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { createSnapshotHost } from "./nativeSnapshot";
import { nativeViewOccluded, openOverlayLabels, overlapsFloating, rectsOverlap, useFloatingRect } from "./nativeOcclusion";

const PNG = "data:image/png;base64,AAAA";

test("a snapshot that arrives while occluded replaces the placeholder, and is dropped on close", () => {
  const open = signal(false);
  const asked: number[] = [];
  const host = createSnapshotHost(() => open(), (token) => asked.push(token));
  expect(asked.length).toBe(0);
  open.set(true);
  expect(asked.length).toBe(1);
  expect(host.image()).toBe(null);
  expect(host.handleMessage({ type: "snapshot", token: asked[0], url: PNG })).toBe(true);
  expect(host.image()).toBe(PNG);
  open.set(false);
  expect(host.image()).toBe(null);
});

test("a failed snapshot keeps the placeholder", () => {
  const open = signal(false);
  const asked: number[] = [];
  const host = createSnapshotHost(() => open(), (token) => asked.push(token));
  open.set(true);
  host.handleMessage({ type: "snapshot-error", token: asked[0] });
  host.receive(asked[0]!, PNG);
  expect(host.image()).toBe(null);
  open.set(false);
});

test("a request that throws (page not ready) keeps the placeholder", () => {
  const open = signal(false);
  const host = createSnapshotHost(() => open(), () => { throw new Error("not ready"); });
  open.set(true);
  host.receive(1, PNG);
  expect(host.image()).toBe(null);
  open.set(false);
});

test("a snapshot that arrives after close, or for an older open, is ignored", () => {
  const open = signal(false);
  const asked: number[] = [];
  const host = createSnapshotHost(() => open(), (token) => asked.push(token));
  open.set(true);
  open.set(false);
  host.receive(asked[0]!, PNG);
  expect(host.image()).toBe(null);
  open.set(true);
  host.receive(asked[0]!, PNG);
  expect(host.image()).toBe(null);
  host.receive(asked[1]!, PNG);
  expect(host.image()).toBe(PNG);
  open.set(false);
  expect(host.image()).toBe(null);
});

test("a snapshot after the timeout is ignored", async () => {
  const open = signal(false);
  const asked: number[] = [];
  const host = createSnapshotHost(() => open(), (token) => asked.push(token), 20);
  open.set(true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  host.receive(asked[0]!, PNG);
  expect(host.image()).toBe(null);
  open.set(false);
});

test("a floating rect occludes only the web views it overlaps", () => {
  const shown = signal(false);
  const toast = { x: 900, y: 84, width: 360, height: 80 };
  useFloatingRect(() => (shown() ? toast : null), "toasts");
  const terminal = { x: 300, y: 500, width: 900, height: 300 };
  const browser = { x: 800, y: 60, width: 480, height: 700 };
  shown.set(true);
  expect(openOverlayLabels()).toEqual(["toasts"]);
  expect(rectsOverlap(toast, browser)).toBe(true);
  expect(nativeViewOccluded(terminal)).toBe(false);
  expect(nativeViewOccluded(browser)).toBe(true);
  expect(nativeViewOccluded()).toBe(false);
  shown.set(false);
  expect(overlapsFloating(browser)).toBe(false);
  expect(openOverlayLabels()).toEqual([]);
});
