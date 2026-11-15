// The browser's device toolbar rules (BrowserDeviceToolbar.tsx, browserViewportLayout.ts, shared/previewViewport.ts). The
// reference drives an emulated Chromium viewport; the NSH WebView takes the size of its frame, so the "viewport" here is the frame
// the page is laid out in (CSS pixel size, responsive layout and media queries behave). No device pixel ratio, touch or user
// agent emulation, and no scale-to-fit: a viewport larger than the panel is clamped to it.
export interface ViewportPreset { id: string; label: string; detail: string; width: number; height: number }

const P = (id: string, label: string, width: number, height: number): ViewportPreset => ({ id, label, detail: `${width} × ${height}`, width, height });

/** Chrome DevTools' default device order (PREVIEW_VIEWPORT_PRESET_DEFINITIONS). */
export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  P("iphone-se", "iPhone SE", 375, 667), P("iphone-xr", "iPhone XR", 414, 896), P("iphone-12-pro", "iPhone 12 Pro", 390, 844),
  P("iphone-14-pro-max", "iPhone 14 Pro Max", 430, 932), P("pixel-7", "Pixel 7", 412, 915), P("samsung-galaxy-s8-plus", "Samsung Galaxy S8+", 360, 740),
  P("samsung-galaxy-s20-ultra", "Samsung Galaxy S20 Ultra", 412, 915), P("ipad-mini", "iPad Mini", 768, 1024), P("ipad-air", "iPad Air", 820, 1180),
  P("ipad-pro", "iPad Pro", 1024, 1366), P("surface-pro-7", "Surface Pro 7", 912, 1368), P("surface-duo", "Surface Duo", 540, 720),
  P("galaxy-z-fold-5", "Galaxy Z Fold 5", 344, 882), P("asus-zenbook-fold", "Asus Zenbook Fold", 853, 1280), P("samsung-galaxy-a51-71", "Samsung Galaxy A51/71", 412, 914),
  P("nest-hub", "Nest Hub", 1024, 600), P("nest-hub-max", "Nest Hub Max", 1280, 800),
];

export const VIEWPORT_MIN = 240;
export const VIEWPORT_MAX = 3840;
export const VIEWPORT_MAX_AREA = 3840 * 2160;
export const DEVICE_TOOLBAR_HEIGHT = 38;

export type ViewportSetting = { kind: "fill" } | { kind: "freeform"; width: number; height: number } | { kind: "preset"; width: number; height: number; presetId: string };

/** The setting for the toolbar's select: "responsive" or a preset id. */
export function selectViewport(value: string, current: Exclude<ViewportSetting, { kind: "fill" }>): { setting: ViewportSetting; aspect: "keep" | number } | null {
  if (value === "responsive") return current.kind === "freeform" ? null : { setting: { kind: "freeform", width: current.width, height: current.height }, aspect: "keep" };
  const preset = VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
  return preset ? { setting: { kind: "preset", width: preset.width, height: preset.height, presetId: preset.id }, aspect: preset.width / preset.height } : null;
}

export function validViewport(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= VIEWPORT_MIN && width <= VIEWPORT_MAX && height >= VIEWPORT_MIN && height <= VIEWPORT_MAX && width * height <= VIEWPORT_MAX_AREA;
}

/** Rotate: width and height swap (a preset stays that preset), and a locked ratio inverts. */
export function rotateViewport(setting: Exclude<ViewportSetting, { kind: "fill" }>, ratio: number | null): { setting: ViewportSetting; ratio: number | null } {
  return { setting: { ...setting, width: setting.height, height: setting.width }, ratio: ratio === null ? null : 1 / ratio };
}

/** A typed width or height with the aspect ratio locked: the other side follows (resizeFreeformViewport). */
export function lockedSize(axis: "width" | "height", value: number, ratio: number | null, other: number): { width: number; height: number } {
  if (ratio === null) return axis === "width" ? { width: value, height: other } : { width: other, height: value };
  return axis === "width" ? { width: value, height: Math.round(value / ratio) } : { width: Math.round(value * ratio), height: value };
}

/** The frame the page is laid out in: the viewport, clamped to the room the panel has. */
export function framedViewport(setting: ViewportSetting, room: { width: number; height: number }): { width: number; height: number } | null {
  if (setting.kind === "fill") return null;
  return { width: Math.max(1, Math.min(setting.width, Math.floor(room.width))), height: Math.max(1, Math.min(setting.height, Math.floor(room.height))) };
}

