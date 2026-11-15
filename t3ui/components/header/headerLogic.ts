// Pure rules behind the thread header, ported from ChatHeader.tsx and keybindings.ts.

export type RenameResolution =
  | { action: "commit"; title: string }
  | { action: "reject-empty" }
  | { action: "noop" };

/** ChatHeader's resolveRenameCommit: empty is rejected, unchanged is ignored. */
export function resolveRenameCommit(input: { title: string; originalTitle: string }): RenameResolution {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

/** The web's default bindings for the header's commands (packages/shared/src/keybindings.ts). */
export const HEADER_SHORTCUTS = {
  "terminal.toggle": "mod+j",
  "rightPanel.toggle": "mod+alt+b",
  "threadPanel.toggle": "mod+shift+b",
  "diff.toggle": "mod+d",
} as const;

export type HeaderCommand = keyof typeof HEADER_SHORTCUTS;

const KEY_LABELS: Record<string, string> = { escape: "Esc", enter: "Enter", space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete" };

/** formatShortcutLabel(): macOS draws modifiers as glyphs, others as Ctrl+Alt+Shift+Meta words. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  const keyLabel = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1));
  const mod = mods.has("mod");
  if (mac) {
    return `${mods.has("ctrl") ? "⌃" : ""}${mods.has("alt") ? "⌥" : ""}${mods.has("shift") ? "⇧" : ""}${mod || mods.has("meta") || mods.has("cmd") ? "⌘" : ""}${keyLabel}`;
  }
  const out: string[] = [];
  if (mods.has("ctrl") || mod) out.push("Ctrl");
  if (mods.has("alt")) out.push("Alt");
  if (mods.has("shift")) out.push("Shift");
  if (mods.has("meta") || mods.has("cmd")) out.push("Meta");
  out.push(keyLabel);
  return out.join("+");
}

export function shortcutLabelForCommand(command: HeaderCommand, mac: boolean): string {
  return formatShortcut(HEADER_SHORTCUTS[command], mac);
}

/** PanelLayoutControls tooltips: "Toggle terminal drawer (⌘J)". */
export function withShortcut(text: string, label: string | null): string {
  return label ? `${text} (${label})` : text;
}

// --- narrow layouts ------------------------------------------------------------------------------

const BREADCRUMB_CHAR_WIDTH = 7;
const BREADCRUMB_GAP = 12;
const BREADCRUMB_SEPARATOR = 8;
const BREADCRUMB_TILE = 20;
const BREADCRUMB_MAX_SEGMENT = 160;
/** The title keeps `min-w-10`, 40pt, whatever else gives way. */
const BREADCRUMB_MIN_TITLE = 40;

/**
 * ChatHeader's collapseParentTitle: the parent thread's title gives way to an ellipsis when the
 * breadcrumb (project / parent / title) no longer fits. The web measures its DOM; here the text
 * widths are estimated from the character counts at the header's 14px type.
 */
export function shouldCollapseParentTitle(input: { available: number; projectName: string | null; parentTitle: string; title: string }): boolean {
  const text = (value: string, max: number) => Math.min(max, value.length * BREADCRUMB_CHAR_WIDTH);
  const project = input.projectName === null ? 0 : BREADCRUMB_TILE + 6 + text(input.projectName, BREADCRUMB_MAX_SEGMENT) + BREADCRUMB_GAP + BREADCRUMB_SEPARATOR + BREADCRUMB_GAP;
  const parent = text(input.parentTitle, BREADCRUMB_MAX_SEGMENT) + BREADCRUMB_GAP + BREADCRUMB_SEPARATOR + BREADCRUMB_GAP;
  const title = Math.max(BREADCRUMB_MIN_TITLE, input.title.length * BREADCRUMB_CHAR_WIDTH);
  return project + parent + title > input.available;
}
