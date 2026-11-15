import { expect, test } from "nsh/test";
import { composerPageScrollKey, pageScrollTarget, registerTimelinePageScroll, scrollTimelineByPage } from "./pageScroll";

test("timeline page scroll: steps one page less the alignment offset and padding", () => {
  expect(pageScrollTarget({ top: 1000, contentHeight: 5000, viewportHeight: 600 }, "PageUp", 24)).toBe(1000 - 540);
  expect(pageScrollTarget({ top: 1000, contentHeight: 5000, viewportHeight: 600 }, "PageDown")).toBe(1564);
});
test("timeline page scroll: clamps and stops at the ends", () => {
  expect(pageScrollTarget({ top: 0, contentHeight: 5000, viewportHeight: 600 }, "PageUp")).toBeNull();
  expect(pageScrollTarget({ top: 4400, contentHeight: 5000, viewportHeight: 600 }, "PageDown")).toBeNull();
  expect(pageScrollTarget({ top: 100, contentHeight: 5000, viewportHeight: 600 }, "PageUp")).toBe(0);
  expect(pageScrollTarget({ top: 4000, contentHeight: 5000, viewportHeight: 600 }, "PageDown")).toBe(4400);
});
test("timeline page scroll: only plain page keys are handed on", () => {
  expect(composerPageScrollKey("PageUp")).toBe("PageUp");
  expect(composerPageScrollKey("Shift-PageUp")).toBeNull();
});
test("timeline page scroll: routes to the registered timeline", () => {
  expect(scrollTimelineByPage("PageDown")).toBe(false);
  const seen: string[] = [];
  const off = registerTimelinePageScroll((key) => { seen.push(key); return true; });
  expect(scrollTimelineByPage("PageDown")).toBe(true);
  off();
  expect(scrollTimelineByPage("PageUp")).toBe(false);
  expect(seen).toEqual(["PageDown"]);
});

