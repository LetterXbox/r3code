// Follow mode of the transcript, ported from the web app's timelineViewport.ts (TimelineFollow, transition,
// navigationReleasesFollow), timelineScrollTarget.ts (createUpwardScrollDetector) and the pill rules of
// useTimelineFollow.ts. The web reads a DOM scroll node; here the input is NSH's List `onScroll` event.

/** MessagesTimeline.logic.ts TIMELINE_FOLLOW_REARM_THRESHOLD_PX: within this many points of the content's end counts as the end. */
export const TIMELINE_FOLLOW_REARM_THRESHOLD = 40;
/** useTimelineFollow.ts: showing the pill is debounced 150ms so it does not flash while a thread settles; hiding is immediate. */
export const SCROLL_PILL_DEBOUNCE_MS = 150;
/** An off-the-end distance one layout event can open while pinned that a reader's wheel step does not (points). */
export const LAYOUT_JUMP_THRESHOLD = 120;

export type TimelineFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean };

export type TimelineFollowEvent =
  | { readonly type: "navigated" }
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" };

export const FOLLOWING: TimelineFollow = { mode: "following" };

export function initialTimelineFollow(followEnd: boolean): TimelineFollow {
  return followEnd ? FOLLOWING : { mode: "released", atEnd: false };
}

export function transitionTimelineFollow(state: TimelineFollow, event: TimelineFollowEvent): TimelineFollow {
  switch (event.type) {
    case "navigated":
      return state.mode === "released" ? state : { mode: "released", atEnd: true };
    case "followEnd":
      return FOLLOWING;
    case "reachedEnd":
      // Navigating away while still at the end stays released until the list reports leaving and returning.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
    case "leftEnd":
      // While following, the list leaves the end band for a frame on every streamed chunk.
      return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
  }
}

export interface ScrollMetrics {
  /** Content offset (top of the viewport in the content). */
  readonly top: number;
  readonly contentHeight: number;
  readonly viewportHeight: number;
}

export function distanceFromEnd(metrics: ScrollMetrics): number {
  return metrics.contentHeight - metrics.top - metrics.viewportHeight;
}

/** resolveTimelineIsAtEnd: an unmeasured list is not away from the end. */
export function isAtEnd(metrics: ScrollMetrics): boolean {
  if (metrics.contentHeight <= 0 || metrics.viewportHeight <= 0) return true;
  return distanceFromEnd(metrics) <= TIMELINE_FOLLOW_REARM_THRESHOLD;
}

/** createUpwardScrollDetector: an upward move of more than a point while the content did not shrink (a shrink clamps the offset). */
export function createUpwardScrollDetector(initial: { top: number; height: number } = { top: 0, height: 0 }) {
  let baseline = initial;
  return (next: { top: number; height: number; programmatic?: boolean }): boolean => {
    // The web releases follow on user input only (wheel, keys, pointer, touch: timelineViewport.ts navigationReleasesFollow).
    // NSH's List reports offsets, not input, so an offset change in the same event as a large content-height change is
    // layout (rows measured or re-created above the viewport, a page frame re-measured), not the reader: it never
    // releases. A streamed chunk grows the content by far less, so a wheel step during streaming still releases.
    if (next.programmatic || next.height < baseline.height || Math.abs(next.height - baseline.height) > LAYOUT_JUMP_THRESHOLD || next.top > baseline.top) {
      baseline = { top: next.top, height: next.height };
      return false;
    }
    if (next.top < baseline.top - 1) {
      baseline = { top: next.top, height: next.height };
      return true;
    }
    // A slow scroll can move under a point per event; let those moves add up.
    baseline = { top: baseline.top, height: next.height };
    return false;
  };
}

/** What a scroll event changes: the follow transitions to apply, in order, and whether the pill is shown now, later, or hidden. */
export interface FollowStep {
  readonly follow: TimelineFollow;
  /** "show" waits out the debounce; "hide" is immediate; "keep" leaves the pill as it is. */
  readonly pill: "show" | "hide" | "keep";
}

/**
 * onIsAtEndChange + the "scroll" navigation: `scrolledUp` is the user moving the transcript up, `atEnd` the new
 * end state, `lastAtEnd` the previous one. A reader pinned to the end who is only briefly off it (streaming growth)
 * keeps following; only an upward move away from the end releases.
 */
