// The find bar's state, shared by the bar, the timeline and ChatMarkdown (match highlighting).
// Kept free of components so commands/standardCommands.ts can register chat.find against it.
import { signal } from "nsh";
import type { ViewRef } from "nsh";

export const threadFindOpen = signal(false);
export const threadFindQuery = signal("");
export const threadFindActiveIndex = signal(0);
/** The first timeline row in view (useThreadFindPositionReader): a new query starts at the first match at or below it. */
export const threadFindViewportRowId = signal<string | null>(null);
/** Bumped by every chat.find so an already-open bar refocuses its input. */
export const threadFindFocusRequest = signal(0);

/** chat.find (mod+f): opens the bar, or refocuses it when it is already open. */
export function openThreadFind() {
  threadFindOpen.set(true);
  threadFindFocusRequest.update((value) => value + 1);
}

export function closeThreadFind() {
  threadFindOpen.set(false);
  threadFindQuery.set("");
  threadFindActiveIndex.set(0);
}

/** The active match (useThreadFindNavigation): its row and which occurrence in it; null while find is closed or matches nothing. */
export const threadFindActive = signal<{ rowId: string; occurrence: number } | null>(null);

/** The markdown block drawing the active match (its highlight in the active colour): the transcript scrolls it into view. */
export const threadFindActiveBlock = signal<ViewRef | null>(null);

/** threadFindHighlights foldsHiding / beforematch: whether row `rowId` holds the active match in `text`, so its folds open. */
export function findRevealsRow(rowId: string | undefined, text: string): boolean {
  const active = threadFindActive();
  const query = activeFindQuery().toLowerCase();
  return rowId !== undefined && query !== "" && active?.rowId === rowId && text.toLowerCase().includes(query);
}

/** The query ChatMarkdown highlights: empty while the bar is closed. */
export function activeFindQuery(): string {
  return threadFindOpen() ? threadFindQuery().trim() : "";
}

/** A find the thread opens once its transcript is in (openThreadFindOnQuery): a palette message hit's query, at its message. */
export interface PendingThreadFind { threadId: string; query: string; start?: { entryId: string; occurrence: number } }
export const pendingThreadFind = signal<PendingThreadFind | null>(null);

export function openThreadFindOnQuery(threadId: string, find: { query: string; start?: { entryId: string; occurrence: number } }) {
  pendingThreadFind.set({ threadId, ...find });
}

/**
 * findForMessageMatch: the find a message search result opens, at the matched message: the whole query when the snippet
 * holds it, else its longest word, written as the snippet writes it.
 */
export function findForMessageMatch(match: { snippet: string; messageId: string | null }, query: string): { query: string; start?: { entryId: string; occurrence: number } } {
  const start = match.messageId ? { start: { entryId: match.messageId, occurrence: 0 } } : {};
  const snippet = match.snippet.replace(/[\u2018\u2019]/g, "'");
  const trimmed = query.trim();
  const at = trimmed ? snippet.toLowerCase().indexOf(trimmed.toLowerCase()) : -1;
  if (at >= 0) return { query: match.snippet.slice(at, at + trimmed.length), ...start };
  const word = trimmed.split(/\s+/).reduce((longest, token) => (token.length > longest.length ? token : longest), "") || trimmed;
  const wordAt = snippet.toLowerCase().indexOf(word.toLowerCase());
  return { query: wordAt >= 0 ? match.snippet.slice(wordAt, wordAt + word.length) : word, ...start };
}
