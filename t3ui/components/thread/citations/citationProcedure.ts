// chat/citationProcedure.ts: pages history toward the cited message, and where the citation stands for the rows shown.
// The paging is the reference's (up to 20 pages, the same three failures); the port's history is `loadEarlierThreadHistory`
// (store.ts) and its rows ThreadTimeline's.

export type CitedHistory = { readonly _tag: "loading" } | { readonly _tag: "found" } | { readonly _tag: "failed" };
export type CitationPhase = { readonly _tag: "loading" } | { readonly _tag: "expanding" } | { readonly _tag: "ready"; readonly rowId: string } | { readonly _tag: "failed" };
export interface CitedThreadSnapshot { readonly message: "assistant" | "other" | null; readonly hasMoreHistory: boolean; readonly loadFailed?: true }
export type CitedHistoryOutcome = { readonly _tag: "found" } | { readonly _tag: "failed"; readonly title: string; readonly description: string } | { readonly _tag: "aborted" };
export type HistoryPageResult = "loaded" | "noop" | "busy" | "error";

export const MAX_CITATION_PAGES = 20;

export const COULD_NOT_LOAD = {
  _tag: "failed",
  title: "Could not load the cited response",
  description: "Load earlier turns, then click the citation to try again. Your saved quote is unchanged.",
} as const;

export const UNAVAILABLE = {
  _tag: "failed",
  title: "The cited response is unavailable",
  description: "It may have been removed. The selected text is still saved in your citation.",
} as const;

export const NOT_ASSISTANT = {
  _tag: "failed",
  title: "The citation does not refer to an assistant response",
  description: "The selected text is still saved in your citation.",
} as const;

/**
 * Pages history toward the cited message until it is loaded, the thread runs out of history, or loading fails.
 * `readThread` resolves once the thread is settled (loaded, no page in flight), or with null when the signal aborts.
 */
export async function loadCitedHistory(input: {
  readonly signal: { readonly aborted: boolean };
  readonly readThread: () => Promise<CitedThreadSnapshot | null>;
  readonly loadThrough: () => Promise<HistoryPageResult>;
}): Promise<CitedHistoryOutcome> {
  for (let attempts = 0; ; attempts += 1) {
    const thread = await input.readThread();
    if (thread === null || input.signal.aborted) return { _tag: "aborted" };
    if (thread.loadFailed) return COULD_NOT_LOAD;
    if (thread.message === "assistant") return { _tag: "found" };
    if (thread.message === "other") return NOT_ASSISTANT;
    if (!thread.hasMoreHistory) return UNAVAILABLE;
    if (attempts >= MAX_CITATION_PAGES) return COULD_NOT_LOAD;
    let result = await input.loadThrough();
    // A page already in flight (the reader's Load earlier): wait for it and read again.
    if (result === "busy") result = "loaded";
    if (input.signal.aborted) return { _tag: "aborted" };
    if (result === "error") return COULD_NOT_LOAD;
    // A noop page means there is nothing older to load, so re-reading would only spin on the same snapshot.
    if (result === "noop") return UNAVAILABLE;
  }
}

/** Where the citation stands for the rows the timeline shows. */
export function resolveCitationPhase(input: {
  readonly history: CitedHistory;
  readonly messageId: string;
  readonly messages: ReadonlyArray<{ id: string; role: string; entryId: string }>;
  readonly rowIds: ReadonlyArray<string>;
}): CitationPhase {
  if (input.history._tag === "failed") return { _tag: "failed" };
  const source = input.messages.find((message) => message.id === input.messageId);
  if (!source) return { _tag: "loading" };
  if (source.role !== "assistant") return { _tag: "failed" };
  if (input.rowIds.includes(source.entryId)) return { _tag: "ready", rowId: source.entryId };
  return { _tag: "expanding" };
}

// AssistantCitationSource's pulse: 650 ms pulses, a 1575 ms hold, a 450 ms fade, at 0.45 at its peak.
export const CITATION_PULSE_DURATION_MS = 650;
export const CITATION_HIGHLIGHT_HOLD_MS = 1575;
export const CITATION_HIGHLIGHT_FADE_MS = 450;
export const CITATION_HIGHLIGHT_TOTAL_MS = 1.5 * CITATION_PULSE_DURATION_MS + CITATION_HIGHLIGHT_HOLD_MS + CITATION_HIGHLIGHT_FADE_MS;
export const CITATION_HIGHLIGHT_PEAK = 0.45;

/** The highlight's opacity `elapsed` ms into the pulse (the keyframes of root.animate, ease-in-out between them). */
export function citationHighlightOpacity(elapsed: number, reducedMotion: boolean): number {
  const total = CITATION_HIGHLIGHT_TOTAL_MS;
  const holdEnd = total - CITATION_HIGHLIGHT_FADE_MS;
  const frames: Array<[number, number]> = reducedMotion
    ? [[0, CITATION_HIGHLIGHT_PEAK], [holdEnd, CITATION_HIGHLIGHT_PEAK], [total, 0]]
    : [[0, 0], [CITATION_PULSE_DURATION_MS * 0.5, CITATION_HIGHLIGHT_PEAK], [CITATION_PULSE_DURATION_MS, 0], [CITATION_PULSE_DURATION_MS * 1.5, CITATION_HIGHLIGHT_PEAK], [holdEnd, CITATION_HIGHLIGHT_PEAK], [total, 0]];
  if (elapsed <= 0) return frames[0]![1];
  if (elapsed >= total) return 0;
  // ease-in-out over the whole animation (CSS applies the easing to the whole timeline for one effect's keyframes).
  const t = elapsed / total;
  const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const at = eased * total;
  for (let i = 1; i < frames.length; i += 1) {
    const [x1, y1] = frames[i]!;
    const [x0, y0] = frames[i - 1]!;
    if (at <= x1) return y0 + ((y1 - y0) * (at - x0)) / Math.max(1, x1 - x0);
  }
  return 0;
}

/** resolveAssistantCitationCommentDismissal: Escape or no draft closes, unchanged closes, over the limit keeps open, else commits. */
export function resolveAssistantCitationCommentDismissal(input: { reason: string; draft: string | null; savedComment: string | undefined; maxLength: number }):
  { kind: "commit"; comment: string } | { kind: "close" } | { kind: "keep-open" } {
  if (input.reason === "escape-key" || input.draft === null) return { kind: "close" };
  if (input.draft.trim() === (input.savedComment ?? "").trim()) return { kind: "close" };
  if (input.draft.length > input.maxLength) return { kind: "keep-open" };
  return { kind: "commit", comment: input.draft };
}
