// What the copy button writes for a user message (TimelineUserMessageRow plainText): context links as their labels, an
// assistant quote as its text (with `Comment: ...`), image-syntax context links dropped. Everything else stays markdown. Pure.
import { parseAssistantCitationHref } from "./assistantCitations";

const CONTEXT_LINK = /(!?)\[([^\]\n]{0,512})\]\(t3-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([A-Za-z0-9_-]{1,128})\)/g;
const CITATION_LINK = /\[Assistant quote\]\((t3-citation:\/\/v1\/[^\s)]+)\)/g;

export function userMessageCopyText(body: string, labels: Record<string, string> = {}): string {
  let text = body.replace(CITATION_LINK, (source, href: string) => {
    const citation = parseAssistantCitationHref(href);
    if (!citation) return source;
    return citation.comment === undefined ? citation.text : `${citation.text}\nComment: ${citation.comment}`;
  });
  text = text.replace(CONTEXT_LINK, (_whole, _bang: string, label: string, _kind: string, id: string) => label.trim() || labels[id] || id);
  return text;
}
