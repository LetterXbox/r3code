// The changed-files column's width (files/FileExplorerPane.tsx: MIN 160, MAX 560, the row keeps 256 for its content,
// the default is 40% of the row; a chosen width overrides the default). Pure.
export const TREE_MIN_WIDTH = 160;
export const TREE_MAX_WIDTH = 560;
export const TREE_CONTENT_MIN_WIDTH = 256;
export const TREE_DEFAULT_FRACTION = 0.4;

export function treeMaxWidth(rowWidth: number): number {
  if (rowWidth <= 0) return TREE_MAX_WIDTH;
  return Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, rowWidth - TREE_CONTENT_MIN_WIDTH));
}

export function defaultTreeWidth(rowWidth: number): number {
  if (rowWidth <= 0) return 256;
  return Math.max(TREE_MIN_WIDTH, Math.min(256, rowWidth * TREE_DEFAULT_FRACTION));
}

export function clampTreeWidth(width: number, rowWidth: number): number {
  return Math.round(Math.max(TREE_MIN_WIDTH, Math.min(treeMaxWidth(rowWidth), width)));
}

/** The width shown: the saved one clamped to the row, else the default. */
export function treeWidthFor(saved: number | null, rowWidth: number): number {
  return saved === null ? clampTreeWidth(defaultTreeWidth(rowWidth), rowWidth) : clampTreeWidth(saved, rowWidth);
}

export function readSavedTreeWidth(text: string | null): number | null {
  const value = text === null ? Number.NaN : Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}
