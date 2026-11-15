// The whole-app zoom (DesktopWindow.ts zoomWindow): 0.5 level per step, 0 resets, Chromium's 1.2 ** level factor between 0.25x and 5x.
import { expect, test } from "nsh/test";
import { FONT_DEFAULTS, rootTextStyle } from "../typography";
import { appZoomFactor, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, nextZoomLevel, setAppZoomLevelForTest, zoomApp, zoomedSize, zoomFactorOf } from "./appZoom";

test("in and out move half a level, reset goes to 0", () => {
  expect(nextZoomLevel(0, "in")).toBe(0.5);
  expect(nextZoomLevel(0.5, "in")).toBe(1);
  expect(nextZoomLevel(0, "out")).toBe(-0.5);
  expect(nextZoomLevel(3, "reset")).toBe(0);
  expect(nextZoomLevel(-2, "reset")).toBe(0);
});

test("the level stays where the factor stays between 0.25x and 5x", () => {
  expect(nextZoomLevel(MAX_ZOOM_LEVEL, "in")).toBe(MAX_ZOOM_LEVEL);
  expect(nextZoomLevel(MIN_ZOOM_LEVEL, "out")).toBe(MIN_ZOOM_LEVEL);
  expect(zoomFactorOf(MAX_ZOOM_LEVEL) <= 5).toBe(true);
  expect(zoomFactorOf(MIN_ZOOM_LEVEL) >= 0.25).toBe(true);
  expect(zoomFactorOf(0)).toBe(1);
  expect(Math.abs(zoomFactorOf(1) - 1.2) < 1e-9).toBe(true);
});

test("the factor reaches the text the app sizes itself", () => {
  setAppZoomLevelForTest(0);
  expect(rootTextStyle().fontSize).toBeUndefined();
  expect(zoomedSize(14)).toBe(14);
  zoomApp("in");
  zoomApp("in");
  expect(Math.abs(appZoomFactor() - 1.2) < 1e-9).toBe(true);
  expect(rootTextStyle().fontSize).toBe(Math.round(14 * 1.2));
  expect(zoomedSize(FONT_DEFAULTS.terminal)).toBe(Math.round(12 * 1.2));
  zoomApp("reset");
  expect(rootTextStyle().fontSize).toBeUndefined();
  setAppZoomLevelForTest(0);
});
