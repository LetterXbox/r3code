// Unchanged context around a file's hunks, as Pierre's DiffHunksRenderer reveals it once a FileDiffContentsLoader
// (lib/diffFileContents.ts: review.getDiffFileContents, pullRequests.diffFileContents) has handed it the file's two
// texts. The port keeps git's hunks (so whitespace-ignoring diffs and comment anchors stay as the server made them)
// and splices the revealed context lines into the file's patch, re-numbering and merging hunks; DiffView then draws
// the longer patch. Separator copy and buttons follow Pierre's createSeparator / getModifiedLinesString.

/** Pierre's expansionLineCount default: lines one press of an up/down button reveals. */
export const EXPANSION_LINE_COUNT = 100;

/** Pierre's FileDiffMetadata type: only "change" and "rename-changed" hydrate collapsed context (canHydrateCollapsedContext). */
export type DiffChangeType = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

export interface DiffFileContents { oldContents: string; newContents: string }

/** A review.getDiffFileContents / pullRequests.diffFileContents result (their DiffFileContentsResult). */
export function readDiffFileContents(result: unknown): DiffFileContents {
  const value = result as { oldContents?: unknown; newContents?: unknown } | null;
  if (typeof value?.oldContents !== "string" || typeof value.newContents !== "string") throw new Error("The server returned invalid diff file contents.");
  return { oldContents: value.oldContents, newContents: value.newContents };
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What follows the closing `@@` (a function name), without the leading space. */
  header: string;
  /** The hunk's body lines (" ", "-", "+", "\\"). */
  lines: string[];
}

export interface ParsedFilePatch { head: string[]; hunks: PatchHunk[] }

/** Revealed lines of one gap: `fromStart` below the hunk above it, `fromEnd` above the hunk below it (Pierre's region). */
export interface GapExpansion { fromStart: number; fromEnd: number }
/** Gap `i` is before hunk `i` (0 above the first hunk, `hunks.length` below the last). */
export type FileExpansion = Readonly<Record<number, GapExpansion>>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u;

export function parseFilePatch(patch: string): ParsedFilePatch {
  const head: string[] = [];
  const hunks: PatchHunk[] = [];
  const lines = patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);
    if (match) {
      hunks.push({ oldStart: Number(match[1]), oldLines: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newLines: match[4] === undefined ? 1 : Number(match[4]), header: match[5] ?? "", lines: [] });
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1]!.lines.push(line);
    } else {
      head.push(line);
    }
  }
  return { head, hunks };
}

/** The first and last old/new line a hunk covers (an empty side sits after its start line, as git numbers it). */
function span(hunk: PatchHunk) {
  const oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  const newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  return { oldFirst, oldLast: oldFirst + hunk.oldLines - 1, newFirst, newLast: newFirst + hunk.newLines - 1 };
}

