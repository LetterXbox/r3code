import { expect, test } from "nsh/test";
import { fitDeviceFrame } from "./deviceFrameLayout";

test("a tall box fits by height when the aspect frame is narrow enough", () => {
  expect(fitDeviceFrame(0.5, 400, 800, 0)).toEqual({ width: 400, height: 800 });
  expect(fitDeviceFrame(0.5, 600, 800, 0)).toEqual({ width: 400, height: 800 });
});

test("a wide frame is limited by the available width", () => {
  expect(fitDeviceFrame(2, 400, 800, 0)).toEqual({ width: 400, height: 200 });
});

test("the right inset is taken off the width before fitting", () => {
  expect(fitDeviceFrame(0.5, 500, 800, 100)).toEqual({ width: 400, height: 800 });
  expect(fitDeviceFrame(1, 500, 800, 200)).toEqual({ width: 300, height: 300 });
});

test("no room gives an empty frame", () => {
  expect(fitDeviceFrame(0.5, 100, 800, 100)).toEqual({ width: 0, height: 0 });
  expect(fitDeviceFrame(0.5, 100, 800, 150)).toEqual({ width: 0, height: 0 });
  expect(fitDeviceFrame(0.5, 400, 0, 0)).toEqual({ width: 0, height: 0 });
});