export function stepFollow(
  follow: TimelineFollow,
  input: { readonly scrolledUp: boolean; readonly atEnd: boolean; readonly lastAtEnd: boolean },
): FollowStep {
  let next = follow;
  if (input.scrolledUp && !input.atEnd) next = transitionTimelineFollow(next, { type: "navigated" });
  if (input.atEnd === input.lastAtEnd && next === follow) return { follow, pill: "keep" };
  if (input.atEnd !== input.lastAtEnd) {
    if (!input.atEnd && next.mode === "following") return { follow: next, pill: "hide" };
    const after = transitionTimelineFollow(next, { type: input.atEnd ? "reachedEnd" : "leftEnd" });
    next = after;
    if (after.mode === "following") return { follow: after, pill: "hide" };
    return { follow: after, pill: after.atEnd ? "keep" : "show" };
  }
  // Released by a move that did not change the end state: the pill follows the end state.
  return { follow: next, pill: next.mode === "released" && !input.atEnd ? "show" : "keep" };
}

/** timelineViewport.ts TimelineNavigation: the input that moved (or may move) the transcript. */
export type TimelineNavigation =
  | { readonly source: "wheel"; readonly direction: "up" | "down" }
  | { readonly source: "key"; readonly direction: "up" | "down" }
  | { readonly source: "pointer"; readonly onScrollbar: boolean }
  | { readonly source: "touch" }
  | { readonly source: "scroll" }
  | { readonly source: "command"; readonly releasesFollow: boolean };

/**
 * timelineViewport.ts navigationReleasesFollow: whether a navigation can carry the viewport away from the live edge.
 * Downward input counts only outside the end band (streaming growth makes the end flicker off for a frame).
 */
export function navigationReleasesFollow(navigation: TimelineNavigation, viewport: { readonly contentScrollsUp: () => boolean; readonly awayFromEnd: () => boolean }): boolean {
  switch (navigation.source) {
    case "wheel": return navigation.direction === "up" && viewport.contentScrollsUp();
    case "key": return navigation.direction === "up" ? viewport.contentScrollsUp() : viewport.awayFromEnd();
    case "pointer": return navigation.onScrollbar ? viewport.contentScrollsUp() : viewport.awayFromEnd();
    case "touch": return viewport.awayFromEnd();
    case "scroll": return true;
    case "command": return navigation.releasesFollow;
  }
}

/** ScrollToEndButton's summary: what waits at the end of the transcript, joined with a middle dot. */
export function scrollToEndSummary(parts: ReadonlyArray<string | null>): string | null {
  return parts.filter((part): part is string => part !== null && part !== "").join(" · ") || null;
}

export interface TimelineFollowController {
  readonly following: () => boolean;
  readonly showPill: () => boolean;
  /** The List's `onScroll`. */
  readonly onScroll: (metrics: ScrollMetrics) => void;
  /** The platform reports the start and end of a wheel, touchpad or scrollbar gesture. */
  readonly beginUserScroll: () => void;
  readonly endUserScroll: () => void;
  /** The pill pressed, or a new message sent while following: re-arms follow and scrolls to the end. */
  readonly scrollToEnd: (animated: boolean) => void;
  /** A scroll command moved away from the end on purpose (search or find jump). */
  readonly release: () => void;
  /** useTimelineFollow handleNavigation: an input releases follow only as navigationReleasesFollow says. */
  readonly navigate: (navigation: TimelineNavigation) => void;
  /** A thread switch: follows the end again and hides the pill. */
  readonly reset: () => void;
  readonly dispose: () => void;
}

