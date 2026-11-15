import { expect, test } from "nsh/test";
import {
  createTimelineFollow, createUpwardScrollDetector, FOLLOWING, initialTimelineFollow, isAtEnd, scrollToEndSummary,
  stepFollow, transitionTimelineFollow, type TimelineFollow,
} from "./timelineFollow";

test("follow transitions: navigating releases, reaching the end after leaving it re-arms", () => {
  expect(initialTimelineFollow(true)).toBe(FOLLOWING);
  expect(initialTimelineFollow(false)).toEqual({ mode: "released", atEnd: false });
  const released = transitionTimelineFollow(FOLLOWING, { type: "navigated" });
  expect(released).toEqual({ mode: "released", atEnd: true });
  // A scroll key at the end cannot re-arm: the list has to leave the end and come back.
  expect(transitionTimelineFollow(released, { type: "reachedEnd" })).toBe(released);
  const left = transitionTimelineFollow(released, { type: "leftEnd" });
  expect(left).toEqual({ mode: "released", atEnd: false });
  expect(transitionTimelineFollow(left, { type: "reachedEnd" })).toBe(FOLLOWING);
  expect(transitionTimelineFollow(left, { type: "followEnd" })).toBe(FOLLOWING);
  // While following, leaving the end band does nothing.
  expect(transitionTimelineFollow(FOLLOWING, { type: "leftEnd" })).toBe(FOLLOWING);
});

test("the end band is 40 points", () => {
  expect(isAtEnd({ top: 960, contentHeight: 1500, viewportHeight: 500 })).toBe(true);
  expect(isAtEnd({ top: 959, contentHeight: 1500, viewportHeight: 500 })).toBe(false);
  expect(isAtEnd({ top: 0, contentHeight: 0, viewportHeight: 0 })).toBe(true);
});

test("an upward move counts; a shrinking content or a downward move does not", () => {
  const detect = createUpwardScrollDetector({ top: 1000, height: 2000 });
  expect(detect({ top: 1000, height: 2200 })).toBe(false);
  expect(detect({ top: 900, height: 2200 })).toBe(true);
  expect(detect({ top: 800, height: 1500 })).toBe(false);
  expect(detect({ top: 900, height: 1500 })).toBe(false);
  // Sub-point moves add up.
  expect(detect({ top: 899.5, height: 1500 })).toBe(false);
  expect(detect({ top: 898, height: 1500 })).toBe(true);
  expect(detect({ top: 500, height: 1500, programmatic: true })).toBe(false);
});

test("streaming growth keeps following; scrolling up releases and shows the pill; returning re-arms", () => {
  let follow: TimelineFollow = FOLLOWING;
  // Content grew a frame before the follow scroll caught up: off the end, not scrolled up.
  let step = stepFollow(follow, { scrolledUp: false, atEnd: false, lastAtEnd: true });
  expect(step).toEqual({ follow: FOLLOWING, pill: "hide" });
  // The reader scrolls up out of the band.
  step = stepFollow(follow, { scrolledUp: true, atEnd: false, lastAtEnd: true });
  expect(step.follow).toEqual({ mode: "released", atEnd: false });
  expect(step.pill).toBe("show");
  follow = step.follow;
  // Further scrolling away leaves the pill as it is.
  expect(stepFollow(follow, { scrolledUp: true, atEnd: false, lastAtEnd: false }).pill).toBe("keep");
  // Back to the end band: following again, pill hidden.
  step = stepFollow(follow, { scrolledUp: false, atEnd: true, lastAtEnd: false });
  expect(step).toEqual({ follow: FOLLOWING, pill: "hide" });
  // A small upward nudge inside the band does not release.
  expect(stepFollow(FOLLOWING, { scrolledUp: true, atEnd: true, lastAtEnd: true })).toEqual({ follow: FOLLOWING, pill: "keep" });
});

test("the summary joins what waits at the end", () => {
  expect(scrollToEndSummary([null, null])).toBeNull();
  expect(scrollToEndSummary(["2 queued"])).toBe("2 queued");
  expect(scrollToEndSummary(["Waiting on a reply", "2 queued"])).toBe("Waiting on a reply · 2 queued");
});

