// Motion constants and specs taken from the reference web app (apps/web/src). Every number here is
// quoted from the source named beside it; see workspace/animation-inventory.md for the full table.
import type { Easing, KeyframeValue, MotionSpec } from "nsh";

/** Tailwind v4 theme.css (tailwindcss@4.3.3): --ease-in / --ease-out / --ease-in-out. */
export const EASE_IN: Easing = [0.4, 0, 1, 1];
export const EASE_OUT: Easing = [0, 0, 0.2, 1];
export const EASE_IN_OUT: Easing = [0.4, 0, 0.2, 1];
/** Tailwind v4 --default-transition-timing-function, used by a bare `transition` / `transition-[...]`. */
export const EASE_DEFAULT: Easing = [0.4, 0, 0.2, 1];
/** index.css:195 --ease-drawer. */
export const EASE_DRAWER: Easing = [0.32, 0.72, 0, 1];
/** ui/toast.tsx:602 `[transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]`. */
export const EASE_TOAST: Easing = [0.22, 1, 0.36, 1];

/** Tailwind v4 --default-transition-duration. */
export const DURATION_DEFAULT_MS = 150;
/** ui/dialog-styles.ts:2,8 backdrop `transition-all duration-200`, popup `duration-200 ease-in-out`. */
export const DIALOG_MS = 200;
/** AppRouteModal.tsx:72 `transition-[opacity,scale] duration-150 ease-out`. */
export const ROUTE_MODAL_MS = 150;
/** ui/toast.tsx:602 transform and opacity .5s. */
export const TOAST_MS = 500;
/** ui/collapsible.tsx:29 and AnimatedHeight.tsx:86 `transition-[height] duration-200`. */
export const COLLAPSE_MS = 200;
/** Sidebar.motion.ts:1 `{ duration: 150, easing: "ease-out" }`. */
export const SIDEBAR_ROW_MS = 150;

/** The CSS `transition` rule's easing names for a style's `transitionTimingFunction`. */
export function cssEasing(easing: Easing): "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | `cubic-bezier(${string})` {
  if (Array.isArray(easing)) return `cubic-bezier(${easing.join(", ")})`;
  if (easing === "easeIn") return "ease-in";
  if (easing === "easeOut") return "ease-out";
  if (easing === "easeInOut") return "ease-in-out";
  if (easing === "linear" || easing === "ease") return easing;
  return "ease";
}

/**
 * Popover and tooltip popups (ui/popover.tsx:95, ui/tooltip.tsx:141, ui/preview-card.tsx:33):
 * `transition-[...scale,opacity]` with `data-starting-style:scale-98 data-starting-style:opacity-0`, no
 * duration class, so Tailwind's default 150ms and cubic-bezier(0.4, 0, 0.2, 1). No motion-reduce gate.
 */
export const popoverEnter: MotionSpec = {
  keyframes: { opacity: [0, 1], scale: [0.98, 1] },
  duration: DURATION_DEFAULT_MS,
  easing: EASE_DEFAULT,
  ignoreReduceMotion: true,
};
export const popoverExit: MotionSpec = { ...popoverEnter, keyframes: { opacity: [1, 0], scale: [1, 0.98] } };

/** Dialog popup (ui/dialog-styles.ts:8): scale .98 and opacity 0, 200ms ease-in-out. No motion-reduce gate. */
export const dialogEnter: MotionSpec = {
  keyframes: { opacity: [0, 1], scale: [0.98, 1] },
  duration: DIALOG_MS,
  easing: EASE_IN_OUT,
  ignoreReduceMotion: true,
};
export const dialogExit: MotionSpec = { ...dialogEnter, keyframes: { opacity: [1, 0], scale: [1, 0.98] } };

/**
 * The scale half of dialogEnter, for nsh/base Dialogs whose own `animation="fade"` already fades the
 * popup and backdrop (so opacity is not faded twice).
 */
export const dialogScaleEnter: MotionSpec = { ...dialogEnter, keyframes: { scale: [0.98, 1] } };
export const dialogScaleExit: MotionSpec = { ...dialogEnter, keyframes: { scale: [1, 0.98] } };

