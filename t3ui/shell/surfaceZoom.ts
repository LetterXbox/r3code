// R3 addition (not in t3code): per-surface text zoom. Cmd+= / Cmd+- / Cmd+0 over a diff or a file preview scale that
// surface's code text only, and each surface remembers its own scale across launches. Anywhere else the same keys
// keep driving the whole-app zoom (appZoom.ts); a focused browser preview keeps its own page zoom.
import { signal, Storage } from "nsh";
import type { ZoomDirection } from "./appZoom";

export type ZoomSurface = "diff" | "files";

export const SURFACE_ZOOM_STORAGE_KEY = "surface_zoom";
const STEP = 1.1;
const MIN = 0.6;
const MAX = 2.5;

const scales = signal<Partial<Record<ZoomSurface, number>>>({});
const hovered = signal<ZoomSurface | null>(null);

/** The scale of one surface's text (1 = the code size from settings and app zoom). */
export const surfaceScale = (surface: ZoomSurface): number => scales()[surface] ?? 1;

/** `size` scaled for `surface`, rounded to a whole point. */
export const scaledFor = (surface: ZoomSurface, size: number): number => Math.max(6, Math.round(size * surfaceScale(surface)));

/** Spread on a surface's root view: the pointer over it makes it the zoom target. */
export function surfaceZoomTarget(surface: ZoomSurface) {
  return {
    onMouseEnter: () => hovered.set(surface),
    onMouseLeave: () => { if (hovered() === surface) hovered.set(null); },
  };
}

export function nextSurfaceScale(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 1;
  const next = direction === "in" ? current * STEP : current / STEP;
  // Snap near 1 so in-then-out lands exactly back at the default.
  const snapped = Math.abs(next - 1) < 0.01 ? 1 : Math.round(next * 100) / 100;
  return Math.min(MAX, Math.max(MIN, snapped));
}

/** Zooms the surface under the pointer; false when there is none, so the caller can zoom the app instead. */
export function zoomHoveredSurface(direction: ZoomDirection): boolean {
  const surface = hovered();
  if (!surface) return false;
  const next = nextSurfaceScale(surfaceScale(surface), direction);
  scales.update((all) => {
    const { [surface]: _previous, ...rest } = all;
    return next === 1 ? rest : { ...rest, [surface]: next };
  });
  void Storage.setItem(SURFACE_ZOOM_STORAGE_KEY, JSON.stringify(scales())).catch(() => {});
  return true;
}

let loading: Promise<void> | null = null;
export function loadSurfaceZoom(): Promise<void> {
  loading ??= (async () => {
    try {
      const raw = await Storage.getItem(SURFACE_ZOOM_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const next: Partial<Record<ZoomSurface, number>> = {};
      for (const key of ["diff", "files"] as const) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value)) next[key] = Math.min(MAX, Math.max(MIN, value));
      }
      scales.set(next);
    } catch { /* a corrupt blob keeps the defaults */ }
  })();
  return loading;
}
void loadSurfaceZoom();
