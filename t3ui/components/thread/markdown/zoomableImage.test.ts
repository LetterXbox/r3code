import { expect, test } from "nsh/test";
import { changeZoom, clampPan, clickZoom, MAX_ZOOM, wheelZoom, zoomViewport } from "./zoomableImage";

// A 400 x 300 fitted image in a dialog with 960 x 600 of room.
const box = { width: 400, height: 300, maxWidth: 960, maxHeight: 600 };
const fit = { zoom: 1, left: 0, top: 0 };

test("the viewport grows with the zoom up to its room", () => {
  expect(zoomViewport(box, 1)).toEqual({ width: 400, height: 300 });
  expect(zoomViewport(box, 4)).toEqual({ width: 960, height: 600 });
});

test("a click toggles fit and 2x; the point under the pointer stays put", () => {
  expect(clickZoom(1)).toBe(2);
  expect(clickZoom(2.4)).toBe(1);
  // Clicking the image's top-left quarter point (100, 75) at 2x: viewport 800 x 600 grows 200 / 150 each side.
  const zoomed = changeZoom(box, fit, 2, { x: 100, y: 75 });
  expect(zoomed.zoom).toBe(2);
  // That content point (100, 75 at 1x = 200, 150 at 2x) sits where the pointer is in the grown viewport (300, 225).
  expect(zoomed.left).toBe(0);
  expect(zoomed.top).toBe(0);
  const deeper = changeZoom(box, zoomed, 4, { x: 600, y: 450 });
  expect(deeper.zoom).toBe(4);
  // Content point (300, 225) at 1x is (1200, 900) at 4x; the capped viewport (960 x 600) grew 80 each side, so the
  // pointer is at (680, 450) in it.
  expect(deeper.left).toBe(520);
  expect(deeper.top).toBe(450);
});

test("zoom is clamped to 1..8 and the pan stays inside the content", () => {
  expect(changeZoom(box, fit, 0.2)).toBe(fit);
  expect(changeZoom(box, { zoom: 8, left: 0, top: 0 }, 20).zoom).toBe(MAX_ZOOM);
  expect(clampPan(box, { zoom: 2, left: -40, top: 9999 })).toEqual({ zoom: 2, left: 0, top: 0 });
  expect(clampPan(box, { zoom: 4, left: 9999, top: 9999 })).toEqual({ zoom: 4, left: 640, top: 600 });
});

test("the wheel zooms exponentially, Ctrl five times faster; scrolling down zooms out", () => {
  expect(Math.abs(wheelZoom(1, -100, false) - Math.exp(0.2)) < 1e-9).toBe(true);
  expect(Math.abs(wheelZoom(1, -100, true) - Math.exp(1)) < 1e-9).toBe(true);
  expect(wheelZoom(2, 100, false)).toBeLessThan(2);
});