/** The imperative shell of the follow rules; `signals` carry the two values the view reads. */
export function createTimelineFollow(io: {
  readonly scrollToEnd: (options: { animated: boolean }) => void;
  readonly motionEnabled?: () => boolean;
  readonly following: { get(): boolean; set(value: boolean): void };
  readonly showPill: { get(): boolean; set(value: boolean): void };
}): TimelineFollowController {
  let follow: TimelineFollow = FOLLOWING;
  let lastAtEnd = true;
  let lastDistance = 0;
  let lastViewport: number | null = null;
  let lastMetrics: ScrollMetrics | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let scrollingToEnd = false;
  let userScrolling = false;
  let userScrollEnd: ReturnType<typeof setTimeout> | undefined;
  const cancelSettle = () => { clearTimeout(settle); settle = undefined; scrollingToEnd = false; };
  let detector = createUpwardScrollDetector();
  const publish = () => io.following.set(follow.mode === "following");
  const cancelPill = () => { clearTimeout(timer); timer = undefined; };
  const hide = () => { cancelPill(); io.showPill.set(false); };
  const show = () => {
    if (timer !== undefined || io.showPill.get()) return;
    timer = setTimeout(() => { timer = undefined; io.showPill.set(true); }, SCROLL_PILL_DEBOUNCE_MS);
  };
  const moveToEnd = (animated: boolean) => {
    cancelSettle();
    scrollingToEnd = animated;
    io.scrollToEnd({ animated });
    // Keep the animation protected during a second correction, too: measured rows can move the end mid-flight.
    settle = setTimeout(() => {
      settle = undefined;
      if (follow.mode !== "following" || lastDistance <= 2) { scrollingToEnd = false; return; }
      io.scrollToEnd({ animated });
      if (!animated) { scrollingToEnd = false; return; }
      settle = setTimeout(() => { scrollingToEnd = false; settle = undefined; }, 400);
    }, animated ? 400 : 120);
  };
  return {
    following: () => io.following.get(),
    showPill: () => io.showPill.get(),
    onScroll(metrics) {
      const previouslyMeasured = lastMetrics !== null;
      lastMetrics = metrics;
      const atEnd = isAtEnd(metrics);
      const scrolledUp = detector({ top: metrics.top, height: metrics.contentHeight, programmatic: !userScrolling });
      lastDistance = distanceFromEnd(metrics);
      const step = stepFollow(follow, { scrolledUp, atEnd, lastAtEnd });
      lastAtEnd = atEnd;
      follow = step.follow;
      publish();
      // A changed row or a taller composer can move the end away without a user gesture.
      const viewportShrank = lastViewport !== null && metrics.viewportHeight > 0 && metrics.viewportHeight < lastViewport - 0.5;
      lastViewport = metrics.viewportHeight;
      if (previouslyMeasured && !userScrolling && !scrollingToEnd && follow.mode === "following" && !atEnd && (lastDistance > LAYOUT_JUMP_THRESHOLD || viewportShrank)) {
        // Native anchoring already follows changing row measurements in the layout commit.
        // Animate only an explicit navigation action: animating recovery chases a moving
        // endpoint for 400ms and visibly slides the transcript on each tool update.
        moveToEnd(false);
      }
      if (step.pill === "hide") hide();
      else if (step.pill === "show") show();
    },
    beginUserScroll() {
      clearTimeout(userScrollEnd);
      userScrolling = true;
      cancelSettle();
    },
    endUserScroll() {
      clearTimeout(userScrollEnd);
      // The last scroll report may arrive on the frame after the gesture ends.
      userScrollEnd = setTimeout(() => { userScrolling = false; userScrollEnd = undefined; }, 100);
    },
    scrollToEnd(animated) {
      clearTimeout(userScrollEnd);
      userScrolling = false;
      follow = transitionTimelineFollow(follow, { type: "followEnd" });
      lastAtEnd = true;
      publish();
      hide();
      moveToEnd(animated);
    },
    release() {
      cancelSettle();
      follow = transitionTimelineFollow(follow, { type: "navigated" });
      publish();
    },
    navigate(navigation) {
      // timelineRealContentOverflowsViewport / resolveTimelineIsAtEnd from the last measured scroll.
      const contentScrollsUp = () => lastMetrics !== null && lastMetrics.contentHeight > lastMetrics.viewportHeight + 1 && lastMetrics.top > 0;
      const awayFromEnd = () => lastMetrics !== null && !isAtEnd(lastMetrics);
      if (!navigationReleasesFollow(navigation, { contentScrollsUp, awayFromEnd })) return;
      cancelSettle();
      follow = transitionTimelineFollow(follow, { type: "navigated" });
      publish();
    },
    reset() {
      cancelSettle();
      clearTimeout(userScrollEnd);
      userScrolling = false;
      lastMetrics = null;
      lastViewport = null;
      detector = createUpwardScrollDetector();
      follow = FOLLOWING;
      lastAtEnd = true;
      lastDistance = 0;
      publish();
      hide();
    },
    dispose() { cancelPill(); cancelSettle(); clearTimeout(userScrollEnd); },
  };
}
