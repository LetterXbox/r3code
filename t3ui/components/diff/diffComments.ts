// Review comments on diff lines (diffs/AnnotatableCodeView.tsx, reviewCommentContext.ts buildDiffReviewComment): a comment
// on a line range becomes a `review-comment` context record (packages/contracts composerContext.ts ReviewCommentContextRecord)
// the composer sends with the next message. Pure; the lines come from the patch text itself.
import { contextMarker, toComposerContextId } from "../composer/contextChips";

export type DiffSide = "old" | "new";
export interface PatchLine { marker: " " | "+" | "-"; oldNumber: number | null; newNumber: number | null; content: string }
export interface DiffComment { id: string; path: string; side: DiffSide; start: number; end: number; text: string }

/** The lines of a one-file unified patch, numbered as in the old and the new file. */
export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) { oldNumber = Number(header[1]); newNumber = Number(header[2]); inHunk = true; continue; }
    if (raw.startsWith("diff --git ")) { inHunk = false; continue; }
    if (!inHunk || raw.startsWith("\\")) continue;
    const marker = raw[0];
    if (marker === "+") lines.push({ marker: "+", oldNumber: null, newNumber: newNumber++, content: raw.slice(1) });
    else if (marker === "-") lines.push({ marker: "-", oldNumber: oldNumber++, newNumber: null, content: raw.slice(1) });
    else if (marker === " ") lines.push({ marker: " ", oldNumber: oldNumber++, newNumber: newNumber++, content: raw.slice(1) });
  }
  return lines;
}

/** The patch lines a range (0-based, inclusive) of a side covers, in patch order. */
export function linesInRange(lines: readonly PatchLine[], side: DiffSide, start: number, end: number): PatchLine[] {
  return lines.filter((line) => {
    const number = side === "new" ? line.newNumber : line.oldNumber;
    return number !== null && number - 1 >= start && number - 1 <= end;
  });
}

/** formatDiffReviewRangeLabel: "12", "+12 to +15", "-3". */
export function rangeLabelOf(lines: readonly PatchLine[]): string {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return "line";
  const a = first.newNumber ?? first.oldNumber;
  const b = last.newNumber ?? last.oldNumber;
  if (a === null || b === null) return lines.length === 1 ? "line" : `${lines.length} lines`;
  const marker = first.marker !== " " && lines.every((line) => line.marker === first.marker) ? first.marker : "";
  return a === b ? `${marker}${a}` : `${marker}${a} to ${marker}${b}`;
}

/** reviewCommentContextLabel: "file.ts L12 to L15 (before)". */
export function commentLabel(path: string, rangeLabel: string): string {
  const range = /^([+-])(\d+)(?: to \1(\d+))?$/u.exec(rangeLabel);
  const text = range ? `L${range[2]}${range[3] ? ` to L${range[3]}` : ""}${range[1] === "-" ? " (before)" : ""}` : rangeLabel;
  return `${path.split(/[\\/]/).at(-1) ?? path} ${text}`;
}

export interface ReviewCommentRecord {
  version: 1; contextId: string; kind: "review-comment"; label: string; sectionId: string; sectionTitle: string; filePath: string;
  startIndex: number; endIndex: number; rangeLabel: string; text: string; diff: string; fenceLanguage: "diff";
  /** buildDiffReviewComment `selection`: the commented range as the diff selects it, so the comment can be shown again. */
  selection: { start: number; side: "additions" | "deletions"; end: number; endSide: "additions" | "deletions" };
}

/** The record a comment becomes; null when the patch has none of the commented lines. */
export function reviewCommentRecord(comment: DiffComment, patch: string, sectionTitle: string): ReviewCommentRecord | null {
  const selected = linesInRange(patchLines(patch), comment.side, comment.start, comment.end);
  if (selected.length === 0) return null;
  const olds = selected.filter((line) => line.oldNumber !== null);
  const news = selected.filter((line) => line.newNumber !== null);
  const rangeLabel = rangeLabelOf(selected);
  return {
    version: 1,
    contextId: toComposerContextId(`review-comment_${comment.id}`),
    kind: "review-comment",
    label: commentLabel(comment.path, rangeLabel).slice(0, 200),
    sectionId: `file:${comment.path}`,
    sectionTitle,
    filePath: comment.path,
    startIndex: Math.min(comment.start, comment.end),
    endIndex: Math.max(comment.start, comment.end),
    rangeLabel,
    text: comment.text.trim(),
    diff: [`@@ -${olds[0]?.oldNumber ?? 0},${olds.length} +${news[0]?.newNumber ?? 0},${news.length} @@`, ...selected.map((line) => `${line.marker}${line.content}`)].join("\n"),
    fenceLanguage: "diff",
    selection: { start: comment.start, side: comment.side === "old" ? "deletions" : "additions", end: comment.end, endSide: comment.side === "old" ? "deletions" : "additions" },
  };
}

/**
 * restoreDiffReviewCommentRange: the composer's pending diff comments for this section and file shown again on the diff,
 * from each record's selection (one side per annotation in NSH: the start's side). Records without a selection, file
 * comments and other sections are left out.
 */
export function restoreDiffComments(records: readonly unknown[], sectionId: (path: string) => string): DiffComment[] {
  return records.flatMap((value): DiffComment[] => {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
    if (!record || record.kind !== "review-comment" || (record.fenceLanguage ?? "diff") !== "diff" || typeof record.filePath !== "string") return [];
    if (record.sectionId !== sectionId(record.filePath)) return [];
    const selection = typeof record.selection === "object" && record.selection !== null ? (record.selection as Record<string, unknown>) : null;
    if (!selection || typeof selection.start !== "number" || typeof selection.end !== "number") return [];
    return [{ id: String(record.contextId), path: record.filePath, side: selection.side === "deletions" ? "old" : "new", start: selection.start, end: selection.end, text: typeof record.text === "string" ? record.text : "" }];
  });
}

/** The inline marker the prompt carries for a comment's record. */
export const reviewCommentMarker = (record: ReviewCommentRecord) => contextMarker("review-comment", record.contextId, record.label);

/** The annotations a DiffView shows: one per saved comment, at the last line of its range, plus the draft being written. */
export function commentAnnotations(comments: readonly DiffComment[], draft: { side: DiffSide; start: number; end: number } | null): { id: string; side: DiffSide; line: number }[] {
  const out = comments.map((comment) => ({ id: comment.id, side: comment.side, line: Math.max(comment.start, comment.end) }));
  if (draft) out.push({ id: "draft", side: draft.side, line: Math.max(draft.start, draft.end) });
  return out;
}

/** Comments only address a file when the stack is that one file: NSH's annotations carry a side and a line, not a path. */
export function commentablePath(shownPaths: readonly string[]): string | null {
  return shownPaths.length === 1 ? (shownPaths[0] ?? null) : null;
}
