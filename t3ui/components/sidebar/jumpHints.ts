// shouldShowThreadJumpHintsForModifiers + useThreadJumpHintsVisible (keybindings.ts:283, Sidebar.logic.ts:677): while the
// modifiers of a thread.jump.N shortcut are held (and the terminal does not have the focus) the first nine rows show
// their jump shortcut, after 200 ms.
// The host reports modifier changes to JS only as onMouseMove on the views under a resting mouse
// (nsh-platform-gpui input.rs modifiers_changed), so App.tsx's root feeds `noteHeldModifiers`: the hints work while
// the pointer is over the window, not while it is outside it or over a WebView.
import { computed, signal } from "nsh";
import type { Modifiers } from "nsh";
import { activeRules, readContext } from "../../commands/registry";
import { shortcutLabel } from "../../commands/registry";
import { orderedThreadIds } from "./sidebarModel";

export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;
const held = signal<Modifiers>({ control: false, alt: false, shift: false, platform: false });
const shown = signal(false);
let timer: ReturnType<typeof setTimeout> | undefined;

/** The modifiers of a key string such as "mod+1" (mod is Command on macOS). */
export function shortcutModifiers(key: string): Modifiers | null {
  const parts = key.toLowerCase().split("+").map((part) => part.trim());
  if (parts.length < 2) return null;
  const has = (name: string) => parts.slice(0, -1).includes(name);
  return { control: has("ctrl") || has("control"), alt: has("alt") || has("option"), shift: has("shift"), platform: has("mod") || has("cmd") || has("meta") };
}

const sameModifiers = (a: Modifiers, b: Modifiers) => a.control === b.control && a.alt === b.alt && a.shift === b.shift && a.platform === b.platform;

/** Whether `modifiers` are exactly those of some thread.jump.N rule, outside the terminal. */
export function shouldShowThreadJumpHints(modifiers: Modifiers, rules: readonly { command: string; key: string }[], terminalFocus: boolean): boolean {
  if (terminalFocus) return false;
  if (!modifiers.control && !modifiers.alt && !modifiers.shift && !modifiers.platform) return false;
  return rules.some((rule) => /^thread\.jump\.[1-9]$/.test(rule.command) && (() => { const wanted = shortcutModifiers(rule.key); return wanted !== null && sameModifiers(wanted, modifiers); })());
}

export function noteHeldModifiers(modifiers: Modifiers) {
  const prev = held();
  if (sameModifiers(prev, modifiers)) return;
  held.set({ ...modifiers });
  const want = shouldShowThreadJumpHints(modifiers, activeRules(), readContext().terminalFocus === true);
  clearTimeout(timer);
  if (!want) { shown.set(false); return; }
  if (!shown()) timer = setTimeout(() => shown.set(true), THREAD_JUMP_HINT_SHOW_DELAY_MS);
}

export function clearHeldModifiers() { noteHeldModifiers({ control: false, alt: false, shift: false, platform: false }); }

const ordered = computed(() => (shown() ? orderedThreadIds().slice(0, 9) : []));

/** The jump shortcut a row shows now ("⌘1"), or null. */
export function threadJumpLabel(threadId: string): string | null {
  const index = ordered().indexOf(threadId);
  return index === -1 ? null : shortcutLabel(`thread.jump.${index + 1}`);
}
