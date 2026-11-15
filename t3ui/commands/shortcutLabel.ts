// The label of a command's shortcut ("⇧⌘N"), from the resolved rules, as the web's
// shortcutLabelForCommand: the newest rule for the command whose when-clause holds,
// skipping a keystroke a newer rule already claimed (so a rebound or shadowed default shows nothing).
import { splitKey } from "../pages/settings/keybindingsLogic";
import { nshKeystroke } from "./keystroke";
import { whenHolds } from "./whenClause";

export interface LabelRule { command: string; key: string; when: string }

const KEY_LABELS: Record<string, string> = {
  " ": "Space", space: "Space", escape: "Esc", esc: "Esc", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
};

/** formatShortcutLabel on macOS: control, option, shift, command, then the key. */
export function formatShortcutLabel(key: string): string {
  const parts = splitKey(key.trim().toLowerCase());
  const name = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  const keyLabel = KEY_LABELS[name] ?? (name.length === 1 ? name.toUpperCase() : name.slice(0, 1).toUpperCase() + name.slice(1));
  return `${mods.has("ctrl") ? "⌃" : ""}${mods.has("alt") ? "⌥" : ""}${mods.has("shift") ? "⇧" : ""}${mods.has("mod") || mods.has("meta") || mods.has("cmd") ? "⌘" : ""}${keyLabel}`;
}

/** The effective key of `command` among `rules` (in order, the newest last), or null. */
export function effectiveShortcut(rules: readonly LabelRule[], command: string, context: Readonly<Record<string, boolean>>): string | null {
  const claimed = new Set<string>();
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (!whenHolds(rule.when, context)) continue;
    const stroke = nshKeystroke(rule.key) ?? rule.key.toLowerCase();
    if (claimed.has(stroke)) continue;
    claimed.add(stroke);
    if (rule.command === command) return rule.key;
  }
  return null;
}

export function shortcutLabelFor(rules: readonly LabelRule[], command: string, context: Readonly<Record<string, boolean>> = {}): string | null {
  const key = effectiveShortcut(rules, command, { isDesktop: true, isWeb: false, ...context });
  return key === null ? null : formatShortcutLabel(key);
}
