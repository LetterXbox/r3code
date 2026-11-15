// lib/assistantTextSelection.ts, on the texts the host lists for a message (host patch 0011 `selection.texts` /
// `selection.changed`'s `source`): the message's rendered text is its texts in document order, one line break between
// blocks (readAssistantText's block separator), attachments (U+FFFC, the chips' places) left out. Offsets are UTF-16 and
// measured on that text after whitespace normalization, as the reference's selectors are.
import { ASSISTANT_CITATION_CONTEXT_LENGTH, type AssistantCitation } from "../markdown/assistantCitations";

export interface AssistantTextSelector { text: string; start: number; end: number; prefix: string; suffix: string }
export interface TextPoint { text: number; offset: number }

const ATTACHMENT = "￼";
const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ");

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The texts as one stream, and where each text starts in it (attachments removed). */
export function readAssistantText(texts: readonly string[]): { text: string; starts: number[] } {
  const parts: string[] = [];
  const starts: number[] = [];
  let length = 0;
  texts.forEach((raw, index) => {
    if (index > 0 && length > 0) { parts.push("\n"); length += 1; }
    starts.push(length);
    const clean = raw.split(ATTACHMENT).join("");
    parts.push(clean);
    length += clean.length;
  });
  return { text: parts.join(""), starts };
}

/** A host offset (in text `index`, attachments counted) as an offset of the stream. */
function streamOffset(texts: readonly string[], starts: number[], point: TextPoint): number {
  const raw = texts[point.text] ?? "";
  const before = raw.slice(0, Math.min(point.offset, raw.length)).split(ATTACHMENT).join("").length;
  return (starts[point.text] ?? 0) + before;
}

/** A stream offset back as a host point (the text it falls in, its offset there with attachments counted). */
export function streamPoint(texts: readonly string[], starts: number[], offset: number, _end: boolean): TextPoint {
  let index = 0;
  for (let i = 0; i < starts.length; i += 1) if (offset >= starts[i]!) index = i;
  const raw = texts[index] ?? "";
  let want = Math.max(0, offset - (starts[index] ?? 0));
  let at = 0;
  for (; at < raw.length && want > 0; at += 1) if (raw[at] !== ATTACHMENT) want -= 1;
  return { text: index, offset: at };
}

export function createAssistantTextSelector(text: string, rawStart: number, rawEnd: number): AssistantTextSelector | null {
  const quote = text.slice(rawStart, rawEnd);
  if (quote.trim().length === 0) return null;
  const normalized = normalizeWhitespace(text);
  let start = normalizeWhitespace(text.slice(0, rawStart)).length;
  if (rawStart > 0 && /\s/.test(text[rawStart - 1]!) && /\s/.test(text[rawStart]!)) start -= 1;
  const end = normalizeWhitespace(text.slice(0, rawEnd)).length;
  let prefixStart = Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH);
  let suffixEnd = Math.min(normalized.length, end + ASSISTANT_CITATION_CONTEXT_LENGTH);
  // A split pair becomes a replacement character when the context enters a URL.
  if (splitsSurrogatePair(normalized, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(normalized, suffixEnd)) suffixEnd -= 1;
  return { text: quote, start, end, prefix: normalized.slice(prefixStart, start), suffix: normalized.slice(end, suffixEnd) };
}

/** Offsets use normalized UTF-16 units. Saved offsets may drift, so they cannot break context ties. */
export function findAssistantCitationText(text: string, selector: AssistantTextSelector): { start: number; end: number } | null {
  const normalized = normalizeWhitespace(text);
  const quote = normalizeWhitespace(selector.text);
  if (quote.trim().length === 0) return null;
  const prefix = normalizeWhitespace(selector.prefix);
  const suffix = normalizeWhitespace(selector.suffix);
  const matchesContext = (start: number, end: number) =>
    normalized.slice(Math.max(0, start - prefix.length), start) === prefix && normalized.slice(end, end + suffix.length) === suffix;
  let match = Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end) && selector.start >= 0
    && selector.end - selector.start === quote.length && normalized.slice(selector.start, selector.end) === quote && matchesContext(selector.start, selector.end)
    ? { start: selector.start, end: selector.end } : null;
  let onlyQuote: { start: number; end: number } | null = null;
  let quoteCount = 0;
  for (let start = normalized.indexOf(quote); start !== -1; start = normalized.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    quoteCount += 1;
    onlyQuote = { start, end };
    if (!matchesContext(start, end)) continue;
    if (match !== null && match.start !== start) return null;
    match = { start, end };
  }
  return match ?? (quoteCount === 1 ? onlyQuote : null);
}

export function rawTextOffset(text: string, normalizedOffset: number): number {
  let offset = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const whitespace = /\s/.test(match[0][0]!);
    const length = whitespace ? 1 : match[0].length;
    if (normalizedOffset <= offset + length) return (match.index ?? 0) + (whitespace && normalizedOffset > offset ? match[0].length : normalizedOffset - offset);
    offset += length;
  }
  return text.length;
}

/** captureAssistantTextSelection: the selector of a host selection (start / end in the message's texts). */
export function captureAssistantTextSelection(texts: readonly string[], start: TextPoint, end: TextPoint): AssistantTextSelector | null {
  const stream = readAssistantText(texts);
  const rawStart = streamOffset(texts, stream.starts, start);
  const rawEnd = streamOffset(texts, stream.starts, end);
  if (rawEnd <= rawStart) return null;
  return createAssistantTextSelector(stream.text, rawStart, rawEnd);
}

/** resolveAssistantCitationRange: where a citation's quote is in the message's texts now, or null. */
export function resolveAssistantCitationRange(texts: readonly string[], citation: Pick<AssistantCitation, "text" | "start" | "end" | "prefix" | "suffix">): { start: TextPoint; end: TextPoint } | null {
  const stream = readAssistantText(texts);
  const match = findAssistantCitationText(stream.text, citation);
  if (match === null) return null;
  const start = rawTextOffset(stream.text, match.start);
  const end = rawTextOffset(stream.text, match.end);
  if (end <= start) return null;
  return { start: streamPoint(texts, stream.starts, start, false), end: streamPoint(texts, stream.starts, end, true) };
}
