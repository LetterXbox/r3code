import { expect, test } from "nsh/test";
import { captureAssistantTextSelection, readAssistantText, resolveAssistantCitationRange } from "./citationText";
import { citationHighlightOpacity, CITATION_HIGHLIGHT_TOTAL_MS, COULD_NOT_LOAD, loadCitedHistory, MAX_CITATION_PAGES, NOT_ASSISTANT, resolveAssistantCitationCommentDismissal, resolveCitationPhase, UNAVAILABLE, type CitedThreadSnapshot, type HistoryPageResult } from "./citationProcedure";
import { selectionToMarkdown, normalizeSelection } from "./hostSelection";
import { collectPromptTokens } from "../../composer/editor/promptDocument";
import { formatAssistantCitationForComposer, parseAssistantCitationHref, serializeAssistantCitation, withAssistantCitationComment, type AssistantCitation } from "../markdown/assistantCitations";

const texts = ["First paragraph with a claim.", "Second ￼paragraph   repeats a claim."];

test("a host selection becomes a selector over the message's rendered text, and resolves back", () => {
  expect(readAssistantText(texts).text).toBe("First paragraph with a claim.\nSecond paragraph   repeats a claim.");
  // "repeats a claim" in the second text (offsets count the attachment).
  const start = { text: 1, offset: texts[1]!.indexOf("repeats") };
  const end = { text: 1, offset: texts[1]!.indexOf(".", start.offset) };
  const selector = captureAssistantTextSelection(texts, start, end)!;
  expect(selector.text).toBe("repeats a claim");
  expect(selector.prefix.endsWith("paragraph ")).toBe(true);
  const citation: AssistantCitation = { version: 1, environmentId: "env", threadId: "t", messageId: "m", ...selector };
  const range = resolveAssistantCitationRange(texts, citation)!;
  expect(range).toEqual({ start, end });
  // Across blocks: the whole first text and the start of the second.
  const across = captureAssistantTextSelection(texts, { text: 0, offset: 6 }, { text: 1, offset: 6 })!;
  expect(across.text).toBe("paragraph with a claim.\nSecond");
  // Changed source text: no range.
  expect(resolveAssistantCitationRange(["Something else."], citation)).toBe(null);
  // Blank selections cite nothing.
  expect(captureAssistantTextSelection(["a   b"], { text: 0, offset: 1 }, { text: 0, offset: 3 })).toBe(null);
});

test("the citation goes into the composer as a token, with its comment saved in the link", () => {
  const citation: AssistantCitation = { version: 1, environmentId: "env", threadId: "t", messageId: "m", text: "a claim", start: 1, end: 8, prefix: "", suffix: "" };
  const inserted = formatAssistantCitationForComposer(citation);
  expect(inserted.endsWith(" ")).toBe(true);
  const tokens = collectPromptTokens(`see ${inserted}`, { skills: new Map() });
  expect(tokens.map((token) => [token.kind, token.value])).toEqual([["citation", "a claim"]]);
  const commented = withAssistantCitationComment(citation, "  why?  ");
  expect(commented.comment).toBe("why?");
  expect(parseAssistantCitationHref(serializeAssistantCitation(commented).slice("[Assistant quote](".length, -1))?.comment).toBe("why?");
  expect(withAssistantCitationComment(commented, " ").comment).toBe(undefined);
});