/** Dialog backdrop (ui/dialog-styles.ts:2): `transition-all duration-200`, opacity 0 at start and end; default easing. */
export const backdropEnter: MotionSpec = {
  keyframes: { opacity: [0, 1] },
  duration: DIALOG_MS,
  easing: EASE_DEFAULT,
  ignoreReduceMotion: true,
};
export const backdropExit: MotionSpec = { ...backdropEnter, keyframes: { opacity: [1, 0] } };

/** Full-window route modal (AppRouteModal.tsx:72): scale .985 and opacity, 150ms ease-out. */
export const routeModalEnter: MotionSpec = {
  keyframes: { opacity: [0, 1], scale: [0.985, 1] },
  duration: ROUTE_MODAL_MS,
  easing: EASE_OUT,
  ignoreReduceMotion: true,
};

/**
 * Toast entering from the bottom (ui/toast.tsx:626 `data-[position*=bottom]:data-starting-style:
 * translateY(calc(100%+var(--toast-inset)))`, transform and opacity .5s cubic-bezier(.22,1,.36,1)).
 * `travel` is the toast's height plus its inset in points.
 */
export function toastEnter(travel: number): MotionSpec {
  return { keyframes: { translateY: [travel, 0] }, duration: TOAST_MS, easing: EASE_TOAST, ignoreReduceMotion: true };
}
/** A top-right toast entering (ui/toast.tsx:627): translateX(calc(100%+var(--toast-inset))) to 0, .5s. */
export function toastEnterX(travel: number): MotionSpec {
  return { keyframes: { translateX: [travel, 0] }, duration: TOAST_MS, easing: EASE_TOAST, ignoreReduceMotion: true };
}
/** A top-right toast leaving (ui/toast.tsx:628,630): opacity 0 and the same translateX, .5s. */
export function toastExitX(travel: number): MotionSpec {
  return { keyframes: { opacity: [1, 0], translateX: [0, travel] }, duration: TOAST_MS, easing: EASE_TOAST, ignoreReduceMotion: true };
}
/** Toast leaving (ui/toast.tsx:628-629): opacity 0 and the same translate down, .5s. */
export function toastExit(travel: number): MotionSpec {
  return { keyframes: { opacity: [1, 0], translateY: [0, travel] }, duration: TOAST_MS, easing: EASE_TOAST, ignoreReduceMotion: true };
}

/** A stepped hold-and-ramp opacity loop: the shape of index.css's duty-cycled keyframes. */
function steppedOpacity(low: number, holdEnd: number, lowStart: number, lowEnd: number, steps: number): KeyframeValue[] {
  const ramp: Easing = { steps };
  return [
    { offset: 0, value: 1, easing: ramp },
    { offset: holdEnd, value: 1, easing: ramp },
    { offset: lowStart, value: low, easing: ramp },
    { offset: lowEnd, value: low, easing: ramp },
    { offset: 1, value: 1 },
  ];
}

/**
 * index.css:226,332 `--animate-status-pulse: status-pulse 2s infinite`: opacity 1 for 0-40%, 0.5 for
 * 50-90%, steps(6) ramps. Used with `motion-safe:` everywhere, so reduced motion keeps it still.
 */
export const statusPulse: MotionSpec = {
  keyframes: { opacity: steppedOpacity(0.5, 0.4, 0.5, 0.9, 6) },
  duration: 2000,
  iterations: "infinite",
};

/** index.css:223,295 `--animate-skeleton: skeleton 2.4s infinite`: 1 for 0-42%, 0.55 for 50-92%, steps(4). motion-safe. */
export const skeletonPulse: MotionSpec = {
  keyframes: { opacity: steppedOpacity(0.55, 0.42, 0.5, 0.92, 4) },
  duration: 2400,
  iterations: "infinite",
};

/**
 * index.css:227,347 `--animate-status-ping: status-ping 2s infinite`: opacity .9 scale .75 at 0%, then
 * opacity 0 scale 2 from 40% to 100%, steps(8) on the first segment. motion-safe.
 */
export const statusPing: MotionSpec = {
  keyframes: [
    { offset: 0, opacity: 0.9, scale: 0.75, easing: { steps: 8 } },
    { offset: 0.4, opacity: 0, scale: 2 },
    { offset: 1, opacity: 0, scale: 2 },
  ],
  duration: 2000,
  iterations: "infinite",
};