export const presetLabel = (setting: ViewportSetting): string => (setting.kind === "preset" ? VIEWPORT_PRESETS.find((p) => p.id === setting.presetId)?.label ?? "Responsive" : "Responsive");

// browserViewportLayout.ts:147-317: the clamped resize maths behind the typed sizes with a locked ratio, the drag rails and the
// responsive size the device toolbar opens at.
export type ViewportResizeDirection = "north" | "south" | "east" | "west" | "northeast" | "northwest" | "southeast" | "southwest";
export const VIEWPORT_RESIZE_RAIL_SIZE = 10;
type Size = { width: number; height: number };

const normalizeZoomFactor = (zoom: number): number => (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
const clampDimension = (value: number): number => Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, value));
const validAspectRatio = (ratio: number | null | undefined): ratio is number => ratio !== undefined && ratio !== null && Number.isFinite(ratio) && ratio > 0;

function resizeAtAspectRatio(desired: number, ratio: number, primary: "width" | "height"): Size {
  if (primary === "width") {
    const minimum = Math.ceil(Math.max(VIEWPORT_MIN, VIEWPORT_MIN * ratio));
    const maximum = Math.floor(Math.min(VIEWPORT_MAX, VIEWPORT_MAX * ratio, Math.sqrt(VIEWPORT_MAX_AREA * ratio)));
    let width = Math.min(maximum, Math.max(minimum, Math.round(desired)));
    let height = Math.round(width / ratio);
    while (width * height > VIEWPORT_MAX_AREA && width > minimum) { width -= 1; height = Math.round(width / ratio); }
    return { width, height };
  }
  const minimum = Math.ceil(Math.max(VIEWPORT_MIN, VIEWPORT_MIN / ratio));
  const maximum = Math.floor(Math.min(VIEWPORT_MAX, VIEWPORT_MAX / ratio, Math.sqrt(VIEWPORT_MAX_AREA / ratio)));
  let height = Math.min(maximum, Math.max(minimum, Math.round(desired)));
  let width = Math.round(height * ratio);
  while (width * height > VIEWPORT_MAX_AREA && height > minimum) { height -= 1; width = Math.round(height * ratio); }
  return { width, height };
}

/** resizeFreeformViewport: a per-direction delta, clamped to 240..3840 and the area cap, keeping a locked ratio. */
export function resizeFreeformViewport(start: Size, delta: { x: number; y: number }, zoomFactor = 1, direction: ViewportResizeDirection = "southeast", ratio?: number | null): Size {
  const zoom = normalizeZoomFactor(zoomFactor);
  const dx = direction.includes("east") ? delta.x : direction.includes("west") ? -delta.x : 0;
  const dy = direction.includes("south") ? delta.y : direction.includes("north") ? -delta.y : 0;
  const desiredWidth = start.width + dx / zoom;
  const desiredHeight = start.height + dy / zoom;
  if (validAspectRatio(ratio)) {
    const controlsWidth = dx !== 0 || direction === "east" || direction === "west";
    const controlsHeight = dy !== 0 || direction === "north" || direction === "south";
    const primary = controlsWidth && !controlsHeight ? "width" : controlsHeight && !controlsWidth ? "height"
      : Math.abs(desiredWidth - start.width) / start.width >= Math.abs(desiredHeight - start.height) / start.height ? "width" : "height";
    return resizeAtAspectRatio(primary === "width" ? desiredWidth : desiredHeight, ratio, primary);
  }
  let width = clampDimension(Math.round(desiredWidth));
  let height = clampDimension(Math.round(desiredHeight));
  if (width * height <= VIEWPORT_MAX_AREA) return { width, height };
  if (Math.abs(dx) >= Math.abs(dy)) width = Math.max(VIEWPORT_MIN, Math.floor(VIEWPORT_MAX_AREA / height));
  else height = Math.max(VIEWPORT_MIN, Math.floor(VIEWPORT_MAX_AREA / width));
  return { width, height };
}

const resizeFromEndRail = (start: number, pointerDelta: number, available: number): number => {
  const startEdge = start < available ? (available + start) / 2 : start;
  const targetEdge = startEdge + pointerDelta;
  return targetEdge <= available ? targetEdge * 2 - available : targetEdge;
};

