import { expect, test } from "nsh/test";
import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll";

test("collapsing a pinned section anchors its heading without moving an unpinned heading", () => {
  expect(sectionCollapseAnchorScrollTop({ scrollTop: 400, viewportTop: 100, sectionTop: -50, headingTop: 100 })).toBe(250);
  expect(sectionCollapseAnchorScrollTop({ scrollTop: 100, viewportTop: 100, sectionTop: 110, headingTop: 110 })).toBeNull();
  expect(sectionCollapseAnchorScrollTop({ scrollTop: 100, viewportTop: 100, sectionTop: 90, headingTop: 103 })).toBeNull();
  expect(sectionCollapseAnchorScrollTop({ scrollTop: 20, viewportTop: 100, sectionTop: 0, headingTop: 100 })).toBe(0);
});
