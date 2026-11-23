// The panel animation setting as the components read it (panelAnimations.ts usePanelAnimationSettings): the user's
// `panelAnimationDurationMs` (contracts settings.ts:155-164, 0..400; R3 defaults to 225, 0 = instant) and the fades that follow it.
import type { MotionSpec } from "nsh";
import { LayoutAnimation, reduceMotion, untracked } from "nsh";
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
  return Number(settingValue("panelAnimationDurationMs") ?? 225);
}

/** `motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out` (PanelLayoutControls.tsx:198). */
export const panelFade = (ms: number): MotionSpec => ({ keyframes: { opacity: [0, 1] }, duration: ms, easing: EASE_OUT });

/** Configures LayoutAnimation for a panel or terminal drawer open/close/maximize commit using `panelAnimationMs()`. */
export function animatePanelLayout(ms: number = panelAnimationMs()): boolean {
  if (ms <= 0) return false;
  LayoutAnimation.configureNext({
    duration: ms,
    update: { type: "easeOut", duration: ms },
    create: { type: "easeOut", property: "opacity", duration: ms },
    delete: { type: "easeOut", property: "opacity", duration: ms },
  });
  return true;
}