const resizeFromStartRail = (start: number, pointerDelta: number, available: number): number => {
  if (start > available) {
    const distanceToFit = start - available;
    return pointerDelta <= distanceToFit ? start - pointerDelta : available - (pointerDelta - distanceToFit) * 2;
  }
  const targetEdge = (available - start) / 2 + pointerDelta;
  return targetEdge >= 0 ? available - targetEdge * 2 : available - targetEdge;
};

/** resizeBrowserViewportFromRail: a drag on a centred viewport's rail moves both edges, so the size changes twice the pointer delta. */
export function resizeViewportFromRail(start: Size, pointerDelta: { x: number; y: number }, available: Size, zoomFactor = 1, direction: ViewportResizeDirection = "southeast", ratio?: number | null): Size {
  const zoom = normalizeZoomFactor(zoomFactor);
  const startWidth = start.width * zoom;
  const startHeight = start.height * zoom;
  const desiredWidth = direction.includes("east") ? resizeFromEndRail(startWidth, pointerDelta.x, available.width) : direction.includes("west") ? resizeFromStartRail(startWidth, pointerDelta.x, available.width) : startWidth;
  const desiredHeight = direction.includes("south") ? resizeFromEndRail(startHeight, pointerDelta.y, available.height) : direction.includes("north") ? resizeFromStartRail(startHeight, pointerDelta.y, available.height) : startHeight;
  const widthDelta = desiredWidth - startWidth;
  const heightDelta = desiredHeight - startHeight;
  return resizeFreeformViewport(start, { x: direction.includes("west") ? -widthDelta : widthDelta, y: direction.includes("north") ? -heightDelta : heightDelta }, zoom, direction, ratio);
}

/** resolveBrowserDeviceViewportArea: the room under the toolbar, inside the side and bottom rails. */
export function deviceViewportArea(container: Size): Size {
  return { width: Math.max(1, container.width - VIEWPORT_RESIZE_RAIL_SIZE * 2), height: Math.max(1, container.height - DEVICE_TOOLBAR_HEIGHT - VIEWPORT_RESIZE_RAIL_SIZE) };
}

/** resolveResponsiveBrowserViewportSize: the size "Show device toolbar" opens at, clamped like a resize. */
export function responsiveViewportSize(container: Size, zoomFactor = 1): Size {
  const area = deviceViewportArea(container);
  const zoom = normalizeZoomFactor(zoomFactor);
  return resizeFreeformViewport({ width: area.width / zoom, height: area.height / zoom }, { x: 0, y: 0 });
}

/** The toolbar's typed size, before it commits (`customSize` in BrowserDeviceToolbar.tsx); `axis` is the side last typed. */
export type ToolbarDraft = { width: string; height: string; axis?: "width" | "height" };

/** updateCustomDimension: with the ratio locked, a valid typed side resizes the other from the committed size. */
export function toolbarTypedSize(axis: "width" | "height", value: string, current: ToolbarDraft | null, setting: Size, ratio: number | null): ToolbarDraft {
  const next: ToolbarDraft = { width: axis === "width" ? value : current?.width ?? String(setting.width), height: axis === "height" ? value : current?.height ?? String(setting.height), axis };
  const n = Number(value);
  if (ratio === null || !Number.isInteger(n) || n < VIEWPORT_MIN || n > VIEWPORT_MAX) return next;
  const resized = resizeFreeformViewport(setting, axis === "width" ? { x: n - setting.width, y: 0 } : { x: 0, y: n - setting.height }, 1, axis === "width" ? "east" : "south", ratio);
  return { ...next, width: axis === "width" ? value : String(resized.width), height: axis === "height" ? value : String(resized.height) };
}

/** The size a draft commits as (customWidth/customHeight) and whether it is valid (customValid). */
export function toolbarCustomSize(draft: ToolbarDraft, ratio: number | null): { width: number; height: number; valid: boolean } {
  const typedWidth = Number(draft.width);
  const typedHeight = Number(draft.height);
  const size = ratio === null || draft.axis === undefined ? { width: typedWidth, height: typedHeight } : resizeFreeformViewport({ width: typedWidth, height: typedHeight }, { x: 0, y: 0 }, 1, draft.axis === "height" ? "south" : "east", ratio);
  const valid = Number.isInteger(typedWidth) && Number.isInteger(typedHeight) && typedWidth >= VIEWPORT_MIN && typedWidth <= VIEWPORT_MAX && typedHeight >= VIEWPORT_MIN && typedHeight <= VIEWPORT_MAX && size.width * size.height <= VIEWPORT_MAX_AREA;
  return { ...size, valid };
}