/** Tailwind `animate-pulse`: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite, opacity .5 at 50%. */
export const tailwindPulse: MotionSpec = {
  keyframes: { opacity: [1, 0.5, 1] },
  duration: 2000,
  easing: [0.4, 0, 0.6, 1],
  iterations: "infinite",
  // TimelineAssistantRows.tsx:125 uses it without motion-safe.
  ignoreReduceMotion: true,
};

/**
 * Panel motion (panelAnimations.ts usePanelAnimationSettings): active only when the user's
 * panelAnimationDurationMs (contracts settings.ts:155-164, 0..400, default 0) is above 0 and the system
 * does not ask for less motion. The default 0 means panels open and close at once.
 */
export function panelMotionActive(durationMs: number, reduceMotion: boolean): boolean {
  return durationMs > 0 && !reduceMotion;
}

/**
 * When each item of `ids` first appeared: kept for ids still present, `now` for new ones, dropped for ids that
 * left (so an id raised again later enters again). A toast slides in only within TOAST_MS of its arrival, so
 * one that comes to the front of the stack, or shows when the stack opens out, does not replay its enter.
 */
export function trackArrivals(previous: ReadonlyMap<string, number>, ids: readonly string[], now: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const id of ids) next.set(id, previous.get(id) ?? now);
  return next;
}

/** ui/toast.tsx:576 `sm:[--toast-inset:--spacing(8)]`: the viewport's inset, which a top-right toast travels past. */
export const TOAST_INSET = 32;

/**
 * `transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none`: the mount
 * fade of ThreadFindBar.tsx:65, ThreadNow.tsx:24 and ComposerBannerStack.tsx:31 (FADE_IN). Respects reduced motion.
 */
export const fadeInStart: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: 150, easing: EASE_OUT };
/** ExpandedImageDialog.tsx:219: the same fade at 140ms ease-out. */
export const imageFadeIn: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: 140, easing: EASE_OUT };

/** The items of `previous` whose key is not in `next`: what just left a list and should play its exit. */
export function departures<T>(previous: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const kept = new Set(next.map(key));
  return previous.filter((item) => !kept.has(key(item)));
}

/**
 * A toast behind the front one moving out of the closed stack (ui/toast.tsx:611-624: --toast-peek 12 pt per index,
 * --toast-scale 1 - index x .1, transform .5s cubic-bezier(.22,1,.36,1)). It starts where its peek sat: up by the toasts
 * above it (`aboveHeight`, their heights plus the 12 pt gaps, measured by the caller or estimated) less index x 12.
 */
export function toastStackExpand(index: number, aboveHeight: number = index * (TOAST_ESTIMATED_HEIGHT + 12)): MotionSpec {
  // Its content fades back in over the first 250ms of the .5s (ui/toast.tsx:678 transition-opacity duration-250).
  return {
    keyframes: [
      { offset: 0, translateY: -(aboveHeight - index * 12), scale: Math.max(0, 1 - index * 0.1), opacity: 0 },
      { offset: 0.5, opacity: 1 },
      { offset: 1, translateY: 0, scale: 1, opacity: 1 },
    ],
    duration: TOAST_MS,
    easing: EASE_TOAST,
    ignoreReduceMotion: true,
  };
}
/** A one-line toast's height in the port (py-2.5 + a 20 pt title line): the estimate used when heights are not measured. */
export const TOAST_ESTIMATED_HEIGHT = 40;

/**
 * index.css:2205-2215: while a reply streams (`.chat-markdown[data-streaming] > *`), each new block fades in, opacity
 * 600ms ease-out, inside `prefers-reduced-motion: no-preference` (so reduced motion keeps it still).
 */
export const streamingBlockFadeIn: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: 600, easing: EASE_OUT };

/**
 * ui/collapsible.tsx:29 / AnimatedHeight.tsx:86 grow the panel's height over 200ms (ease-out). NSH cannot animate a
 * height (a style transition on height or width jumps; checked in a fixture window), so the port fades the opened
 * content in over the same 200ms ease-out instead; it opens at full height at once and closes at once.
 */
export const collapseContentIn: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: COLLAPSE_MS, easing: EASE_OUT };

/** Sidebar.motion.ts:2-4: a row travels min(its height, 40) and at most 40 rows fade per update. */
export const sidebarRowTravel = (height: number) => Math.min(height, 40);
export const MAX_FADED_ROWS_PER_UPDATE = 40;

