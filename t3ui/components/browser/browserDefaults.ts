// browserDefaults.ts (apps/web/src/browser): what a new browser tab starts with, from Settings > Browser:
// browserDefaultViewport (stored as the settings page's {_tag} JSON) and browserDefaultZoomFactor.
import { settingValue } from "../../store";
import { parseViewport } from "../../pages/settings/viewportSetting";
import type { ViewportSetting } from "./viewportLogic";

/** The settings page's viewport value as the toolbar's setting. */
export function toToolbarViewport(stored: unknown): ViewportSetting {
  const v = parseViewport(stored);
  if (v._tag === "freeform") return { kind: "freeform", width: v.width, height: v.height };
  if (v._tag === "preset") return { kind: "preset", width: v.width, height: v.height, presetId: v.presetId };
  return { kind: "fill" };
}

/** A zoom factor from the setting (a number or its text); 1 when unset or out of the 0.25..5 range. */
export function toZoomFactor(stored: unknown): number {
  const n = typeof stored === "number" ? stored : typeof stored === "string" ? Number(stored) : NaN;
  return Number.isFinite(n) && n >= 0.25 && n <= 5 ? n : 1;
}

export const defaultTabViewport = () => toToolbarViewport(settingValue("browserDefaultViewport"));
export const defaultTabZoom = () => toZoomFactor(settingValue("browserDefaultZoomFactor"));
