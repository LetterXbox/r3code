import { expect, test } from "nsh/test";
import { toToolbarViewport, toZoomFactor } from "./browserDefaults";

test("saved defaults become a new tab's viewport and zoom", () => {
  expect(toToolbarViewport(JSON.stringify({ _tag: "preset", presetId: "iphone-15", width: 393, height: 852 }))).toEqual({ kind: "preset", width: 393, height: 852, presetId: "iphone-15" });
  expect(toToolbarViewport(JSON.stringify({ _tag: "freeform", width: 800, height: 600 }))).toEqual({ kind: "freeform", width: 800, height: 600 });
  expect(toToolbarViewport(null)).toEqual({ kind: "fill" });
  expect(toZoomFactor("1.25")).toBe(1.25);
  expect(toZoomFactor(9)).toBe(1);
  expect(toZoomFactor(undefined)).toBe(1);
});
