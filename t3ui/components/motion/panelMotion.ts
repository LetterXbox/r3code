// The panel animation setting as the components read it (panelAnimations.ts usePanelAnimationSettings): the user's
// `panelAnimationDurationMs` (contracts settings.ts:155-164, 0..400, default 0) and the fades that follow it.
import type { MotionSpec } from "nsh";
import { reduceMotion, untracked } from "nsh";
import { openThread, settingValue } from "../../store";
import { EASE_OUT } from "./motionTokens";

// usePanelAnimationSettings: no panel motion while the OS asks for reduced motion, nor for the two frames after a
// navigation (usePanelNavigationSuppression), so switching threads does not replay a panel's entrance.
const NAVIGATION_SUPPRESSION_MS = 34;
let paintedThreadId: string | null | undefined;
let navigatedAt = 0;
export function panelAnimationMs(now: number = Date.now()): number {
  const threadId = untracked(() => openThread()?.id ?? null);
  if (threadId !== paintedThreadId) {
    if (paintedThreadId !== undefined) navigatedAt = now;
    paintedThreadId = threadId;
  }
  if (reduceMotion() || now - navigatedAt < NAVIGATION_SUPPRESSION_MS) return 0;
  return Number(settingValue("panelAnimationDurationMs") ?? 0);
}

/** `motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out` (PanelLayoutControls.tsx:198). */
export const panelFade = (ms: number): MotionSpec => ({ keyframes: { opacity: [0, 1] }, duration: ms, easing: EASE_OUT });