/**
 * Whether the rows that mounted together in one update enter with motion (Sidebar.motion.ts:145-149): not on the
 * list's first layout (no rows were there before), not for more than 40 at once, not with reduced motion.
 */
export function rowsEnter(rowsBefore: number, mountedTogether: number, reduceMotion: boolean): boolean {
  return rowsBefore > 0 && mountedTogether <= MAX_FADED_ROWS_PER_UPDATE && !reduceMotion;
}

/** Sidebar.motion.ts:117-122: a new row from opacity 0 and `travel` above to rest, 150ms ease-out. */
export function sidebarRowEnter(travel: number): MotionSpec {
  return { keyframes: { opacity: [0, 1], translateY: [-travel, 0] }, duration: SIDEBAR_ROW_MS, easing: EASE_OUT, ignoreReduceMotion: true };
}

/** index.css:230-232,314-330: the stash pulse is 1400ms, held to 85.7% (1200ms). */
export const STASH_PULSE_MS = 1400;
export const STASH_PULSE_HOLD_MS = Math.round(STASH_PULSE_MS * 0.857);
/** ComposerStashBadge.tsx:22: the count rises in, `starting:translate-y-0.5 starting:opacity-0`, 180ms ease-out, motion-reduce none. */
export const stashCountEnter: MotionSpec = { keyframes: { opacity: [0, 1], translateY: [2, 0] }, duration: 180, easing: EASE_OUT };

/** How far down the open stack a toast sits: the heights above it plus a `gap` (ui/toast.tsx --toast-gap 12 pt) after each. */
export function stackOffset(heightsAbove: readonly number[], gap: number): number {
  return heightsAbove.reduce((sum, height) => sum + height + gap, 0);
}

/**
 * A toast behind the front one going back into the closed stack (ui/toast.tsx:614-624, 678): from its open place
 * (`aboveHeight` down) up to its peek (index x 12 pt), scale to 1 - index x .1, .5s; its content fades in the first
 * 250ms (Toast.Content `transition-opacity duration-250`).
 */
export function toastStackCollapse(index: number, aboveHeight: number): MotionSpec {
  return {
    keyframes: [
      { offset: 0, translateY: 0, scale: 1, opacity: 1 },
      { offset: 0.5, opacity: 0 },
      { offset: 1, translateY: -(aboveHeight - index * 12), scale: Math.max(0, 1 - index * 0.1), opacity: 0 },
    ],
    duration: TOAST_MS,
    easing: EASE_TOAST,
    ignoreReduceMotion: true,
  };
}

/** A row kept on screen after it left its list (MotionEach): where it was and what it showed. */
export interface LeavingRow<T> { key: string; item: T; index: number }

/**
 * The rows MotionEach renders: the list as it is, with the rows that just left put back at the index they had, so
 * they can play their exit where they were (Sidebar.motion.ts fadeOut clones them in place).
 */
export function mergeLeaving<T>(next: readonly T[], key: (item: T) => string, leaving: readonly LeavingRow<T>[]): Array<{ key: string; item: T; leaving: boolean }> {
  const rows = next.map((item) => ({ key: key(item), item, leaving: false }));
  const present = new Set(rows.map((row) => row.key));
  for (const row of [...leaving].sort((a, b) => a.index - b.index)) {
    if (present.has(row.key)) continue;
    rows.splice(Math.min(row.index, rows.length), 0, { key: row.key, item: row.item, leaving: true });
  }
  return rows;
}

/** Sidebar.motion.ts:68-78: a leaving row fades to 0 while moving `travel` down, 150ms ease-out. */
export function sidebarRowExit(travel: number): MotionSpec {
  return { keyframes: { opacity: [1, 0], translateY: [0, travel] }, duration: SIDEBAR_ROW_MS, easing: EASE_OUT, ignoreReduceMotion: true };
}

/** Sidebar.motion.ts:80-90: a row that moved runs from its old place (`offset` = old top - new top) to rest, 150ms ease-out. */
export function sidebarRowMove(offset: number): MotionSpec {
  return { keyframes: { translateY: [offset, 0] }, duration: SIDEBAR_ROW_MS, easing: EASE_OUT, ignoreReduceMotion: true };
}
/** `opacity-0 transition-opacity group-hover:opacity-100` with no duration class (SidebarDraftBlock.tsx:117): Tailwind's default 150ms and curve, no motion-reduce gate. */
export const revealIn: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: DURATION_DEFAULT_MS, easing: EASE_DEFAULT, ignoreReduceMotion: true };
export const revealOut: MotionSpec = { ...revealIn, keyframes: { opacity: [1, 0] } };

