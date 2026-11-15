import { expect, test } from "nsh/test";
import { FILL_VIEWPORT, parseViewport, rotateViewport, serializeViewport, viewportFromChoice, viewportFromDimension, viewportSelectLabel, viewportSelectValue } from "./viewportSetting";

test("a stored viewport that is not valid reads as fill", () => {
  expect(parseViewport(undefined)).toEqual(FILL_VIEWPORT);
  expect(parseViewport("nonsense")).toEqual(FILL_VIEWPORT);
  expect(parseViewport('{"_tag":"freeform","width":100,"height":800}')).toEqual(FILL_VIEWPORT);
  expect(parseViewport('{"_tag":"freeform","width":1000,"height":800}')).toEqual({ _tag: "freeform", width: 1000, height: 800 });
});

test("the select shows Fill panel, Responsive, or the preset's label", () => {
  expect(viewportSelectLabel(FILL_VIEWPORT)).toBe("Fill panel");
  expect(viewportSelectLabel({ _tag: "freeform", width: 500, height: 600 })).toBe("Responsive");
  const preset = viewportFromChoice("iphone-se", FILL_VIEWPORT)!;
  expect(preset).toEqual({ _tag: "preset", presetId: "iphone-se", width: 375, height: 667 });
  expect(viewportSelectValue(preset)).toBe("iphone-se");
  expect(viewportSelectLabel(preset)).toBe("iPhone SE");
  expect(viewportFromChoice("nope", FILL_VIEWPORT)).toBe(null);
});

test("Responsive seeds 1280 x 800 from fill and keeps the current size otherwise", () => {
  expect(viewportFromChoice("responsive", FILL_VIEWPORT)).toEqual({ _tag: "freeform", width: 1280, height: 800 });
  expect(viewportFromChoice("responsive", { _tag: "preset", presetId: "iphone-se", width: 375, height: 667 })).toEqual({ _tag: "freeform", width: 375, height: 667 });
});

test("a typed dimension commits a freeform viewport only when valid and changed", () => {
  const sized = { _tag: "freeform", width: 1280, height: 800 } as const;
  expect(viewportFromDimension("width", "1000", sized)).toEqual({ _tag: "freeform", width: 1000, height: 800 });
  expect(viewportFromDimension("width", "1280", sized)).toBe(null);
  expect(viewportFromDimension("width", "100", sized)).toBe(null);
  expect(viewportFromDimension("width", "abc", sized)).toBe(null);
  expect(viewportFromDimension("width", "3840", { _tag: "freeform", width: 1280, height: 2200 })).toBe(null);
});

test("rotate swaps width and height and the setting survives a round trip", () => {
  const rotated = rotateViewport({ _tag: "preset", presetId: "ipad-mini", width: 768, height: 1024 });
  expect(rotated).toEqual({ _tag: "preset", presetId: "ipad-mini", width: 1024, height: 768 });
  expect(parseViewport(serializeViewport(rotated))).toEqual(rotated);
});
