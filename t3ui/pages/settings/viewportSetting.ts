// The "Default browser viewport" row's value logic, ported from IntegrationsSettings.tsx
// (BrowserViewportSetting) and the contracts' PreviewViewportSetting. The setting is one of
// `{ _tag: "fill" }`, `{ _tag: "freeform", width, height }` or `{ _tag: "preset", presetId, width, height }`;
// the local blob keeps it as JSON text under `browserDefaultViewport`.
import { VIEWPORT_PRESETS } from "./viewportPresets";

export type ViewportSetting =
  | { _tag: "fill" }
  | { _tag: "freeform"; width: number; height: number }
  | { _tag: "preset"; presetId: string; width: number; height: number };

export const FILL_VIEWPORT: ViewportSetting = { _tag: "fill" };
export const FILL_VALUE = "fill";
export const RESPONSIVE_VALUE = "responsive";
export const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 };
// contracts preview.ts
export const VIEWPORT_MIN_DIMENSION = 240;
export const VIEWPORT_MAX_DIMENSION = 3840;
export const VIEWPORT_MAX_AREA = 3840 * 2160;

const sizeOk = (width: unknown, height: unknown): width is number =>
  Number.isInteger(width) && Number.isInteger(height)
  && (width as number) >= VIEWPORT_MIN_DIMENSION && (width as number) <= VIEWPORT_MAX_DIMENSION
  && (height as number) >= VIEWPORT_MIN_DIMENSION && (height as number) <= VIEWPORT_MAX_DIMENSION
  && (width as number) * (height as number) <= VIEWPORT_MAX_AREA;

/** The stored JSON text as a setting; anything that is not a valid setting reads as fill. */
export function parseViewport(stored: unknown): ViewportSetting {
  if (typeof stored !== "string") return FILL_VIEWPORT;
  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (value._tag === "freeform" && sizeOk(value.width, value.height)) return { _tag: "freeform", width: value.width as number, height: value.height as number };
    if (value._tag === "preset" && typeof value.presetId === "string" && sizeOk(value.width, value.height)) {
      return { _tag: "preset", presetId: value.presetId, width: value.width as number, height: value.height as number };
    }
  } catch { /* fall through to fill */ }
  return FILL_VIEWPORT;
}

export const serializeViewport = (viewport: ViewportSetting) => JSON.stringify(viewport);

export function viewportSelectValue(viewport: ViewportSetting): string {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (viewport._tag === "preset" && VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)) return viewport.presetId;
  return RESPONSIVE_VALUE;
}

export function viewportSelectLabel(viewport: ViewportSetting): string {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return "Fill panel";
  if (value === RESPONSIVE_VALUE) return "Responsive";
  return VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? "Responsive";
}

/** The setting a select choice produces; null for an unknown value. */
export function viewportFromChoice(value: string, current: ViewportSetting): ViewportSetting | null {
  if (value === FILL_VALUE) return FILL_VIEWPORT;
  if (value === RESPONSIVE_VALUE) {
    const sized = current._tag === "fill" ? null : current;
    return { _tag: "freeform", width: sized?.width ?? RESPONSIVE_SEED_SIZE.width, height: sized?.height ?? RESPONSIVE_SEED_SIZE.height };
  }
  const preset = VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
  return preset ? { _tag: "preset", presetId: preset.id, width: preset.width, height: preset.height } : null;
}

/** A typed width or height as a freeform viewport; null when it is invalid or changes nothing. */
export function viewportFromDimension(axis: "width" | "height", text: string, current: ViewportSetting): ViewportSetting | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isInteger(value) || value < VIEWPORT_MIN_DIMENSION || value > VIEWPORT_MAX_DIMENSION) return null;
  const sized = current._tag === "fill" ? null : current;
  const next = { width: sized?.width ?? RESPONSIVE_SEED_SIZE.width, height: sized?.height ?? RESPONSIVE_SEED_SIZE.height, [axis]: value };
  if (next.width * next.height > VIEWPORT_MAX_AREA) return null;
  if (sized && next.width === sized.width && next.height === sized.height) return null;
  return { _tag: "freeform", width: next.width, height: next.height };
}

export function rotateViewport(viewport: Exclude<ViewportSetting, { _tag: "fill" }>): ViewportSetting {
  return { ...viewport, width: viewport.height, height: viewport.width };
}