function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines hidden in gap `gap` (getModifiedLinesString's count), or null when only the files can tell (below the last hunk). */
export function gapSize(hunks: readonly PatchHunk[], gap: number, contents?: DiffFileContents | null): number | null {
  if (hunks.length === 0) return null;
  if (gap === 0) return span(hunks[0]!).oldFirst - 1;
  if (gap < hunks.length) return span(hunks[gap]!).oldFirst - span(hunks[gap - 1]!).oldLast - 1;
  if (!contents) return null;
  return Math.max(0, textLines(contents.oldContents).length - span(hunks[hunks.length - 1]!).oldLast);
}

/** Pierre's getModifiedLinesString, and its copy for a gap whose size is unknown. */
export function separatorLabel(lines: number | null): string {
  return lines === null ? "More unchanged context may be available" : `${lines} unmodified line${lines === 1 ? "" : "s"}`;
}

/** The buttons createSeparator draws for a gap: one that reveals all of a short gap, or up / down / "Expand all" for a long one. */
export function separatorButtons(lines: number | null, first: boolean, last: boolean): ("both" | "up" | "down" | "all")[] {
  const chunked = lines === null || lines > EXPANSION_LINE_COUNT;
  if (!chunked) return [!first && !last ? "both" : first ? "down" : "up"];
  const out: ("both" | "up" | "down" | "all")[] = [];
  if (!first) out.push("up");
  if (!last) out.push("down");
  out.push("all");
  return out;
}

/** Pierre's expandHunk: a press adds `EXPANSION_LINE_COUNT` lines on its side(s); "all" reveals the whole gap. */
export function expandGap(current: FileExpansion, gap: number, direction: "both" | "up" | "down" | "all"): FileExpansion {
  const region = current[gap] ?? { fromStart: 0, fromEnd: 0 };
  const huge = Number.MAX_SAFE_INTEGER;
  const next: GapExpansion = direction === "all"
    ? { fromStart: huge, fromEnd: 0 }
    : {
      fromStart: direction === "up" || direction === "both" ? region.fromStart + EXPANSION_LINE_COUNT : region.fromStart,
      fromEnd: direction === "down" || direction === "both" ? region.fromEnd + EXPANSION_LINE_COUNT : region.fromEnd,
    };
  return { ...current, [gap]: next };
}

/** Pierre's canHydrateCollapsedContext, from what the port knows of a file: its paths and its patch. */
export function diffChangeType(file: { path: string; previousPath: string | null }, patch: string): DiffChangeType {
  if (/^new file mode /mu.test(patch)) return "new";
  if (/^deleted file mode /mu.test(patch)) return "deleted";
  if (file.previousPath !== null && file.previousPath !== file.path) return /^@@ /mu.test(patch) ? "rename-changed" : "rename-pure";
  return "change";
}

export function canHydrateContext(changeType: DiffChangeType, patch: string): boolean {
  return (changeType === "change" || changeType === "rename-changed") && /^@@ /mu.test(patch) && !/^Binary files /mu.test(patch);
}

function formatHeader(hunk: PatchHunk): string {
  const old = hunk.oldLines === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLines}`;
  const neu = hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLines}`;
  return `@@ -${old} +${neu} @@${hunk.header ? ` ${hunk.header}` : ""}`;
}

/** The file's patch with every revealed context line spliced in: hunks grow, and a fully revealed gap merges its two hunks. */
export function expandFilePatch(patch: string, contents: DiffFileContents, expansion: FileExpansion): string {
  return expandFilePatchWithGaps(patch, contents, expansion).patch;
}

/** A rendered separator: which gap of the original patch it stands for, and how many of its lines are still hidden. */
export interface RenderedGap { gap: number; lines: number | null; first: boolean; last: boolean }

/** The separators the (possibly expanded) patch shows, in order: one per rendered hunk (above it), then the one below the last. */
export function renderedGaps(patch: string, contents: DiffFileContents | null, expansion: FileExpansion): RenderedGap[] {
  const { hunks } = parseFilePatch(patch);
  const total = hunks.length;
  const starts = contents ? expandFilePatchWithGaps(patch, contents, expansion).starts : hunks.map((_, index) => index);
  const remaining = (gap: number) => {
    const size = gapSize(hunks, gap, contents);
    if (size === null || !contents) return size;
    const region = expansion[gap] ?? { fromStart: 0, fromEnd: 0 };
    return Math.max(0, size - Math.min(size, region.fromStart + region.fromEnd));
  };
  const out: RenderedGap[] = starts.map((gap) => ({ gap, lines: remaining(gap), first: gap === 0, last: false }));
  if (total > 0) out.push({ gap: total, lines: remaining(total), first: false, last: true });
  return out;
}

