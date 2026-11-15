// useAssistantCitationTarget + AssistantCitationSource's observeAssistantCitationSource for ThreadTimeline: a Go to
// source request pages history toward the cited message (citationProcedure), opens the fold hiding it, scrolls its row
// in, then the quote to a third of the view (at most 120 pt from the top), and pulses the quote's highlight (the host's
// `selection.mark`). Escape dismisses it; the reader scrolling the timeline first stops a pending scroll.
import { effect, reduceMotion, signal, token, untracked } from "nsh";
import type { ListRef } from "nsh";
import { parseColor } from "../../composer/tokenColor";
import { showToast } from "../../toast";
import { loadEarlierThreadHistory, threadHistoryFor } from "../../../store";
import { citationRequest, retireCitationRequest, type AssistantCitationRequest } from "./citationState";
import { CITATION_HIGHLIGHT_TOTAL_MS, citationHighlightOpacity, loadCitedHistory, resolveCitationPhase, type CitedThreadSnapshot } from "./citationProcedure";
import { citationSourceTestId, markHostRange, selectionHostAvailable, sourceTexts } from "./hostSelection";
import { resolveAssistantCitationRange } from "./citationText";

export interface CitationNavigationDeps {
  scope: () => { threadId: string | null };
  messages: () => Array<{ id: string; role: string; entryId: string }>;
  rowIds: () => string[];
  revealRow: (entryId: string) => void;
  list: () => ListRef | null;
  scrollTop: () => number;
  viewportHeight: () => number;
  releaseFollow: () => void;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function primaryHex(): string | undefined {
  const rgb = parseColor(String(token("primary")));
  return rgb ? `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}` : undefined;
}

/** Whether a citation is being revealed (the list keeps its own follow out of the way meanwhile). */
export const citationPositioning = signal(false);

export function attachCitationNavigation(deps: CitationNavigationDeps) {
  /** The active activation: dismiss() stops it; `scrolled` once the quote is in place. */
  let active: { key: string; aborted: boolean; scrolled: boolean; ourScrollUntil: number } | null = null;
  const dismissedKeys = new Set<string>();

  const stop = (key: string, dropHighlight: boolean) => {
    if (!active || active.key !== key) return;
    active.aborted = true;
    active = null;
    citationPositioning.set(false);
    if (dropHighlight) void markHostRange(null);
    retireCitationRequest(key);
  };

  /** Escape: the activation is dismissed outright (its highlight too). */
  const dismiss = () => { if (active) { dismissedKeys.add(active.key); stop(active.key, true); } };
  /** The reader scrolled: only a scroll still pending stops. */
  const onScroll = (offset: number) => {
    const current = active;
    if (!current || current.scrolled || performance.now() < current.ourScrollUntil) return;
    void offset;
    dismissedKeys.add(current.key);
    stop(current.key, true);
  };

  const run = async (request: AssistantCitationRequest) => {
    const state = { key: request.key, aborted: false, scrolled: false, ourScrollUntil: 0 };
    active = state;
    citationPositioning.set(true);
    deps.releaseFollow();
    const { citation } = request;
    const fail = (title: string, description: string) => { showToast({ type: "warning", title, description }); stop(state.key, true); };
    // readThread: settled once no history page is in flight and the thread's entries are in.
    const readThread = async (): Promise<CitedThreadSnapshot | null> => {
      for (let waited = 0; ; waited += 50) {
        if (state.aborted) return null;
        const history = threadHistoryFor(citation.threadId);
        const messages = untracked(deps.messages);
        if (!history.loading && (messages.length > 0 || waited >= 3000)) {
          if (messages.length === 0 && history.error) return { message: null, hasMoreHistory: false, loadFailed: true };
          const message = messages.find((entry) => entry.id === citation.messageId);
          return { message: message === undefined ? null : message.role === "assistant" ? "assistant" : "other", hasMoreHistory: history.hasMore };
        }
        await sleep(50);
      }
    };
    const outcome = await loadCitedHistory({ signal: state, readThread, loadThrough: () => loadEarlierThreadHistory(citation.threadId, citation.messageId) });
    if (outcome._tag === "aborted" || state.aborted) return;
    if (outcome._tag === "failed") { fail(outcome.title, outcome.description); return; }
    // resolveCitationPhase: the row may sit inside a collapsed turn fold, which opens first.
    let index = -1;
    let revealed = false;
    for (let attempts = 0; attempts < 120 && !state.aborted; attempts += 1) {
      const phase = resolveCitationPhase({ history: { _tag: "found" }, messageId: citation.messageId, messages: untracked(deps.messages), rowIds: untracked(deps.rowIds) });
      if (phase._tag === "failed") { fail("The citation does not refer to an assistant response", "The selected text is still saved in your citation."); return; }
      if (phase._tag === "ready") { index = untracked(deps.rowIds).indexOf(phase.rowId); break; }
      if (phase._tag === "expanding" && !revealed) {
        revealed = true;
        const entryId = untracked(deps.messages).find((entry) => entry.id === citation.messageId)?.entryId;
        if (entryId) untracked(() => deps.revealRow(entryId));
      }
      await frame();
    }
    const list = deps.list();
    if (state.aborted) return;
    if (index < 0 || !list) { fail("Could not open the cited response", "Click the citation to try again."); return; }
    state.ourScrollUntil = performance.now() + 400;
    list.scrollToIndex({ index, animated: false, viewPosition: 0 });
    // The row must be mounted and measured before quote positioning takes over.
    const testId = citationSourceTestId(citation.messageId);
    let texts: string[] | null = null;
    for (let attempts = 0; attempts < 60 && !state.aborted; attempts += 1) {
      await frame();
      const found = selectionHostAvailable() ? await sourceTexts(testId) : null;
      if (found && found.texts.length > 0) { texts = found.texts; break; }
      if (!selectionHostAvailable() && attempts > 2) break;
    }
    if (state.aborted) return;
    const range = texts ? resolveAssistantCitationRange(texts, citation) : null;
    const color = primaryHex();
    const placed = range ? await markHostRange({ testId, start: range.start, end: range.end, alpha: 0, ...(color ? { color } : {}) }) : null;
    const box = await list.measure();
    if (state.aborted) return;
    const target = placed?.rect ?? (texts ? (await sourceTexts(testId))?.frame ?? null : null);
    if (target && box) {
      const viewport = deps.viewportHeight();
      const offset = Math.max(0, deps.scrollTop() + target.y - box.pagePosition.y - Math.min(120, viewport / 3));
      if (Math.abs(offset - deps.scrollTop()) > 1) {
        const animated = !reduceMotion();
        state.ourScrollUntil = performance.now() + (animated ? 700 : 200);
        list.scrollToOffset({ offset, animated });
        await sleep(animated ? 450 : 32);
      }
    }
    if (state.aborted) return;
    state.scrolled = true;
    citationPositioning.set(false);
    if (!range || !placed) {
      showToast({ type: "warning", title: "The quoted text has changed", description: "Showing the source response. The saved quote is unchanged." });
      stop(state.key, true);
      return;
    }
    // The pulse: 0 -> 0.45 -> 0 -> 0.45, held, then faded (reduced motion: held, then faded).
    const startedAt = performance.now();
    const reduced = reduceMotion();
    while (!state.aborted) {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= CITATION_HIGHLIGHT_TOTAL_MS) break;
      await markHostRange({ testId, start: range.start, end: range.end, alpha: citationHighlightOpacity(elapsed, reduced), ...(color ? { color } : {}) });
      await frame();
    }
    stop(state.key, true);
  };

  effect(() => {
    const request = citationRequest();
    const threadId = deps.scope().threadId;
    if (!request || request.citation.threadId !== threadId || dismissedKeys.has(request.key)) return;
    if (active?.key === request.key) return;
    untracked(() => {
      if (active) stop(active.key, true);
      void run(request);
    });
  });

  return { dismiss, onScroll, active: () => active !== null };
}