test("the controller debounces showing the pill 150ms, hides at once, and scrollToEnd re-arms follow", async () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const pill = cell(false);
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: (options) => calls.push(options.animated), following, showPill: pill });
  controller.onScroll({ top: 1000, contentHeight: 1500, viewportHeight: 500 });
  expect(pill.get()).toBe(false);
  controller.beginUserScroll();
  controller.onScroll({ top: 400, contentHeight: 1500, viewportHeight: 500 });
  expect(following.get()).toBe(false);
  expect(pill.get()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pill.get()).toBe(true);
  controller.scrollToEnd(true);
  expect(calls).toEqual([true]);
  expect(following.get()).toBe(true);
  expect(pill.get()).toBe(false);
  controller.dispose();
});

test("an upward offset change that comes with a content-height change is layout, not the reader: follow holds", () => {
  const detect = createUpwardScrollDetector({ top: 1402, height: 2450 });
  // Rows above the viewport re-measured (a re-created page frame): the content grew and the offset moved up.
  expect(detect({ top: 1207, height: 3077 })).toBe(false);
  // The reader's wheel: same content height, the offset moves up.
  expect(detect({ top: 1100, height: 3077 })).toBe(true);
  // A wheel step while a reply streams (a small growth in the same event) still counts.
  expect(detect({ top: 1050, height: 3120 })).toBe(true);
});

test("pinned to the end, a layout change that leaves the end scrolls back to it and keeps following", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: (options) => calls.push(options.animated), following, showPill: cell(false) });
  controller.onScroll({ top: 1828, contentHeight: 2450, viewportHeight: 622 });
  // A page frame above was re-created and re-measured: the content grew, the offset moved up off the end.
  controller.onScroll({ top: 1207, contentHeight: 3077, viewportHeight: 622 });
  expect(following.get()).toBe(true);
  expect(calls).toEqual([false]);
  controller.dispose();
});

test("settling an animated scroll keeps the correction animated", async () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: (options) => calls.push(options.animated), following: cell(true), showPill: cell(false) });
  controller.onScroll({ top: 100, contentHeight: 1500, viewportHeight: 500 });
  controller.scrollToEnd(true);
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(calls).toEqual([true, true]);
  controller.onScroll({ top: 150, contentHeight: 1800, viewportHeight: 500 });
  expect(calls).toEqual([true, true]);
  controller.dispose();
});

test("row measurement and composer resizing do not interrupt an animated scroll", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: (options) => calls.push(options.animated), following: cell(true), showPill: cell(false) });
  controller.onScroll({ top: 100, contentHeight: 2000, viewportHeight: 500 });
  controller.scrollToEnd(true);
  controller.onScroll({ top: 250, contentHeight: 2300, viewportHeight: 480 });
  expect(calls).toEqual([true]);
  controller.dispose();
});

test("an unexplained upward layout correction does not release live follow", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: ({ animated }) => calls.push(animated), following, showPill: cell(false) });
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  // The virtual list corrects its measured offset without a user scroll event.
  controller.onScroll({ top: 1200, contentHeight: 2000, viewportHeight: 500 });
  expect(following.get()).toBe(true);
  expect(calls).toEqual([false]);
  // A real scroll interrupts that correction and releases follow.
  controller.beginUserScroll();
  controller.onScroll({ top: 1000, contentHeight: 2000, viewportHeight: 500 });
  expect(following.get()).toBe(false);
  controller.dispose();
});

test("after a user gesture ends, layout corrections cannot release follow again", async () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const controller = createTimelineFollow({ scrollToEnd: () => {}, following, showPill: cell(false) });
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  controller.beginUserScroll();
  controller.onScroll({ top: 1200, contentHeight: 2000, viewportHeight: 500 });
  expect(following.get()).toBe(false);
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  expect(following.get()).toBe(true);
  controller.endUserScroll();
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.onScroll({ top: 1200, contentHeight: 2000, viewportHeight: 500 });
  expect(following.get()).toBe(true);
  controller.dispose();
});

test("scrolling upward during streaming still releases follow", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const controller = createTimelineFollow({ scrollToEnd: () => {}, following, showPill: cell(false) });
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  controller.beginUserScroll();
  controller.onScroll({ top: 1350, contentHeight: 2020, viewportHeight: 500 });
  expect(following.get()).toBe(false);
  controller.dispose();
});

