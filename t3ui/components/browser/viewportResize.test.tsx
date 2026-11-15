// useBrowserViewportResize / BrowserViewportResizeHandles: rails, labels, drag commit and the keyboard steps.
import { expect, open, test } from "nsh/test";
import { handleBox, keyboardResizeDelta, VIEWPORT_RESIZE_HANDLES } from "./BrowserViewportResizeHandles";

test("five rails with the reference's labels, boxed around the frame", () => {
  expect(VIEWPORT_RESIZE_HANDLES.map((handle) => handle.direction)).toEqual(["west", "east", "south", "southwest", "southeast"]);
  expect(VIEWPORT_RESIZE_HANDLES[0]!.label).toBe("Resize browser viewport from left edge");
  expect(VIEWPORT_RESIZE_HANDLES[4]!.label).toBe("Resize browser viewport from bottom-right corner");
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  expect(handleBox("west", frame)).toEqual({ x: 90, y: 50, width: 10, height: 300 });
  expect(handleBox("south", frame)).toEqual({ x: 100, y: 350, width: 400, height: 10 });
  expect(handleBox("southeast", frame)).toEqual({ x: 500, y: 350, width: 10, height: 10 });
});

test("keyboardResizeDelta: 10 pt, Shift 50, only on the rail's axes", () => {
  expect(keyboardResizeDelta("east", "right", false)).toEqual({ x: 10, y: 0 });
  expect(keyboardResizeDelta("west", "left", true)).toEqual({ x: -50, y: 0 });
  expect(keyboardResizeDelta("east", "up", false)).toBeNull();
  expect(keyboardResizeDelta("south", "down", false)).toEqual({ x: 0, y: 10 });
  expect(keyboardResizeDelta("southeast", "left", false)).toEqual({ x: -10, y: 0 });
});

test("a drag on the right rail commits a freeform size; the centred page grows by twice the travel", async () => {
  const app = await open("./ViewportResizeFixture.tsx", { width: 1000, height: 800 });
  await app.waitFor("text:setting=preset 400x300");
  await app.drag("label:Resize browser viewport from right edge. Use arrow keys to resize.", { x: 50 });
  await app.waitFor("text:setting=freeform 500x300");
  await app.drag("label:Resize browser viewport from bottom edge. Use arrow keys to resize.", { y: 30 });
  await app.waitFor("text:setting=freeform 500x360");
});

test("a drag that ends where it started changes nothing", async () => {
  const app = await open("./ViewportResizeFixture.tsx", { width: 1000, height: 800 });
  await app.drag("label:Resize browser viewport from left edge. Use arrow keys to resize.", { x: 0, y: 40 });
  await app.wait(100);
  await app.waitFor("text:setting=preset 400x300");
});

test("a rail's arrow keys resize at once, show the readout and commit 150 ms after the last key", async () => {
  const app = await open("./ViewportResizeFixture.tsx", { width: 1000, height: 800 });
  await app.press("label:Key up");
  await app.wait(250);
  await app.waitFor("text:setting=preset 400x300");
  await app.press("label:Key left");
  await app.press("label:Key shift left");
  await app.waitFor("text:live=460x300");
  await app.waitFor("text:460 × 300");
  await app.waitFor("text:setting=freeform 460x300");
  await app.waitFor("text:live=none");
});
