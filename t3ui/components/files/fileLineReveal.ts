// fileLineReveal.ts: a file opened at a line shows that line in the middle of the view.
// The list scrolls by row index, so the line number becomes a clamped zero-based index.

/** The row to centre for a one-based `line` of a file with `count` lines; null when there is no line to reveal. */
export function revealIndex(line: number | undefined, count: number): number | null {
  if (line === undefined || !Number.isFinite(line) || count <= 0) return null;
  return Math.min(count, Math.max(1, Math.floor(line))) - 1;
}