/** ModelPickerSidebar.tsx:90 `transition-[top] duration-200 ease-out`: the selected-provider indicator slides from its old top (`delta` = old - new) to rest. No motion-reduce gate. */
export function railIndicatorMove(delta: number): MotionSpec {
  return { keyframes: { translateY: [delta, 0] }, duration: 200, easing: EASE_OUT, ignoreReduceMotion: true };
}
export const routeModalExit: MotionSpec = { ...routeModalEnter, keyframes: { opacity: [1, 0], scale: [1, 0.985] } };

/**
 * index.css:923-935 settings-search-target-pulse: an inset 2px ring of --primary at 70% that comes and goes,
 * 650ms ease-in-out, twice, rounded-xl; reduced motion has no pulse (the focus outline shows instead).
 */
export const searchTargetPulse: MotionSpec = { keyframes: { opacity: [0, 0.7, 0] }, duration: 650, easing: EASE_IN_OUT, iterations: 2 };

/** GitActionsControl.tsx:362,400: the progress output / success description line, grid-rows 0fr to 1fr and opacity, 200ms ease-out, motion-reduce none. The port fades it (height cannot animate). */
export const gitOutputReveal: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: 200, easing: EASE_OUT };

/** SidebarThreadUndoNotice.tsx:46: the notice fades in, opacity 200ms ease-out (`starting:opacity-0`); no reduce gate. */
export const undoNoticeFadeIn: MotionSpec = { keyframes: { opacity: [0, 1] }, duration: 200, easing: EASE_OUT, ignoreReduceMotion: true };
export const undoNoticeFadeOut: MotionSpec = { ...undoNoticeFadeIn, keyframes: { opacity: [1, 0] } };

/** A spec that leaves its view at rest (opacity 1, no transform): an enter for a view whose reference has none. */
export const MOTION_AT_REST: MotionSpec = { keyframes: { opacity: [1, 1] }, duration: 0 };

/** SidebarProviderUpdatePill.tsx:15,143: `duration-180 ease-drawer`; leaving: translate-y-1.5 and opacity 0. */
export const PROVIDER_PILL_MS = 180;
export const providerPillExit: MotionSpec = { keyframes: { opacity: [1, 0], translateY: [0, 6] }, duration: PROVIDER_PILL_MS, easing: EASE_DRAWER, ignoreReduceMotion: true };
/** SidebarProviderUpdatePill.tsx:155: the dismiss progress drains, scale-x 1 to 0 from the left, linear, over the visible time. */
export function dismissDrain(ms: number): MotionSpec {
  return { keyframes: { scaleX: [1, 0] }, duration: ms, easing: "linear", ignoreReduceMotion: true };
}

/** preview/ZoomIndicator.tsx:41: `transition-all duration-200 ease-out`, hidden at opacity 0 and -translate-y-1 (4pt). No reduce gate. */
export const zoomPillIn: MotionSpec = { keyframes: { opacity: [0, 1], translateY: [-4, 0] }, duration: 200, easing: EASE_OUT, ignoreReduceMotion: true };
export const zoomPillOut: MotionSpec = { ...zoomPillIn, keyframes: { opacity: [1, 0], translateY: [0, -4] } };

/**
 * index.css:2384-2411 .preview-loading-progress: while loading, scaleX .04 to .9 over 5.3s cubic-bezier(0.1,0.5,0.2,1)
 * (forwards); when done, scaleX to 1 over 150ms ease-out and opacity to 0 over 150ms after 220ms. Reduced motion: no
 * animation, parked at .9 while loading.
 */
export const previewLoadingRun: MotionSpec = { keyframes: { opacity: [1, 1], scaleX: [0.04, 0.9] }, duration: 5300, easing: [0.1, 0.5, 0.2, 1] };
export const previewLoadingDone: MotionSpec = {
  keyframes: [
    { offset: 0, opacity: 1 },
    { offset: 150 / 370, scaleX: 1, easing: EASE_OUT },
    { offset: 220 / 370, opacity: 1, easing: EASE_OUT },
    { offset: 1, scaleX: 1, opacity: 0 },
  ],
  duration: 370,
};