test("Go to source pages history up to 20 times and names each failure", async () => {
  const run = async (snapshots: CitedThreadSnapshot[], pages: HistoryPageResult[] = []) => {
    let reads = 0; let loads = 0;
    const outcome = await loadCitedHistory({
      signal: { aborted: false },
      readThread: async () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
      loadThrough: async () => pages[Math.min(loads++, Math.max(0, pages.length - 1))] ?? "loaded",
    });
    return { outcome, loads };
  };
  expect((await run([{ message: null, hasMoreHistory: true }, { message: "assistant", hasMoreHistory: true }])).outcome).toEqual({ _tag: "found" });
  const endless = await run([{ message: null, hasMoreHistory: true }]);
  expect(endless.outcome).toEqual(COULD_NOT_LOAD);
  expect(endless.loads).toBe(MAX_CITATION_PAGES);
  expect((await run([{ message: null, hasMoreHistory: false }])).outcome).toEqual(UNAVAILABLE);
  expect((await run([{ message: "other", hasMoreHistory: false }])).outcome).toEqual(NOT_ASSISTANT);
  expect((await run([{ message: null, hasMoreHistory: true }], ["error"])).outcome).toEqual(COULD_NOT_LOAD);
  expect((await run([{ message: null, hasMoreHistory: true }], ["noop"])).outcome).toEqual(UNAVAILABLE);
  expect((await run([{ message: null, hasMoreHistory: false, loadFailed: true }])).outcome).toEqual(COULD_NOT_LOAD);
  expect(COULD_NOT_LOAD.title).toBe("Could not load the cited response");
});

test("phase, pulse and comment dismissal follow the reference", () => {
  const messages = [{ id: "m", role: "assistant", entryId: "message:m" }, { id: "u", role: "user", entryId: "message:u" }];
  expect(resolveCitationPhase({ history: { _tag: "found" }, messageId: "m", messages, rowIds: ["message:m"] })).toEqual({ _tag: "ready", rowId: "message:m" });
  expect(resolveCitationPhase({ history: { _tag: "found" }, messageId: "m", messages, rowIds: [] })).toEqual({ _tag: "expanding" });
  expect(resolveCitationPhase({ history: { _tag: "found" }, messageId: "u", messages, rowIds: [] })).toEqual({ _tag: "failed" });
  expect(resolveCitationPhase({ history: { _tag: "loading" }, messageId: "x", messages, rowIds: [] })).toEqual({ _tag: "loading" });
  expect(citationHighlightOpacity(0, false)).toBe(0);
  expect(citationHighlightOpacity(CITATION_HIGHLIGHT_TOTAL_MS, false)).toBe(0);
  expect(Math.abs(citationHighlightOpacity(1800, false) - 0.45) < 0.01).toBe(true);
  expect(Math.abs(citationHighlightOpacity(10, true) - 0.45) < 0.01).toBe(true);
  const rule = (reason: string, draft: string | null, saved?: string) => resolveAssistantCitationCommentDismissal({ reason, draft, savedComment: saved, maxLength: 5 }).kind;
  expect(rule("escape-key", "x")).toBe("close");
  expect(rule("outside-press", null)).toBe("close");
  expect(rule("outside-press", " a ", "a")).toBe("close");
  expect(rule("outside-press", "toolong")).toBe("keep-open");
  expect(rule("outside-press", "ok")).toBe("commit");
});

test("a selection in a cited message copies as Markdown", () => {
  const selection = normalizeSelection({
    empty: false, kind: "area", text: "Bold and code\nnext", pointerDown: false, rect: null, rects: [],
    runs: [
      { block: 0, text: "Bold", bold: true, italic: false, strike: false, underline: false, mono: false, testId: null },
      { block: 0, text: " and ", bold: false, italic: false, strike: false, underline: false, mono: false, testId: null },
      { block: 0, text: "code", bold: false, italic: false, strike: false, underline: false, mono: true, testId: null },
      { block: 1, text: "next", bold: false, italic: true, strike: false, underline: false, mono: false, testId: null },
    ],
    source: { testId: "t3-cite:m", texts: [], start: { text: 0, offset: 0 }, end: { text: 0, offset: 1 } },
  });
  expect(selection.empty).toBe(false);
  if (selection.empty) return;
  expect(selectionToMarkdown(selection)).toBe("**Bold** and `code`\n\n*next*");
  expect(normalizeSelection({ empty: true })).toEqual({ empty: true });
});
