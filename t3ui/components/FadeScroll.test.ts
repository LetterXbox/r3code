// ui/scroll-area.tsx scrollFade: 1.5rem fades sized by the overflow on each side.
import { expect, test } from "nsh/test";
import { scrollFadeMask } from "./FadeScroll";

const at = (y: number, content = 1000, height = 300) => ({ offset: { x: 0, y }, contentSize: { width: 100, height: content }, size: { width: 100, height } });

test("no overflow, no mask; at the top only the bottom fades; in the middle both; near an end the fade shrinks", () => {
  expect(scrollFadeMask(at(0, 200))).toBeUndefined();
  expect(scrollFadeMask(at(0))).toBe("linear-gradient(to bottom, transparent 0px, black 0px, black 276px, transparent 300px)");
  expect(scrollFadeMask(at(400))).toBe("linear-gradient(to bottom, transparent 0px, black 24px, black 276px, transparent 300px)");
  expect(scrollFadeMask(at(690))).toBe("linear-gradient(to bottom, transparent 0px, black 24px, black 290px, transparent 300px)");
  expect(scrollFadeMask(at(700))).toBe("linear-gradient(to bottom, transparent 0px, black 24px, black 300px, transparent 300px)");
});

test("a horizontal strip fades left and right", () => {
  expect(scrollFadeMask({ offset: { x: 10, y: 0 }, contentSize: { width: 600, height: 0 }, size: { width: 400, height: 0 } }, 24, "x")).toBe("linear-gradient(to right, transparent 0px, black 10px, black 376px, transparent 400px)");
});

test("scrollFadeAmounts detects initial overflow, clamps overscroll, and returns zero when content fits", async () => {
  const { fadeGradientStyle, resolveFadeColor, scrollFadeAmounts } = await import("./FadeScroll");
  expect(scrollFadeAmounts(null)).toEqual({ start: 0, end: 0 });
  expect(scrollFadeAmounts(at(0, 200))).toEqual({ start: 0, end: 0 });
  expect(scrollFadeAmounts(at(0, 1000))).toEqual({ start: 0, end: 24 });
  expect(scrollFadeAmounts(at(-20, 1000))).toEqual({ start: 0, end: 24 });
  expect(scrollFadeAmounts(at(400, 1000))).toEqual({ start: 24, end: 24 });
  expect(scrollFadeAmounts(at(690, 1000))).toEqual({ start: 24, end: 10 });
  expect(scrollFadeAmounts(at(720, 1000))).toEqual({ start: 24, end: 0 });
  expect(scrollFadeAmounts({ offset: { x: 10, y: 0 }, contentSize: { width: 600, height: 0 }, size: { width: 400, height: 0 } }, 24, "x")).toEqual({ start: 10, end: 24 });
  expect(fadeGradientStyle("bottom", "#101418")).toEqual({ backgroundImage: "linear-gradient(to bottom, rgba(16,20,24,0) 0px, #101418 100%)" });
  expect(fadeGradientStyle("right", "rgba(30, 40, 50, 0.8)")).toEqual({ backgroundImage: "linear-gradient(to right, rgba(30,40,50,0) 0px, rgba(30, 40, 50, 0.8) 100%)" });
  expect(resolveFadeColor(undefined, () => "#abcdef")).toBe("#abcdef");
});
