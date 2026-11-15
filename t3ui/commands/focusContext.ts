// What has the keyboard focus, as the when-clause identifiers the keybindings use:
// composerFocus, terminalFocus, previewFocus and editableFocus. `keymap` cannot tell which
// element is focused, so the element reports it: spread `focusProps("composer")` (or
// "terminal", "preview", "editable") on the input or view; it reports on focus and blur.
// `editableFocus` holds while the composer or any "editable" element (a text field) has focus.
import { signal } from "nsh";
import { defineContext, hasContext } from "./registry";

export type FocusKind = "composer" | "terminal" | "preview" | "editable";

const counts = signal<Record<FocusKind, number>>({ composer: 0, terminal: 0, preview: 0, editable: 0 });

export function reportFocus(kind: FocusKind, focused: boolean) {
  counts.update((all) => ({ ...all, [kind]: Math.max(0, all[kind] + (focused ? 1 : -1)) }));
}

/** The `onFocus` / `onBlur` pair for an element of `kind`. */
export function focusProps(kind: FocusKind) {
  let on = false;
  return {
    onFocus: () => { if (!on) { on = true; reportFocus(kind, true); } },
    onBlur: () => { if (on) { on = false; reportFocus(kind, false); } },
  };
}

export const hasFocus = (kind: FocusKind) => counts()[kind] > 0;

/** Defines the focus contexts nothing else reports; a module that defines one itself (before or after) wins. */
export function installFocusContexts() {
  const define = (name: string, read: () => boolean) => { if (!hasContext(name)) defineContext(name, read); };
  define("composerFocus", () => hasFocus("composer"));
  define("terminalFocus", () => hasFocus("terminal"));
  define("previewFocus", () => hasFocus("preview"));
  // The composer is a text field, so it counts for editableFocus whoever defined composerFocus.
  defineContext("editableFocus", () => hasFocus("editable") || hasFocus("composer"));
}