test("trackpad momentum remains user navigation until scrolling comes to rest", async () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: ({ animated }) => calls.push(animated), following, showPill: cell(false) });
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  controller.beginUserScroll();
  // A finger can lift before the platform reports scrolling at rest.
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.onScroll({ top: 1200, contentHeight: 2020, viewportHeight: 500 });
  expect(following.get()).toBe(false);
  expect(calls).toEqual([]);
  controller.endUserScroll();
  controller.dispose();
});

test("automatic corrections honor reduced motion", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: ({ animated }) => calls.push(animated), motionEnabled: () => false, following: cell(true), showPill: cell(false) });
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  controller.onScroll({ top: 1200, contentHeight: 2000, viewportHeight: 500 });
  expect(calls).toEqual([false]);
  controller.dispose();
});

test("a composer that grows shrinks the viewport: a list pinned to the end stays at the end, a released one stays put", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const following = cell(true);
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: (options) => calls.push(options.animated), following, showPill: cell(false) });
  controller.onScroll({ top: 1000, contentHeight: 1500, viewportHeight: 500 });
  controller.onScroll({ top: 1000, contentHeight: 1500, viewportHeight: 440 });
  expect(calls).toEqual([false]);
  // Released by the reader: no jump.
  controller.release();
  controller.onScroll({ top: 900, contentHeight: 1500, viewportHeight: 400 });
  expect(calls).toEqual([false]);
  controller.dispose();
});

test("navigationReleasesFollow: each input source releases follow only as the reference's timelineViewport says", async () => {
  const { navigationReleasesFollow } = await import("./timelineFollow");
  const at = (contentScrollsUp: boolean, awayFromEnd: boolean) => ({ contentScrollsUp: () => contentScrollsUp, awayFromEnd: () => awayFromEnd });
  expect(navigationReleasesFollow({ source: "wheel", direction: "up" }, at(true, false))).toBe(true);
  expect(navigationReleasesFollow({ source: "wheel", direction: "up" }, at(false, false))).toBe(false);
  expect(navigationReleasesFollow({ source: "wheel", direction: "down" }, at(true, true))).toBe(false);
  expect(navigationReleasesFollow({ source: "key", direction: "up" }, at(true, false))).toBe(true);
  expect(navigationReleasesFollow({ source: "key", direction: "down" }, at(true, false))).toBe(false);
  expect(navigationReleasesFollow({ source: "key", direction: "down" }, at(true, true))).toBe(true);
  expect(navigationReleasesFollow({ source: "pointer", onScrollbar: true }, at(true, false))).toBe(true);
  expect(navigationReleasesFollow({ source: "pointer", onScrollbar: false }, at(true, false))).toBe(false);
  expect(navigationReleasesFollow({ source: "touch" }, at(true, true))).toBe(true);
  expect(navigationReleasesFollow({ source: "scroll" }, at(false, false))).toBe(true);
  expect(navigationReleasesFollow({ source: "command", releasesFollow: false }, at(true, true))).toBe(false);
});

test("a PageDown at the live end keeps following; a PageUp with room above releases (controller.navigate)", async () => {
  const { createTimelineFollow } = await import("./timelineFollow");
  let following = true;
  let pill = false;
  const controller = createTimelineFollow({ scrollToEnd: () => {}, following: { get: () => following, set: (value) => { following = value; } }, showPill: { get: () => pill, set: (value) => { pill = value; } } });
  controller.onScroll({ top: 1000, contentHeight: 1600, viewportHeight: 600 });
  controller.navigate({ source: "key", direction: "down" });
  expect(controller.following()).toBe(true);
  controller.navigate({ source: "key", direction: "up" });
  expect(controller.following()).toBe(false);
  controller.dispose();
});


test("streaming layout recovery pins immediately instead of animating repeated scroll corrections", () => {
  const cell = <T>(initial: T) => { let value = initial; return { get: () => value, set: (next: T) => { value = next; } }; };
  const calls: boolean[] = [];
  const controller = createTimelineFollow({ scrollToEnd: ({ animated }) => calls.push(animated), following: cell(true), showPill: cell(false), motionEnabled: () => true });
  controller.onScroll({ top: 1500, contentHeight: 2000, viewportHeight: 500 });
  controller.onScroll({ top: 1500, contentHeight: 2400, viewportHeight: 500 });
  controller.onScroll({ top: 1900, contentHeight: 2800, viewportHeight: 500 });
  expect(calls).toEqual([false, false]);
  controller.dispose();
});
