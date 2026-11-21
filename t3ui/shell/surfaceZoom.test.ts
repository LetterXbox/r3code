import { expect, test } from "nsh/test";
import { Storage } from "nsh";
import { nextSurfaceScale, scaledFor, surfaceScale, surfaceZoomTarget, SURFACE_ZOOM_STORAGE_KEY, zoomHoveredSurface } from "./surfaceZoom";

test("steps scale by 10%, clamp, and in-then-out returns to exactly 1", () => {
  expect(nextSurfaceScale(1, "in")).toBe(1.1);
  expect(nextSurfaceScale(nextSurfaceScale(1, "in"), "out")).toBe(1);
  expect(nextSurfaceScale(2.5, "in")).toBe(2.5);
  expect(nextSurfaceScale(0.6, "out")).toBe(0.6);
  expect(nextSurfaceScale(1.7, "reset")).toBe(1);
});

test("only the hovered surface zooms, and its scale is saved", async () => {
  expect(zoomHoveredSurface("in")).toBe(false);
  const diff = surfaceZoomTarget("diff");
  diff.onMouseEnter();
  expect(zoomHoveredSurface("in")).toBe(true);
  expect(surfaceScale("diff")).toBe(1.1);
  expect(surfaceScale("files")).toBe(1);
  expect(scaledFor("diff", 20)).toBe(22);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await Storage.getItem(SURFACE_ZOOM_STORAGE_KEY)).toBe('{"diff":1.1}');
  diff.onMouseLeave();
  expect(zoomHoveredSurface("in")).toBe(false);
  diff.onMouseEnter();
  zoomHoveredSurface("reset");
  expect(surfaceScale("diff")).toBe(1);
});
