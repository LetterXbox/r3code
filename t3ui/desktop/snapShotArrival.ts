// What the composer does differently for a SnapShot attachment (chat/ComposerAttachmentStrip.tsx SnapShotAttachmentFrame,
// lib/snapShotAnimation.ts shouldAnimateSnapShotArrival): a wide 208 x 112 tile instead of the 64pt square, its close button
// revealed on hover, and, for a capture under 10 seconds old, an arrival (scale .95 and opacity 0 to rest, 300ms ease-drawer).
//
// The port's capture (snapShotCapture.ts) attaches through the composer's file intake, which knows a file only by its name, so
// the capture records its file's name and capture time here and the tile asks. The source strip (app icon, name, window title,
// accessibility) comes from snapShotSource.ts. Not ported: the fly-in from the captured window to the tile (SnapShotTransition.ts,
// a transparent always-on-top Electron window crossing the screen), because the NSH host has no API for a second borderless
// window over other apps.
import { reduceMotion, type MotionSpec } from "nsh";
import { EASE_DRAWER } from "../components/motion/motionTokens";
import { enterStyle } from "../components/motion/Motion";
import { snapShotSettings } from "./snapShot";

/** lib/snapShotAnimation.ts ARRIVAL_MAX_AGE_MS. */
export const SNAP_SHOT_ARRIVAL_MAX_AGE_MS = 10_000;
/** ComposerAttachmentStrip.tsx:98 `duration-300 ease-drawer starting:scale-95 starting:opacity-0`. */
export const snapShotArrival: MotionSpec = { keyframes: { opacity: [0, 1], scale: [0.95, 1] }, duration: 300, easing: EASE_DRAWER };

const MAX_REMEMBERED = 50;
const captures = new Map<string, string>();

/** Records that the file `name` was captured at `capturedAt` (an ISO time). */
export function markSnapShotCapture(name: string, capturedAt: string): void {
  captures.delete(name);
  captures.set(name, capturedAt);
  while (captures.size > MAX_REMEMBERED) captures.delete(captures.keys().next().value as string);
}

export function isSnapShotAttachment(name: string): boolean {
  return captures.has(name);
}

/** shouldAnimateSnapShotArrival: a capture made no more than 10s before `now`. */
export function shouldAnimateSnapShotArrival(capturedAt: string, now = Date.now()): boolean {
  const age = now - Date.parse(capturedAt);
  return Number.isFinite(age) && age >= 0 && age <= SNAP_SHOT_ARRIVAL_MAX_AGE_MS;
}

/** Whether the tile of the attachment `name` should play its arrival now (the setting is on and the capture is fresh). */
export function snapShotArrivalDue(name: string, now = Date.now()): boolean {
  const capturedAt = captures.get(name);
  // SnapShotCoordinator: animateCaptures && !matchMedia("(prefers-reduced-motion: reduce)").matches.
  return capturedAt !== undefined && snapShotSettings().snapShotAnimations && !reduceMotion() && shouldAnimateSnapShotArrival(capturedAt, now);
}

/** The tile's motion style: plays the arrival once when the tile mounts and the capture is fresh. Call it in the tile's scope. */
export function snapShotArrivalStyle(name: string) {
  return enterStyle(snapShotArrival, () => snapShotArrivalDue(name));
}
