// reopenClosedView.ts:122-140 (view.snapshot.viewport): a browser tab's device viewport, remembered while the tab is
// open so that closing it keeps the size and reopening it (view.reopenClosed) brings it back.
import type { ViewportSetting } from "../browser/viewportLogic";

const viewports = new Map<string, ViewportSetting>();

export function recordTabViewport(surfaceId: string, viewport: ViewportSetting): void {
  viewports.set(surfaceId, viewport);
}

export function tabViewport(surfaceId: string): ViewportSetting | undefined {
  return viewports.get(surfaceId);
}

/** A saved viewport is kept only when it has the fields its kind needs. */
export function isViewportSetting(value: unknown): value is ViewportSetting {
  const v = value as Partial<{ kind: string; width: number; height: number; presetId: string }> | null;
  if (!v || typeof v.kind !== "string") return false;
  if (v.kind === "fill") return true;
  const sized = typeof v.width === "number" && typeof v.height === "number" && v.width > 0 && v.height > 0;
  if (v.kind === "freeform") return sized;
  return v.kind === "preset" && sized && typeof v.presetId === "string";
}
