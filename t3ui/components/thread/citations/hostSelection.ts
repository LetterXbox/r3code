// The selection of selectable text, as the GPUI host reports it (third_party/nsh-host patch 0011: `selection.watch`,
// `selection.get`, `selection.clear`, `selection.texts`, `selection.mark`; events `selection.changed`,
// `selection.copy`). It stands in for the web's window.getSelection(), Range rects and CSS highlights. A host without
// the patch rejects `selection.capabilities`: `selectionHostAvailable` stays false and nothing here does anything.
import { Clipboard, host, signal } from "nsh";

export interface HostRect { x: number; y: number; width: number; height: number }
export interface HostTextPoint { text: number; offset: number }
export interface HostSelectionRun { block: number; text: string; bold: boolean; italic: boolean; strike: boolean; underline: boolean; mono: boolean; testId: string | null }
export interface HostSelectionSource { testId: string; texts: string[]; start: HostTextPoint; end: HostTextPoint }
export type HostSelection =
  | { empty: true }
  | { empty: false; kind: "area" | "text"; text: string; pointerDown: boolean; rect: HostRect | null; rects: HostRect[]; runs: HostSelectionRun[]; source: HostSelectionSource | null };

/** The testID prefix of a cited message's selectable view (AssistantCitationSource's data-assistant-citation-source). */
export const CITATION_SOURCE_PREFIX = "t3-cite:";
export const citationSourceTestId = (messageId: string) => `${CITATION_SOURCE_PREFIX}${messageId}`;
export const messageIdOfSource = (testId: string) => (testId.startsWith(CITATION_SOURCE_PREFIX) ? testId.slice(CITATION_SOURCE_PREFIX.length) : null);

export const selectionHostAvailable = signal(false);
export const hostSelection = signal<HostSelection>({ empty: true });

let started: Promise<boolean> | null = null;

/** Starts the host's selection events once (the copy hook too); resolves whether the host has them. */
export function startSelectionHost(): Promise<boolean> {
  if (started) return started;
  started = (async () => {
    try {
      if (!host.available()) return false;
      const names = await host.call("selection.capabilities", null, { timeout: 5000 });
      if (!Array.isArray(names) || !names.includes("selection.watch")) return false;
      host.on("selection.changed", (payload) => hostSelection.set(normalizeSelection(payload)));
      host.on("selection.copy", (payload) => { void copySelection(normalizeSelection(payload)); });
      await host.call("selection.watch", { sourcePrefix: CITATION_SOURCE_PREFIX, copyHook: true }, { timeout: 5000 });
      selectionHostAvailable.set(true);
      return true;
    } catch {
      return false;
    }
  })();
  return started;
}

/** Tests only. */
export function resetSelectionHostForTests() { started = null; selectionHostAvailable.set(false); hostSelection.set({ empty: true }); }

export function normalizeSelection(payload: unknown): HostSelection {
  const value = payload as Partial<Extract<HostSelection, { empty: false }>> & { empty?: boolean } | null;
  if (!value || value.empty !== false || typeof value.text !== "string") return { empty: true };
  return {
    empty: false,
    kind: value.kind === "text" ? "text" : "area",
    text: value.text,
    pointerDown: value.pointerDown === true,
    rect: value.rect ?? null,
    rects: Array.isArray(value.rects) ? value.rects : [],
    runs: Array.isArray(value.runs) ? value.runs : [],
    source: value.source && typeof value.source.testId === "string" ? value.source : null,
  };
}

/** Reads the selection again (after a scroll moved it). */
export async function refreshHostSelection(): Promise<void> {
  if (!selectionHostAvailable()) return;
  try { hostSelection.set(normalizeSelection(await host.call("selection.get", null, { timeout: 5000 }))); } catch { /* gone */ }
}

export async function clearHostSelection(): Promise<void> {
  hostSelection.set({ empty: true });
  if (!selectionHostAvailable()) return;
  try { await host.call("selection.clear", null, { timeout: 5000 }); } catch { /* gone */ }
}

/** The texts of the view with `testId` (a message's), with its frame, or null when it is not mounted. */
export async function sourceTexts(testId: string): Promise<{ texts: string[]; frame: HostRect | null } | null> {
  if (!selectionHostAvailable()) return null;
  try {
    const value = await host.call("selection.texts", { testId }, { timeout: 5000 }) as { texts?: unknown; frame?: HostRect | null } | null;
    return value && Array.isArray(value.texts) ? { texts: value.texts.filter((t): t is string => typeof t === "string"), frame: value.frame ?? null } : null;
  } catch {
    return null;
  }
}

/** Draws `start..end` of the texts of `testId` in `color` at `alpha` (null clears); resolves the range's rects. */
export async function markHostRange(mark: { testId: string; start: HostTextPoint; end: HostTextPoint; alpha: number; color?: string } | null): Promise<{ rect: HostRect | null; rects: HostRect[]; frame: HostRect | null } | null> {
  if (!selectionHostAvailable()) return null;
  try {
    const value = await host.call("selection.mark", mark, { timeout: 5000 }) as { rect?: HostRect | null; rects?: HostRect[]; frame?: HostRect | null } | null;
    return value ? { rect: value.rect ?? null, rects: value.rects ?? [], frame: value.frame ?? null } : null;
  } catch {
    return null;
  }
}

// --- copy (ChatMarkdown handleCopy, chatMarkdownClipboardPayload) ---

function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** The selection as Markdown: its runs' bold, italic, strike and code marks; blocks separated by a blank line. */
export function selectionToMarkdown(selection: Extract<HostSelection, { empty: false }>): string {
  if (selection.runs.length === 0) return selection.text;
  const blocks: string[] = [];
  let current = -1;
  for (const run of selection.runs) {
    if (run.block !== current) { blocks.push(""); current = run.block; }
    let piece = run.text;
    if (!piece) continue;
    if (run.mono) piece = run.text.includes("\n") ? piece : wrapInlineCode(piece);
    else {
      if (run.strike) piece = wrapInlineMarker(piece, "~~");
      if (run.italic) piece = wrapInlineMarker(piece, "*");
      if (run.bold) piece = wrapInlineMarker(piece, "**");
    }
    blocks[blocks.length - 1] += piece;
  }
  return blocks.filter((block) => block.length > 0).join("\n\n");
}

/** `selection.copy`: a selection in a cited message's markdown copies as Markdown, anything else as its text. */
export async function copySelection(selection: HostSelection): Promise<void> {
  if (selection.empty) return;
  const text = selection.source && messageIdOfSource(selection.source.testId) !== null ? selectionToMarkdown(selection) : selection.text;
  try { await Clipboard.writeText(text); } catch { /* the clipboard refused */ }
}
