// packages/shared/src/searchRanking.ts: the scoring the slash and skill menus rank with.
export interface RankedSearchResult<T> { item: T; score: number; tieBreaker: string }

export function normalizeSearchQuery(input: string, options?: { trimLeadingPattern?: RegExp }): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return options?.trimLeadingPattern ? trimmed.replace(options.trimLeadingPattern, "").toLowerCase() : trimmed.toLowerCase();
}

export function scoreSubsequenceMatch(value: string, query: string, options?: { ignorePosition?: boolean }): number | null {
  if (!query) return 0;
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      if (options?.ignorePosition) return gapPenalty * 3 + spanPenalty;
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + Math.min(64, value.length - query.length);
    }
  }
  return null;
}

const lengthPenalty = (value: string, query: string) => Math.min(64, Math.max(0, value.length - query.length));

function findBoundaryMatchIndex(value: string, query: string, markers: readonly string[]): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (best === null || matchIndex < best) best = matchIndex;
  }
  return best;
}

/** value and query must already be trimmed and lowercased. */
export function scoreQueryMatch(input: {
  value: string; query: string; exactBase: number; prefixBase?: number; boundaryBase?: number; includesBase?: number;
  fuzzyBase?: number; boundaryMarkers?: readonly string[]; ignorePosition?: boolean;
}): number | null {
  const { value, query } = input;
  const ignorePosition = input.ignorePosition === true;
  const penalty = ignorePosition ? 0 : lengthPenalty(value, query);
  if (!value || !query) return null;
  if (value === query) return input.exactBase;
  if (input.prefixBase !== undefined && value.startsWith(query)) return input.prefixBase + penalty;
  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(value, query, input.boundaryMarkers ?? [" ", "-", "_", "/"]);
    if (boundaryIndex !== null) return input.boundaryBase + (ignorePosition ? 0 : boundaryIndex * 2) + penalty;
  }
  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) return input.includesBase + (ignorePosition ? 0 : includesIndex * 2) + penalty;
  }
  if (input.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query, { ignorePosition });
    if (fuzzy !== null) return input.fuzzyBase + fuzzy;
  }
  return null;
}

export function sortRanked<T>(entries: RankedSearchResult<T>[]): T[] {
  return [...entries].sort((a, b) => a.score - b.score || a.tieBreaker.localeCompare(b.tieBreaker)).map((entry) => entry.item);
}
