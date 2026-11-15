// The message search's text rules, from packages/shared/src/paletteSearch.ts: which words of a query the server searches messages for
// (`messageSearchTokens`), and where they fall in a result's snippet (`findSearchTokenRanges`, `splitSearchText`) so the excerpt can set
// them in semibold foreground (components/ThreadSearchMatch.tsx).
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const COMBINING_MARKS = /\p{M}/gu;
// Emoji and other symbols can be searched for, so they start words too.
const SYMBOL = /\p{So}/u;
const APOSTROPHE = /['’]/;
const CURLY_APOSTROPHES = /[‘’]/g;
const WRAPPING_QUOTES = /^\s*["'`“”‘’]+|["'`“”‘’]+\s*$/g;
const MESSAGE_TOKEN_MIN_LENGTH = 3;
// A message token shorter than this must start a word: "fts" is not in "drafts".
const MESSAGE_WORD_START_LENGTH = 4;

export interface SearchRange { readonly start: number; readonly end: number }
export interface SearchTextPart { readonly text: string; readonly highlighted: boolean; readonly start: number }

function foldCharacter(character: string): string {
  return character.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase().replace("ς", "σ").replace(/[‘’]/, "'");
}

/** Case and accents folded one UTF-16 unit at a time, so offsets and word starts still read from the source. */
function foldInPlace(text: string): string {
  return text.replace(/[\u0080-￿]/g, (character) => {
    const folded = foldCharacter(character);
    return folded.length === 1 ? folded : character;
  }).toLowerCase();
}

function isCjk(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

/** Two Chinese, Japanese, or Korean characters already make a common word. */
function hasCjkWord(token: string): boolean {
  return Array.from(token).some((character) => {
    const code = character.codePointAt(0)!;
    return isCjk(character) || (code >= 0xac00 && code <= 0xd7af);
  });
}

function isWordStart(beforePrevious: string, previous: string, character: string, next: string): boolean {
  // "Julius’s": a possessive or contraction does not start a word.
  const afterApostrophe = APOSTROPHE.test(previous) && ALPHANUMERIC.test(beforePrevious);
  return (
    (ALPHANUMERIC.test(character) || SYMBOL.test(character)) &&
    !afterApostrophe &&
    (previous === "" ||
      !ALPHANUMERIC.test(previous) ||
      (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
      // The last capital of an acronym starts the next word: "JSONSchema".
      (UPPERCASE.test(previous) && UPPERCASE.test(character) && LOWERCASE.test(next)) ||
      DIGIT.test(previous) !== DIGIT.test(character) ||
      isCjk(character))
  );
}

function foldSearchField(source: string): { text: string; wordStarts: Uint8Array } {
  const wordStarts = new Uint8Array(source.length);
  const characters = Array.from(source);
  let index = 0;
  for (const [position, character] of characters.entries()) {
    if (isWordStart(characters[position - 2] ?? "", characters[position - 1] ?? "", character, characters[position + 1] ?? "")) wordStarts[index] = 1;
    index += character.length;
  }
  return { text: foldInPlace(source), wordStarts };
}

/** Folded, whitespace-collapsed query; empty when there is nothing to match. */
export function foldSearchQuery(query: string): string {
  return foldInPlace(query.replace(WRAPPING_QUOTES, "").normalize("NFC")).split(/\s+/).filter((token) => token.length > 0).join(" ");
}

/** The query's words: `long` ones (three letters, or two Chinese, Japanese or Korean characters) are what messages are searched for. */
export function messageSearchTokens(query: string): { long: string[]; short: string[]; words: string[] } {
  const tokens = query
    .replace(WRAPPING_QUOTES, "")
    .replace(CURLY_APOSTROPHES, "'")
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const searchable = (token: string) => {
    const length = Array.from(token).length;
    return length >= MESSAGE_TOKEN_MIN_LENGTH || (length === 2 && hasCjkWord(token));
  };
  return { long: tokens.filter(searchable), short: tokens.filter((token) => !searchable(token)), words: tokens };
}

function mergeRanges(ranges: ReadonlyArray<SearchRange>): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** Where the query's long tokens fall in `text`; a short long token only counts where it starts a word. */
export function findSearchTokenRanges(text: string, query: string): SearchRange[] {
  const tokens = new Map(
    messageSearchTokens(query).long
      .map((token) => [foldSearchQuery(token), Array.from(token).length < MESSAGE_WORD_START_LENGTH] as const)
      // Some tokens fold to nothing, which would match everywhere.
      .filter(([token]) => token.length > 0),
  );
  if (tokens.size === 0) return [];
  const field = foldSearchField(text);
  const ranges: SearchRange[] = [];
  for (const [token, needsWordStart] of tokens) {
    // A token that opens with punctuation brings its own boundary, as in scoring.
    const ownBoundary = !ALPHANUMERIC.test(token[0]!) && !SYMBOL.test(token[0]!);
    for (let index = field.text.indexOf(token); index !== -1;) {
      if (needsWordStart && !ownBoundary && !field.wordStarts[index]) {
        index = field.text.indexOf(token, index + 1);
        continue;
      }
      ranges.push({ start: index, end: index + token.length });
      index = field.text.indexOf(token, index + token.length);
    }
  }
  return mergeRanges(ranges);
}

/** `text` cut into plain and highlighted parts at sorted, non-overlapping `ranges`. */
export function splitSearchText(text: string, ranges: ReadonlyArray<SearchRange>): SearchTextPart[] {
  const parts: SearchTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
    parts.push({ text: text.slice(range.start, range.end), highlighted: true, start: range.start });
    cursor = range.end;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  return parts;
}

/** Longer queries are cut to this before they are sent (THREAD_SEARCH_QUERY_MAX_LENGTH). */
export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;
/** A pasted wall of text searches by its start rather than failing the request (useThreadSearch). */
export const normalizeThreadSearchQuery = (query: string): string => query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH).trim();
/** Messages need a word of three or more letters; a shorter query searches nothing on the server. */
export const canSearchThreadMessages = (query: string): boolean => messageSearchTokens(query).long.length > 0;
