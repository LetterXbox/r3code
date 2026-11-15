// Pure rules of the terminal page (third_party/t3-ghostty/entry.ts), kept here so they are tested without a WebView:
// the shell key mappings of ThreadTerminalDrawer.handleBeforeKey (keybindings.ts: terminalNavigationShortcutData,
// terminalDeleteShortcutData, isTerminalClearShortcut) and the selection helpers of the drawer. The page bundles this file;
// it must not import from "nsh" or from the app.

export type ShortcutEventLike = { type?: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const TERMINAL_DELETE_TO_LINE_START = "\u0015";
const TERMINAL_CLEAR = "\u000c";

/** What the shell needs to hear for a key the page maps, and the message shown when writing it fails (the web's copy). */
export type TerminalShellKey = { data: string; failure: string };

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return lower === "esc" ? "escape" : lower;
}

/** Option+Arrow moves by word (everywhere), Cmd+Arrow moves to the line's ends (Mac only). Shift keeps its own meaning. */
export function terminalNavigationShortcutData(event: ShortcutEventLike, mac: boolean): string | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  if (event.shiftKey) return null;
  const key = normalizeKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") return null;
  const moveWord = key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine = key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;
  if (mac) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) return moveWord;
    if (event.metaKey && !event.altKey && !event.ctrlKey) return moveLine;
    return null;
  }
  return event.altKey && !event.metaKey && !event.ctrlKey ? moveWord : null;
}

/** Cmd+Backspace deletes to the start of the line (Mac only). */
export function terminalDeleteShortcutData(event: ShortcutEventLike, mac: boolean): string | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  if (!mac) return null;
  if (normalizeKey(event.key) !== "backspace") return null;
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey ? TERMINAL_DELETE_TO_LINE_START : null;
}

/** Ctrl+L everywhere, Cmd+K on the Mac. */
export function isTerminalClearShortcut(event: ShortcutEventLike, mac: boolean): boolean {
  if (event.type !== undefined && event.type !== "keydown") return false;
  const key = event.key.toLowerCase();
  if (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return true;
  return mac && key === "k" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/** The input the page types into the shell for a mapped key, in the order handleBeforeKey tests them; null for any other key. */
export function terminalShellKey(event: ShortcutEventLike, mac: boolean): TerminalShellKey | null {
  const navigation = terminalNavigationShortcutData(event, mac);
  if (navigation !== null) return { data: navigation, failure: "Failed to move cursor" };
  const removal = terminalDeleteShortcutData(event, mac);
  if (removal !== null) return { data: removal, failure: "Failed to delete terminal input" };
  if (isTerminalClearShortcut(event, mac)) return { data: TERMINAL_CLEAR, failure: "Failed to clear terminal" };
  return null;
}

/** A selection as the composer takes it (TerminalContextSelection without the terminal's identity). */
export type PageSelection = { text: string; lineStart: number; lineEnd: number };

/** terminalSelectionLineRange: 1-based rows of a selection's start and end. */
export function terminalSelectionLineRange(position: { start: { y: number }; end: { y: number } }): { lineStart: number; lineEnd: number } {
  const lineStart = position.start.y + 1;
  return { lineStart, lineEnd: Math.max(lineStart, position.end.y + 1) };
}

/** The selection the page reports, or null when nothing (or only blank lines) is selected (readSelectionAction). */
export function pageSelection(text: string, position: { start: { y: number }; end: { y: number } } | null): (PageSelection & { clipboardText: string }) | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!position || normalized.length === 0) return null;
  return { clipboardText: text, text: normalized, ...terminalSelectionLineRange(position) };
}

/** resolveSelectionActionPosition: the menu point kept inside the terminal's bounds and 8 px inside the viewport. */
export function selectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  pointer: { x: number; y: number } | null;
  selectionEnd: { right: number; bottom: number } | null;
  viewport: { width: number; height: number };
}): { x: number; y: number } {
  const { bounds, pointer, selectionEnd, viewport } = options;
  const preferred = pointer ?? {
    x: selectionEnd?.right ?? bounds.left + bounds.width - 140,
    y: selectionEnd ? selectionEnd.bottom + 4 : bounds.top + 12,
  };
  return {
    x: Math.max(8, Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8)),
    y: Math.max(8, Math.min(Math.max(bounds.top, preferred.y), bounds.top + bounds.height, viewport.height - 8)),
  };
}
