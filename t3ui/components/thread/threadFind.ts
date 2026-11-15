// Pure helpers for the thread find bar (chat/threadFind.ts + the match walk of useThreadFindNavigation.ts).
// Matching is a case-insensitive substring search over each timeline row's text. A match is
// (row id, occurrence within the row); next/previous step through them in timeline order.
import { buildTimelineRows, workRowLabel, type TimelineRow } from "./timeline/workLog";
import type { TimelineEntry } from "./timeline";

export interface ThreadFindEntry { readonly id: string; readonly text: string }
export interface ThreadFindMatch { readonly entryId: string; readonly occurrence: number }

export const THREAD_FIND_MAX_QUERY = 200;

export function normalizeFindQuery(query: string): string {
  return query.trim().slice(0, THREAD_FIND_MAX_QUERY);
}

function clampIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), total - 1);
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const clamped = clampIndex(index, total);
  return (((clamped + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${clampIndex(index, total) + 1}/${total}`;
}

/** How many times `query` occurs in `text` (non-overlapping, case-insensitive). */
export function countOccurrences(text: string, query: string): number {
  const needle = normalizeFindQuery(query).toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

export function findThreadMatches(entries: readonly ThreadFindEntry[], query: string): ThreadFindMatch[] {
  const matches: ThreadFindMatch[] = [];
  for (const entry of entries) {
    const count = countOccurrences(entry.text, query);
    for (let occurrence = 0; occurrence < count; occurrence++) matches.push({ entryId: entry.id, occurrence });
  }
  return matches;
}

/** The text a find searches in one timeline row. */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** useThreadFind's skill labels: a `$skill` mention also matches its display name, as rendered. */
export function skillDisplayNamesIn(text: string, skills: readonly { name: string; displayName: string | null }[]): string {
  if (skills.length === 0 || !text.includes("$")) return "";
  return skills.filter((skill) => skill.displayName && skill.displayName !== skill.name && new RegExp(`\\$${escapeRegExp(skill.name)}(?![\\w-])`).test(text)).map((skill) => skill.displayName!).join("\n");
}

export function rowFindText(row: TimelineRow, skills: readonly { name: string; displayName: string | null }[] = []): string {
  switch (row.kind) {
    case "entry": {
      if (row.entry.kind !== "message") return "";
      const aliases = skillDisplayNamesIn(row.entry.message.body, skills);
      return aliases ? `${row.entry.message.body}\n${aliases}` : row.entry.message.body;
    }
    case "work": return row.items.map((item) => `${workRowLabel(item)}\n${item.detail}`).join("\n");
    case "plan": return row.item.detail;
    case "notice": return `${row.item.title}\n${row.item.detail}`;
    case "divider": return `${row.label}\n${row.detail}`;
    default: return "";
  }
}

export function findEntriesFor(entries: readonly TimelineEntry[], skills: readonly { name: string; displayName: string | null }[] = []): ThreadFindEntry[] {
  return buildTimelineRows(entries, false).map((row) => ({ id: row.id, text: rowFindText(row, skills) }));
}

/**
 * Wraps each occurrence of `query` in `<mark>` so the markdown view highlights it. Inline code, link
 * destinations, raw HTML tags and bare URLs are left alone (a mark inside them would break the syntax).
 * Fenced code is not passed here: ChatMarkdown highlights only its text segments.
 */
export function markFindMatches(markdown: string, query: string): string {
  const needle = normalizeFindQuery(query);
  if (!needle) return markdown;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const skip = "`+[^`\\n]*?`+|\\]\\([^)\\n]*\\)|<[^>\\n]+>|https?:\\/\\/[^\\s)<>]+";
  const pattern = new RegExp(`(${skip})|(${escaped})`, "gi");
  return markdown.replace(pattern, (whole, skipped: string | undefined) => (skipped !== undefined ? whole : `<mark>${whole}</mark>`));
}

/**
 * readThreadFindPosition: the index of the first match at or below the viewport's first row, so a new query does
 * not jump to the top of the thread. Falls back to the first match when the row is unknown or nothing is below it.
 */
