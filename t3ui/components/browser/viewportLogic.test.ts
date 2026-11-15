import { expect, test } from "nsh/test";
import { deviceViewportArea, framedViewport, lockedSize, resizeFreeformViewport, resizeViewportFromRail, responsiveViewportSize, toolbarCustomSize, toolbarTypedSize, presetLabel, rotateViewport, selectViewport, validViewport, VIEWPORT_PRESETS } from "./viewportLogic";

test("the presets are Chrome's default devices in order", () => {
  expect(VIEWPORT_PRESETS.length).toBe(17);
  expect(VIEWPORT_PRESETS[0]).toMatchObject({ id: "iphone-se", label: "iPhone SE", detail: "375 × 667" });
  expect(VIEWPORT_PRESETS[16]).toMatchObject({ id: "nest-hub-max", width: 1280, height: 800 });
});

test("choosing a preset sets its size and ratio; Responsive keeps the size as freeform", () => {
  const preset = selectViewport("pixel-7", { kind: "freeform", width: 800, height: 600 })!;
  expect(preset.setting).toEqual({ kind: "preset", width: 412, height: 915, presetId: "pixel-7" });
  expect(presetLabel(preset.setting)).toBe("Pixel 7");
  expect(selectViewport("responsive", { kind: "preset", width: 412, height: 915, presetId: "pixel-7" })!.setting).toEqual({ kind: "freeform", width: 412, height: 915 });
  expect(selectViewport("responsive", { kind: "freeform", width: 1, height: 1 })).toBeNull();
  expect(selectViewport("nope", { kind: "freeform", width: 1, height: 1 })).toBeNull();
});

test("sizes are bounded to 240..3840 and 3840x2160 in area", () => {
  expect(validViewport(240, 240)).toBe(true);
  expect(validViewport(239, 500)).toBe(false);
  expect(validViewport(3841, 500)).toBe(false);
  expect(validViewport(3840, 2161)).toBe(false);
  expect(validViewport(300.5, 400)).toBe(false);
});

test("rotating swaps the sides and inverts a locked ratio; a locked ratio drives the other side", () => {
  expect(rotateViewport({ kind: "preset", width: 375, height: 667, presetId: "iphone-se" }, 375 / 667)).toEqual({ setting: { kind: "preset", width: 667, height: 375, presetId: "iphone-se" }, ratio: 667 / 375 });
  expect(rotateViewport({ kind: "freeform", width: 500, height: 300 }, null).ratio).toBeNull();
  expect(lockedSize("width", 800, 2, 100)).toEqual({ width: 800, height: 400 });
  expect(lockedSize("height", 300, 2, 100)).toEqual({ width: 600, height: 300 });
  expect(lockedSize("width", 800, null, 123)).toEqual({ width: 800, height: 123 });
});

test("the page's frame is the viewport clamped to the panel; fill has no frame", () => {
  expect(framedViewport({ kind: "fill" }, { width: 500, height: 500 })).toBeNull();
  expect(framedViewport({ kind: "freeform", width: 390, height: 844 }, { width: 500, height: 600 })).toEqual({ width: 390, height: 600 });
});

test("fm13: freeform resize clamps to 240..3840 and the area cap, and keeps a locked ratio in range", () => {
  expect(resizeFreeformViewport({ width: 400, height: 300 }, { x: -500, y: 0 }, 1, "east")).toEqual({ width: 240, height: 300 });
  expect(resizeFreeformViewport({ width: 3000, height: 2000 }, { x: 1000, y: 0 }, 1, "east")).toEqual({ width: 3840, height: 2000 });
  expect(resizeFreeformViewport({ width: 3840, height: 2000 }, { x: 0, y: 1000 }, 1, "south")).toEqual({ width: 3840, height: 2160 });
  // west handle: dragging left grows the width.
  expect(resizeFreeformViewport({ width: 400, height: 300 }, { x: -100, y: 0 }, 1, "west")).toEqual({ width: 500, height: 300 });
  // ratio 2: a width of 300 would make height 150 (< 240), so it is held at 480 x 240.
  expect(resizeFreeformViewport({ width: 800, height: 400 }, { x: -500, y: 0 }, 1, "east", 2)).toEqual({ width: 480, height: 240 });
  // zoom halves the drag.
  expect(resizeFreeformViewport({ width: 400, height: 300 }, { x: 100, y: 0 }, 2, "east")).toEqual({ width: 450, height: 300 });
});

test("fm13: a rail drag on a centred viewport moves both edges", () => {
  expect(resizeViewportFromRail({ width: 400, height: 300 }, { x: 50, y: 0 }, { width: 1000, height: 800 }, 1, "east")).toEqual({ width: 500, height: 300 });
  expect(resizeViewportFromRail({ width: 400, height: 300 }, { x: -50, y: 0 }, { width: 1000, height: 800 }, 1, "west")).toEqual({ width: 500, height: 300 });
});

test("fm13: the responsive size is the room inside the rails and under the toolbar", () => {
  expect(deviceViewportArea({ width: 800, height: 600 })).toEqual({ width: 780, height: 552 });
  expect(responsiveViewportSize({ width: 800, height: 600 })).toEqual({ width: 780, height: 552 });
  expect(responsiveViewportSize({ width: 100, height: 100 })).toEqual({ width: 240, height: 240 });
});

test("fm13: typing a side with the ratio locked resizes the other; the draft commits clamped", () => {
  const typed = toolbarTypedSize("width", "600", null, { width: 400, height: 200 }, 2);
  expect(typed).toEqual({ width: "600", height: "300", axis: "width" });
  expect(toolbarTypedSize("width", "60", null, { width: 400, height: 200 }, 2)).toEqual({ width: "60", height: "200", axis: "width" });
  expect(toolbarCustomSize(typed, 2)).toEqual({ width: 600, height: 300, valid: true });
  expect(toolbarCustomSize({ width: "100", height: "300" }, null).valid).toBe(false);
});
