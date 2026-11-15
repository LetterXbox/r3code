// The whole-app zoom (apps/desktop/src/window/DesktopWindow.ts `zoomWindow`): View > Zoom In / Zoom Out / Actual Size and Cmd+= / Cmd+- / Cmd+0
// move the zoom level by 0.5 per press and 0 resets it; Chromium turns a level into a factor of 1.2 ** level, keeps it between 0.25x and 5x and
// remembers it across launches. NSH has no window or root scale, so the factor reaches the text the app sizes itself (typography.ts: the interface
// text style of the shell root and the prompt, code and terminal sizes), and the level is saved in Storage so it survives a restart.
import { signal, Storage } from "nsh";

export const APP_ZOOM_STORAGE_KEY = "app_zoom_level";
export const ZOOM_LEVEL_STEP = 0.5;
const FACTOR_BASE = 1.2;
const MIN_FACTOR = 0.25;
const MAX_FACTOR = 5;
export const MIN_ZOOM_LEVEL = Math.ceil(Math.log(MIN_FACTOR) / Math.log(FACTOR_BASE) / ZOOM_LEVEL_STEP) * ZOOM_LEVEL_STEP;
export const MAX_ZOOM_LEVEL = Math.floor(Math.log(MAX_FACTOR) / Math.log(FACTOR_BASE) / ZOOM_LEVEL_STEP) * ZOOM_LEVEL_STEP;

export type ZoomDirection = "in" | "out" | "reset";

const level = signal(0);

export const appZoomLevel = () => level();
/** Chromium's factor for a zoom level. */
export const zoomFactorOf = (zoomLevel: number): number => FACTOR_BASE ** zoomLevel;
export const appZoomFactor = () => zoomFactorOf(level());

/** The level a press of `direction` leads to from `current` (reset is 0; in and out move 0.5 and stay in range). */
export function nextZoomLevel(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 0;
  const next = current + (direction === "in" ? ZOOM_LEVEL_STEP : -ZOOM_LEVEL_STEP);
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, next));
}

function persist(next: number) {
  // The default is no override: nothing is kept for it.
  if (next === 0) void Storage.removeItem(APP_ZOOM_STORAGE_KEY).catch(() => {});
  else void Storage.setItem(APP_ZOOM_STORAGE_KEY, String(next)).catch(() => {});
}

/** zoomMain: moves the zoom one step (or back to Actual Size) and saves it. */
export function zoomApp(direction: ZoomDirection) {
  const next = nextZoomLevel(level(), direction);
  if (next === level()) return;
  level.set(next);
  persist(next);
}

/** A text size scaled by the zoom, kept to whole points. */
export const zoomedSize = (size: number): number => Math.max(1, Math.round(size * appZoomFactor()));

let loading: Promise<void> | null = null;
export function loadAppZoom(): Promise<void> {
  loading ??= (async () => {
    try {
      const raw = await Storage.getItem(APP_ZOOM_STORAGE_KEY);
      const parsed = raw === null || raw === undefined ? NaN : Number(raw);
      if (Number.isFinite(parsed)) level.set(Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(parsed / ZOOM_LEVEL_STEP) * ZOOM_LEVEL_STEP)));
    } catch {
      // A damaged value is the same as none.
    }
  })();
  return loading;
}

/** Tests only: the level without touching Storage. */
export function setAppZoomLevelForTest(next: number) { level.set(next); }

void loadAppZoom();