function expandFilePatchWithGaps(patch: string, contents: DiffFileContents, expansion: FileExpansion): { patch: string; starts: number[] } {
  const parsed = parseFilePatch(patch);
  const starts: number[] = [];
  if (parsed.hunks.length === 0) return { patch, starts };
  const newText = textLines(contents.newContents);
  const total = parsed.hunks.length;
  // Context taken from the new text (what the file reads now), numbered on both sides.
  const context = (oldLine: number, newLine: number, count: number) => {
    const rows: string[] = [];
    for (let i = 0; i < count; i++) rows.push(` ${newText[newLine - 1 + i] ?? ""}`);
    void oldLine;
    return rows;
  };
  const out: PatchHunk[] = [];
  for (let index = 0; index < total; index++) {
    const source = parsed.hunks[index]!;
    let hunk: PatchHunk = { ...source, lines: [...source.lines] };
    const s = span(hunk);
    // Lines revealed above this hunk (the end of gap `index`).
    const size = gapSize(parsed.hunks, index, contents) ?? 0;
    const region = expansion[index] ?? { fromStart: 0, fromEnd: 0 };
    const fromStart = index === 0 ? 0 : Math.min(size, region.fromStart);
    const fromEnd = Math.min(size - fromStart, index === 0 ? region.fromEnd + region.fromStart : region.fromEnd);
    const above = Math.max(0, fromEnd);
    if (above > 0) {
      hunk = {
        ...hunk,
        oldStart: s.oldFirst - above,
        newStart: s.newFirst - above,
        oldLines: hunk.oldLines + above,
        newLines: hunk.newLines + above,
        lines: [...context(s.oldFirst - above, s.newFirst - above, above), ...hunk.lines],
      };
    }
    const previous = out[out.length - 1];
    if (previous && index > 0) {
      const p = span(previous);
      // Lines revealed below the previous hunk (the start of gap `index`).
      if (fromStart > 0) {
        previous.lines.push(...context(p.oldLast + 1, p.newLast + 1, fromStart));
        previous.oldLines += fromStart;
        previous.newLines += fromStart;
      }
      if (fromStart + above >= size) {
        // The whole gap shows: one hunk.
        previous.lines.push(...hunk.lines);
        previous.oldLines += hunk.oldLines;
        previous.newLines += hunk.newLines;
        continue;
      }
    }
    starts.push(index);
    out.push(hunk);
  }
  // Lines revealed below the last hunk.
  const tailSize = gapSize(parsed.hunks, total, contents) ?? 0;
  const tail = expansion[total] ?? { fromStart: 0, fromEnd: 0 };
  const below = Math.min(tailSize, tail.fromStart + tail.fromEnd);
  if (below > 0) {
    const last = out[out.length - 1]!;
    const p = span(last);
    // A "\ No newline" marker belongs at the end of the file, after the revealed lines.
    const marker = last.lines.length > 0 && last.lines[last.lines.length - 1]!.startsWith("\\") ? last.lines.pop() : undefined;
    last.lines.push(...context(p.oldLast + 1, p.newLast + 1, below));
    if (marker !== undefined) last.lines.push(marker);
    last.oldLines += below;
    last.newLines += below;
  }
  const body = out.flatMap((hunk) => [formatHeader(hunk), ...hunk.lines]);
  return { patch: `${[...parsed.head, ...body].join("\n")}\n`, starts };
}

/** A multi-file patch cut at its `diff --git` lines (the PR Code tab's one patch). */
export function splitPatchFiles(patch: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) { parts.push(current.join("\n")); current = []; }
    current.push(line);
  }
  if (current.length > 0 && !(current.length === 1 && current[0] === "")) parts.push(current.join("\n"));
  return parts;
}

/** The hunk headers of a multi-file patch in order: global hunk `g` is local hunk `hunk` of file `file`
 * (DiffView's patch separators number `gap` across the whole patch, one per hunk header). */
export function hunkIndex(patch: string): { file: number; hunk: number; hunks: number }[] {
  const out: { file: number; hunk: number; hunks: number }[] = [];
  splitPatchFiles(patch).forEach((part, file) => {
    const count = parseFilePatch(part).hunks.length;
    for (let hunk = 0; hunk < count; hunk++) out.push({ file, hunk, hunks: count });
  });
  return out;
}
