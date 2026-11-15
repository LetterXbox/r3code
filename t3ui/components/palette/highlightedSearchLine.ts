// Port of apps/web/src/components/search/HighlightedSearchLine.tsx's range handling: a content
// match's matchRanges become highlighted spans of the line (the reference's <mark class="rounded-xs
// bg-primary/25">). The palette shows the line trimmed, so ranges are shifted to the trimmed text.
// Syntax colours come from the markdown highlighter (thread/markdown/highlight.ts) by the match's file type, as the
// reference highlights by getFiletypeFromFileName; matches split those tokens (splitToken).
import { highlightLine, resolveLanguage, type HighlightKind } from "../thread/markdown/highlight";

export interface MatchRange { start: number; end: number }
export interface LineSegment { text: string; match: boolean; kind?: HighlightKind }

export function normalizeMatchRanges(line: string, ranges: readonly MatchRange[]): MatchRange[] {
  const clamped = ranges
    .map((range) => ({ start: Math.max(0, Math.min(line.length, range.start)), end: Math.max(0, Math.min(line.length, range.end)) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: MatchRange[] = [];
  for (const range of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function highlightSegments(line: string, ranges: readonly MatchRange[]): LineSegment[] {
  const segments: LineSegment[] = [];
  let cursor = 0;
  for (const range of normalizeMatchRanges(line, ranges)) {
    if (range.start > cursor) segments.push({ text: line.slice(cursor, range.start), match: false });
    segments.push({ text: line.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), match: false });
  return segments;
}

/** The segments of the trimmed line the palette row shows; null when nothing matched in it. */
export function trimmedHighlightSegments(line: string, ranges: readonly MatchRange[] | undefined): LineSegment[] | null {
  if (!ranges || ranges.length === 0) return null;
  const lead = line.length - line.trimStart().length;
  const trimmed = line.trim();
  const shifted = ranges.map((range) => ({ start: range.start - lead, end: range.end - lead }));
  const segments = highlightSegments(trimmed, shifted);
  return segments.some((segment) => segment.match) ? segments : null;
}

export function parseMatchRanges(value: unknown): MatchRange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const r = raw as { start?: unknown; end?: unknown } | null;
    return r && typeof r.start === "number" && typeof r.end === "number" ? [{ start: r.start, end: r.end }] : [];
  });
}

/** HighlightedTokens: syntax tokens of the line split at the match ranges. Falls back to one plain token. */
export function syntaxHighlightSegments(line: string, ranges: readonly MatchRange[], path: string): LineSegment[] {
  const language = resolveLanguage(path);
  const tokens = language ? highlightLine(line, language) : [];
  const source = tokens.length > 0 && tokens.map((token) => token.text).join("") === line ? tokens : [{ text: line, kind: "plain" as HighlightKind }];
  const merged = normalizeMatchRanges(line, ranges);
  const segments: LineSegment[] = [];
  let offset = 0;
  for (const token of source) {
    const end = offset + token.text.length;
    let cursor = offset;
    for (const range of merged) {
      if (range.end <= cursor) continue;
      if (range.start >= end) break;
      const start = Math.max(cursor, range.start);
      if (start > cursor) segments.push({ text: line.slice(cursor, start), match: false, kind: token.kind });
      const stop = Math.min(end, range.end);
      segments.push({ text: line.slice(start, stop), match: true, kind: token.kind });
      cursor = stop;
    }
    if (cursor < end) segments.push({ text: line.slice(cursor, end), match: false, kind: token.kind });
    offset = end;
  }
  return segments;
}

/** The trimmed line the palette row shows, with syntax colours and matches. */
export function trimmedSyntaxSegments(line: string, ranges: readonly MatchRange[] | undefined, path: string): LineSegment[] {
  const lead = line.length - line.trimStart().length;
  const trimmed = line.trim();
  return syntaxHighlightSegments(trimmed, (ranges ?? []).map((range) => ({ start: range.start - lead, end: range.end - lead })), path);
}
