// The terminal drawer's keyboard, as far as the GPUI host allows (workspace/nsh-runtime-bugs.md, defect 2).
//
// The host ignores WebView focus commands, so opening the drawer cannot make the terminal's WKWebView the first
// responder: keys keep arriving at the app. While the drawer is the place the user means to type (it was just opened,
// or its page reported focus) the composer gives the keyboard up, type-to-focus and the focus restore stay off
// (`terminalFocused()` holds), and the keys the app receives are written to the active drawer terminal's PTY. Once a
// real click makes the WKWebView first responder, the page takes its own keys and the app sees none, so nothing is
// typed twice.
import { keymap, signal } from "nsh";
import { TYPE_TO_FOCUS_KEYS } from "../composer/composerFocusRedirect";

/** True while typing is meant for the drawer's terminal. */
export const drawerTypingWanted = signal(false);

let sink: ((data: string) => void) | null = null;

/** The active drawer terminal registers where forwarded keys go. Returns the unregister function. */
export function setTerminalTypeSink(write: (data: string) => void): () => void {
  sink = write;
  return () => { if (sink === write) sink = null; };
}

/** What each named key or control chord sends to a shell (xterm's sequences). */
export const TERMINAL_KEYS: Readonly<Record<string, string>> = {
  enter: "\r", backspace: "\x7f", tab: "\t", "shift+tab": "\x1b[Z", escape: "\x1b",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", delete: "\x1b[3~",
  "ctrl+a": "\x01", "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+e": "\x05", "ctrl+k": "\x0b", "ctrl+l": "\x0c",
  "ctrl+r": "\x12", "ctrl+u": "\x15", "ctrl+w": "\x17", "ctrl+z": "\x1a",
  // The shell mappings of ThreadTerminalDrawer.handleBeforeKey (terminalPageLogic.ts has the same ones for the page itself).
  "alt+left": "\x1bb", "alt+right": "\x1bf", "cmd+left": "\x01", "cmd+right": "\x05", "cmd+backspace": "\x15", "cmd+k": "\x0c",
};

/** Binds the typing keys to the drawer terminal (only while no text field has the keyboard). Returns the unbind function. */
export function bindTerminalTyping(): () => void {
  const removers: (() => void)[] = [];
  const bind = (keystroke: string, data: string) => {
    try { removers.push(keymap.bind(keystroke, () => { sink?.(data); }, { when: "notEditing", repeat: true })); } catch { /* reserved */ }
  };
  for (const { keystroke, text } of TYPE_TO_FOCUS_KEYS) bind(keystroke, text);
  for (const [keystroke, data] of Object.entries(TERMINAL_KEYS)) bind(keystroke, data);
  return () => { for (const remove of removers) remove(); };
}
