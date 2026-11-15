export interface ThemeEditorPoint { x: number; y: number }
export interface ThemeEditorSize { width: number; height: number }

/** The overlay is anchored by its bottom-right corner, eight points inside the window. */
export function clampThemeEditorAnchor(point: ThemeEditorPoint, window: ThemeEditorSize, panel: ThemeEditorSize): ThemeEditorPoint {
  const clamp = (value: number, low: number, high: number) => Math.max(Math.min(low, high), Math.min(high, value));
  return { x: clamp(point.x, panel.width + 8, window.width - 8), y: clamp(point.y, panel.height + 8, window.height - 8) };
}

/** Resize from the bottom-right corner, retaining the panel's top-left position. */
export function resizeThemeEditor(input: { origin: ThemeEditorPoint; size: ThemeEditorSize; delta: ThemeEditorPoint; window: ThemeEditorSize }): { anchor: ThemeEditorPoint; size: ThemeEditorSize } {
  const maxWidth = Math.max(0, input.window.width - 8 - input.origin.x);
  const maxHeight = Math.max(0, input.window.height - 8 - input.origin.y);
  const width = Math.min(maxWidth, Math.max(Math.min(280, maxWidth), input.size.width + input.delta.x));
  const height = Math.min(maxHeight, Math.max(Math.min(220, maxHeight), input.size.height + input.delta.y));
  return { anchor: { x: input.origin.x + width, y: input.origin.y + height }, size: { width, height } };
}
