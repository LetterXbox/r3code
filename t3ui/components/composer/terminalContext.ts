// Terminal output as a prompt reference (ComposerPendingTerminalContexts, TerminalContextInlineChip): "Add selection to
// chat" from a terminal puts a `[label](t3-context://v1/terminal/<id>)` token into the open thread's prompt and attaches
// the selected lines as a `terminal` context record, which the send carries.
import { composerDraft, openThread, setComposerDraft } from "../../store";
import { attachExtraContext, extraContextMarker, terminalContextRecord } from "./contextChips";

export interface TerminalSelection { terminalId: string; terminalLabel: string; lineStart: number; lineEnd: number; text: string }

/** The prompt with the marker appended after its text, one space apart. */
export function promptWithReference(prompt: string, marker: string): string {
  if (prompt.length === 0) return `${marker} `;
  return `${prompt}${/\s$/.test(prompt) ? "" : " "}${marker} `;
}

// composerDraftStore setContextInsertionHandler: the mounted editor registers how it puts a reference at its caret; a producer
// (terminal selection, preview annotation) asks it first and appends to the prompt only when no editor is mounted.
type ContextInsertionHandler = (marker: string) => boolean;
let insertionHandler: ContextInsertionHandler | null = null;
/** Registers the mounted editor's insertion; returns the function that unregisters it (only if it is still the registered one). */
export function setContextInsertionHandler(handler: ContextInsertionHandler): () => void {
  insertionHandler = handler;
  return () => { if (insertionHandler === handler) insertionHandler = null; };
}
/** The caret-side of a marker: a space before it unless the caret follows whitespace or the start, one after it. */
export function markerAtCaret(before: string, marker: string): string {
  return `${before.length === 0 || /\s$/.test(before) ? "" : " "}${marker} `;
}
/** Puts a reference in the open composer: at the editor's caret when an editor is mounted, else at the end of the draft. */
export function placeContextReference(marker: string): void {
  if (insertionHandler?.(marker)) return;
  setComposerDraft(promptWithReference(composerDraft(), marker));
}

/** Adds a terminal selection to the open thread's composer; false when nothing is selected or no thread is open. */
export function addTerminalSelectionToChat(selection: TerminalSelection): boolean {
  const thread = openThread();
  if (!thread || selection.text.trim().length === 0) return false;
  const record = terminalContextRecord(selection);
  attachExtraContext(thread.id, record);
  placeContextReference(extraContextMarker(record));
  return true;
}
