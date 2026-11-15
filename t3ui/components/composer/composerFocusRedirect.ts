// Type-to-focus (chat/composerFocusRedirect.ts): a printable key pressed while nothing holds the keyboard goes to
// the composer instead of falling through to the system beep. The keymap's `notEditing` option is the port's
// "no editable element is focused" test; the overlay guards below are the reference's floating-layer test.
import { keymap } from "nsh";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
const SHIFTED_DIGITS = ")!@#$%^&*(";
/** Unshifted punctuation keys on the US layout, as the keymap names them, and what they type with and without Shift. */
const PUNCTUATION: ReadonlyArray<readonly [key: string, plain: string, shifted: string]> = [
  ["minus", "-", "_"], ["plus", "=", "+"], ["[", "[", "{"], ["]", "]", "}"], ["\\", "\\", "|"], [";", ";", ":"],
  ["'", "'", "\""], [",", ",", "<"], [".", ".", ">"], ["/", "/", "?"], ["`", "`", "~"],
];

/** Every keystroke that types a character, with the character it types. */
export const TYPE_TO_FOCUS_KEYS: ReadonlyArray<{ keystroke: string; text: string }> = [
  ...LETTERS.flatMap((letter) => [{ keystroke: letter, text: letter }, { keystroke: `shift+${letter}`, text: letter.toUpperCase() }]),
  ...DIGITS.flatMap((digit, index) => [{ keystroke: digit, text: digit }, { keystroke: `shift+${digit}`, text: SHIFTED_DIGITS[index]! }]),
  ...PUNCTUATION.flatMap(([key, plain, shifted]) => [{ keystroke: key, text: plain }, { keystroke: `shift+${key}`, text: shifted }]),
  { keystroke: "space", text: " " },
];

/** What owns the keyboard besides a text input: any of these open keeps type-to-focus off (shouldRedirectInputToComposer). */
export interface RedirectGuards {
  paletteOpen: boolean;
  settingsOpen: boolean;
  usageOpen: boolean;
  modelPickerOpen: boolean;
  suggestionMenuOpen: boolean;
  stashOpen: boolean;
  /** Any registered popover, menu or dialog (nativeOcclusion). */
  overlayOpen: boolean;
}

export function shouldRedirectInput(guards: RedirectGuards): boolean {
  return !(guards.paletteOpen || guards.settingsOpen || guards.usageOpen || guards.modelPickerOpen || guards.suggestionMenuOpen || guards.stashOpen || guards.overlayOpen);
}

/**
 * Binds every typing key, and the paste chord, to `onText` / `onPaste` while `enabled()` says nothing else owns the
 * keyboard. The keymap only fires them while no text input has the focus. Returns the unbind function.
 */
export function bindTypeToFocus(input: { enabled: () => boolean; onText: (text: string) => void; onPaste: () => void }): () => void {
  const guarded = (action: () => void) => () => { if (input.enabled()) action(); };
  const bindings: Record<string, () => void> = {};
  for (const { keystroke, text } of TYPE_TO_FOCUS_KEYS) bindings[keystroke] = guarded(() => input.onText(text));
  const removers: Array<() => void> = [];
  for (const [keystroke, handler] of Object.entries(bindings)) {
    try { removers.push(keymap.bind(keystroke, handler, { when: "notEditing", repeat: true })); } catch { /* a layout the keymap rejects */ }
  }
  try { removers.push(keymap.bind("mod+v", guarded(input.onPaste), { when: "notEditing" })); } catch { /* none */ }
  return () => { for (const remove of removers) remove(); };
}