export function findStartIndex(entries: readonly ThreadFindEntry[], matches: readonly ThreadFindMatch[], viewportRowId: string | null): number {
  if (!viewportRowId || matches.length === 0) return 0;
  const order = new Map(entries.map((entry, index) => [entry.id, index]));
  const from = order.get(viewportRowId);
  if (from === undefined) return 0;
  const index = matches.findIndex((match) => (order.get(match.entryId) ?? -1) >= from);
  return index < 0 ? 0 : index;
}

/** ::highlight(t3-thread-find-active) background, oklch(0.774202 0.151946 74.331). */
export const FIND_ACTIVE_HIGHLIGHT = "#e3a12f";

/**
 * threadFindHighlights' active range: the `occurrence`-th highlight (`<mark>` from markFindMatches) of a parsed markdown tree,
 * in document order, gets `color`; the tree is copied, never changed. Returns the input when there is no such highlight.
 */
export function colorFindOccurrence<T>(tree: T, occurrence: number, color: string): T {
  let seen = 0;
  let hit = false;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "highlight") {
      const index = seen;
      seen += 1;
      const content = visit(record.content);
      if (index === occurrence) { hit = true; return { ...record, content, color }; }
      return { ...record, content };
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) out[key] = visit(record[key]);
    return out;
  };
  const result = visit(tree) as T;
  return hit ? result : tree;
}

/** Whether a parsed markdown tree holds a highlight in `color` (the block drawing the active match). */
export function holdsFindColor(tree: unknown, color: string): boolean {
  if (Array.isArray(tree)) return tree.some((item) => holdsFindColor(item, color));
  if (tree === null || typeof tree !== "object") return false;
  const record = tree as Record<string, unknown>;
  if (record.type === "highlight" && record.color === color) return true;
  return Object.values(record).some((value) => holdsFindColor(value, color));
}

/** useThreadFindNavigation FIND_MATCH_VIEW_MARGIN: the match is kept this far inside the view's edges. */
export const FIND_MATCH_VIEW_MARGIN = 96;

/** revealThreadFindMatch: how far to scroll so the match box sits inside the view with the margin (0 when it already does). */
export function findRevealDelta(match: { top: number; height: number }, viewportHeight: number, bottomInset = 0): number {
  const margin = Math.min(FIND_MATCH_VIEW_MARGIN, Math.max(0, (viewportHeight - bottomInset - match.height) / 2));
  const top = margin;
  const bottom = viewportHeight - margin - bottomInset;
  if (match.top < top) return match.top - top;
  if (match.top + match.height > bottom) return match.top + match.height - bottom;
  return 0;
}

/** A code line's tokens cut at the find matches: each piece keeps its token kind, and `match` is the match's index in the code. */
export function splitTokensAtMatches<T extends { kind: unknown; text: string }>(tokens: ReadonlyArray<T>, ranges: ReadonlyArray<{ start: number; end: number; index: number }>, lineStart: number): (T & { match: number | null })[] {
  const out: (T & { match: number | null })[] = [];
  let at = lineStart;
  for (const token of tokens) {
    let offset = 0;
    while (offset < token.text.length) {
      const pos = at + offset;
      const inside = ranges.find((range) => pos >= range.start && pos < range.end);
      const nextEdge = inside ? inside.end : Math.min(...ranges.filter((range) => range.start > pos).map((range) => range.start), at + token.text.length);
      const end = Math.min(token.text.length, nextEdge - at);
      out.push({ ...token, text: token.text.slice(offset, end), match: inside ? inside.index : null });
      offset = end;
    }
    at += token.text.length;
  }
  return out;
}

/** Where `query` occurs in `code` (case-insensitive, non-overlapping), with each match's line and column. */
export function findCodeMatches(code: string, query: string): { start: number; end: number; index: number; line: number; column: number }[] {
  const needle = normalizeFindQuery(query).toLowerCase();
  if (!needle) return [];
  const haystack = code.toLowerCase();
  const out: { start: number; end: number; index: number; line: number; column: number }[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    const before = code.slice(0, at);
    const line = before.split("\n").length - 1;
    out.push({ start: at, end: at + needle.length, index: out.length, line, column: at - (before.lastIndexOf("\n") + 1) });
  }
  return out;
}
