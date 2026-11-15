// Find in the diff: the web's CodeViewSearch (the patched @pierre/diffs' search panel over the code view). The host's
// DiffView (patch 0011) finds and paints the matches of `search` in the lines it shows and reveals one by index; this
// module holds the panel's state and counts a patch's matches the way the host does (each shown line once, a context
// line twice side by side), so a stack of one DiffView per file can number its matches across files.

/** The panel's search params (SearchPanelWidget's searchParams). */
export interface DiffSearchParams { text: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean }

/** CodeViewSearch's MAX_SEARCH_MATCHES. */
export const MAX_SEARCH_MATCHES = 100_000;
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
const separator = (char: string | undefined) => char === undefined || /\s/u.test(char) || WORD_SEPARATORS.includes(char);

function pattern(params: DiffSearchParams): RegExp | null {
  if (params.text === "") return null;
  const source = params.regex ? params.text : params.text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  try { return new RegExp(source, params.caseSensitive ? "gu" : "giu"); } catch { return null; }
}

/** How many matches `text` holds. */
export function countInLine(text: string, params: DiffSearchParams, re = pattern(params)): number {
  if (!re) return 0;
  re.lastIndex = 0;
  let count = 0;
  for (const match of text.matchAll(re)) {
    if (match[0] === "") continue;
    const start = match.index ?? 0;
    if (params.wholeWord && !(separator(text[start - 1]) && separator(text[start + match[0].length]))) continue;
    count++;
  }
  return count;
}

/** The matches of a file's patch as its DiffView counts them: every hunk line once in one column, a context line in both sides. */
export function countInPatch(patch: string, params: DiffSearchParams, split: boolean): number {
  const re = pattern(params);
  if (!re) return 0;
  let inHunk = false;
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    const mark = line[0];
    if (mark !== " " && mark !== "+" && mark !== "-") continue;
    const found = countInLine(line.slice(1), params, re);
    count += mark === " " && split ? found * 2 : found;
  }
  return Math.min(count, MAX_SEARCH_MATCHES);
}

/** SearchPanelWidget's result text: "No results", "N results" (no current) or "i of N". */
export function searchResultLabel(count: number, current: number | null): string {
  if (count === 0) return "No results";
  return current === null ? `${count} results` : `${current + 1} of ${count}`;
}

/** The next (or previous) match, wrapping as findNextMatch does. */
export function stepMatch(count: number, current: number | null, previous: boolean): number | null {
  if (count === 0) return null;
  if (current === null) return previous ? count - 1 : 0;
  return previous ? (current - 1 + count) % count : (current + 1) % count;
}

/** Global match `index` across files of `counts`: the file and the match within it. */
export function locateMatch(counts: readonly number[], index: number): { file: number; local: number } | null {
  let rest = index;
  for (let file = 0; file < counts.length; file++) {
    if (rest < counts[file]!) return { file, local: rest };
    rest -= counts[file]!;
  }
  return null;
}
