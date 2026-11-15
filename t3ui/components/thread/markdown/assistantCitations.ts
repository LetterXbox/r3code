// A user message may quote an assistant reply as `[Assistant quote](t3-citation://v1/<env>/<thread>/<message>?text=...&start=...)`
// (packages/shared assistantCitations.ts, contracts assistantCitations.ts). Parsing and the chip's label; pure.

export const ASSISTANT_CITATION_MAX_TEXT_LENGTH = 8_000;
export const ASSISTANT_CITATION_MAX_COMMENT_LENGTH = 8_000;
export const ASSISTANT_CITATION_CONTEXT_LENGTH = 32;

export interface AssistantCitation {
  version: 1;
  environmentId: string;
  threadId: string;
  messageId: string;
  text: string;
  comment?: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

const CITATION_PROTOCOL = "t3-citation:";
const CITATION_HREF_PREFIX = `${CITATION_PROTOCOL}//v1/`;
// Percent encoding needs up to nine characters per UTF-16 code unit; 16k covers selectors.
const MAX_CITATION_HREF_LENGTH = 9 * (ASSISTANT_CITATION_MAX_TEXT_LENGTH + ASSISTANT_CITATION_MAX_COMMENT_LENGTH) + 16_000;

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function formatAssistantCitationHref(citation: AssistantCitation): string {
  const path = [citation.environmentId, citation.threadId, citation.messageId].map(encodePathPart).join("/");
  const query = new URLSearchParams({ text: citation.text, start: String(citation.start), end: String(citation.end), prefix: citation.prefix, suffix: citation.suffix });
  if (citation.comment !== undefined) query.set("comment", citation.comment);
  return `${CITATION_HREF_PREFIX}${path}?${query}`;
}

export const serializeAssistantCitation = (citation: AssistantCitation): string => `[Assistant quote](${formatAssistantCitationHref(citation)})`;

/** The citation a `t3-citation://v1/` link carries, or null when the link is malformed or breaks the contract's bounds. */
export function parseAssistantCitationHref(href: string): AssistantCitation | null {
  if (!href.startsWith(CITATION_HREF_PREFIX) || href.length > MAX_CITATION_HREF_LENGTH) return null;
  try {
    const url = new URL(href);
    const parts = url.pathname.slice(1).split("/");
    if (url.protocol !== CITATION_PROTOCOL || url.hostname !== "v1" || parts.length !== 3 || url.username || url.password || url.port || url.hash) return null;
    const requiredKeys = ["text", "start", "end", "prefix", "suffix"];
    const comment = url.searchParams.get("comment");
    let size = 0;
    url.searchParams.forEach(() => { size += 1; });
    if (size !== requiredKeys.length + (comment === null ? 0 : 1) || requiredKeys.some((key) => url.searchParams.getAll(key).length !== 1)) return null;
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "";
    if (!/^\d{1,16}$/.test(start) || !/^\d{1,16}$/.test(end)) return null;
    const citation: AssistantCitation = {
      version: 1,
      environmentId: decodeURIComponent(parts[0]!),
      threadId: decodeURIComponent(parts[1]!),
      messageId: decodeURIComponent(parts[2]!),
      text: url.searchParams.get("text") ?? "",
      start: Number(start),
      end: Number(end),
      prefix: url.searchParams.get("prefix") ?? "",
      suffix: url.searchParams.get("suffix") ?? "",
      ...(comment === null ? {} : { comment }),
    };
    const ids = [citation.environmentId, citation.threadId, citation.messageId];
    if (ids.some((id) => id.trim().length === 0 || id.length > 512)) return null;
    if (citation.text.length === 0 || citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH || citation.text.trim().length === 0) return null;
    if (comment !== null && comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return null;
    if (citation.prefix.length > ASSISTANT_CITATION_CONTEXT_LENGTH || citation.suffix.length > ASSISTANT_CITATION_CONTEXT_LENGTH) return null;
    if (!Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end) || citation.end <= citation.start) return null;
    return citation;
  } catch {
    return null;
  }
}

/** The chip's text: the comment else the quote, whitespace folded, cut at 64 characters without splitting a surrogate pair. */
export function assistantCitationLabel(citation: AssistantCitation): string {
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  if (preview.length <= 64) return preview;
  let end = 64;
  const previous = preview.charCodeAt(end - 1);
  const next = preview.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return `${preview.slice(0, end)}…`;
}

const CITATION_LINK = new RegExp(String.raw`\[Assistant quote\]\((${CITATION_HREF_PREFIX}[^\s)]{1,${MAX_CITATION_HREF_LENGTH - CITATION_HREF_PREFIX.length}})\)`, "g");

/** collectAssistantCitations: each `[Assistant quote](t3-citation://v1/...)` link in a text, with where it sits. */
export function collectAssistantCitations(text: string): { citation: AssistantCitation; source: string; start: number; end: number }[] {
  const citations: { citation: AssistantCitation; source: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(CITATION_LINK)) {
    const citation = parseAssistantCitationHref(match[1]!);
    if (!citation) continue;
    citations.push({ citation, source: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return citations;
}

/** withAssistantCitationComment: the citation with `comment` trimmed, or without one when it is blank. */
export function withAssistantCitationComment(citation: AssistantCitation, comment: string): AssistantCitation {
  const { comment: _previous, ...source } = citation;
  const trimmed = comment.trim();
  return trimmed ? { ...source, comment: trimmed } : source;
}

/** formatAssistantCitationForComposer: the link the composer inserts, with its trailing space. */
export const formatAssistantCitationForComposer = (citation: AssistantCitation, comment = "") => `${serializeAssistantCitation(withAssistantCitationComment(citation, comment))} `;
