// The keybinding list's pure logic, ported from
// components/settings/KeybindingsSettings.logic.ts and
// packages/shared/src/keybindings.ts (mergeWithDefaultKeybindings).
import type { SettingsPanelRow } from "../../settingsPanels";

export type KeybindingSource = "Default" | "Custom" | "Project";

export interface DefaultRule { command: string; key: string; when: string }

export interface KeybindingRow {
  id: string;
  command: string;
  key: string;
  when: string;
  source: KeybindingSource;
  isUnassigned: boolean;
  defaultKey: string | null;
  defaultWhen: string;
  conflicts: string[];
}

export interface KeybindingGroup { id: string; title: string; rows: KeybindingRow[] }

type Dict = Record<string, unknown>;

/** The web's DEFAULT_KEYBINDINGS, taken from the generated Keybindings panel. */
export function defaultRulesFromPanel(rows: SettingsPanelRow[]): DefaultRule[] {
  return rows.flatMap((row) => (row.command && row.key ? [{ command: row.command, key: row.key, when: row.when ?? "" }] : []));
}

// --- shortcuts --------------------------------------------------------------

/** shortcutToKeybindingInput: a resolved shortcut back to `mod+shift+k`. */
export function shortcutToInput(shortcut: Dict): string {
  const parts: string[] = [];
  if (shortcut.modKey === true) parts.push("mod");
  if (shortcut.metaKey === true) parts.push("meta");
  if (shortcut.ctrlKey === true) parts.push("ctrl");
  if (shortcut.altKey === true) parts.push("alt");
  if (shortcut.shiftKey === true) parts.push("shift");
  const key = String(shortcut.key ?? "");
  parts.push(key === " " ? "space" : key === "escape" ? "esc" : key);
  return parts.join("+");
}

/** whenAstToExpression, for the node shapes in contracts keybindings.ts. */
export function whenToExpression(node: unknown): string {
  const n = node as Dict | undefined;
  if (!n || typeof n !== "object") return "";
  const wrap = (child: unknown) => {
    const c = child as Dict;
    return c.type === "identifier" || c.type === "not" ? whenToExpression(c) : `(${whenToExpression(c)})`;
  };
  switch (n.type) {
    case "identifier": return String(n.name);
    case "not": return `!${wrap(n.node)}`;
    case "and": return `${wrap(n.left)} && ${wrap(n.right)}`;
    case "or": return `${wrap(n.left)} || ${wrap(n.right)}`;
    default: return "";
  }
}

const SYMBOLS: Record<string, string> = {
  mod: "⌘", meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  enter: "↩", esc: "Esc", space: "Space", tab: "Tab", backspace: "⌫", delete: "⌦",
};

/** The pill text for `mod+shift+k`: modifiers as Mac symbols, the key upper-cased. */
export function formatKey(key: string): string {
  return splitKey(key).map((part) => SYMBOLS[part] ?? (part.length === 1 ? part.toUpperCase() : part.toUpperCase())).join(" ");
}

/** One keycap's text in the web's KeybindingPill: mod, shift, alt and ctrl as Mac symbols (Ctrl and Alt off a Mac), a single character upper-cased, anything else as it is. */
export function keycapLabel(part: string): string {
  if (part === "mod") return "⌘";
  if (part === "shift") return "⇧";
  if (part === "alt") return "⌥";
  if (part === "ctrl") return "⌃";
  return part.length === 1 ? part.toUpperCase() : part;
}

/** The keycaps of a keybinding's `mod+shift+k` spelling, one per part (`KeybindingPill`). */
export function keycaps(key: string): string[] {
  return splitKey(key).map(keycapLabel);
}

/** `mod++` is mod and the plus key, so split on a `+` that is followed by a token. */
export function splitKey(key: string): string[] {
  if (key === "+") return ["+"];
  const parts: string[] = [];
  let rest = key;
  while (rest.length > 0) {
    if (rest.endsWith("++")) { parts.unshift("+"); rest = rest.slice(0, -2); continue; }
    const i = rest.lastIndexOf("+");
    if (i <= 0) { parts.unshift(rest); break; }
    parts.unshift(rest.slice(i + 1));
    rest = rest.slice(0, i);
  }
  return parts;
}

// --- labels and groups --------------------------------------------------------

function titleCaseSegment(segment: string): string {
  const words: string[] = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
  }
  return words.join(" ");
}

const FIXED_LABELS: Record<string, string> = {
  "workspace.focusNext": "Focus Next Workspace Area",
  "workspace.focusPrevious": "Focus Previous Workspace Area",
  "composer.sendAlternate": "Composer: Opposite Queue or Steer Action",
  "composer.sendBackground": "Composer: Start in Background",
  "composer.sendAndNewThread": "Composer: Send and Start New Thread",
  "composer.dictation": "Composer: Start or Finish Dictation",
  "thread.steerQueuedMessage": "Queue: Send First Queued Message",
  "thread.editQueuedMessage": "Queue: Edit Last Queued Message",
  "thread.copyReference": "Pull Request: Copy Link or Thread",
  "view.reopenClosed": "Reopen Closed Tab",
  "preview.focusUrl": "Preview: Focus URL",
};

export function commandLabel(command: string): string {
  const fixed = FIXED_LABELS[command];
  if (fixed) return fixed;
  if (command.startsWith("script.") && command.endsWith(".run")) {
    return `Run Script: ${titleCaseSegment(command.slice("script.".length, -".run".length))}`;
  }
  return command.split(".").map(titleCaseSegment).join(": ");
}

const GROUPS = [
  { id: "navigation", title: "Navigation", prefixes: ["sidebar", "rightPanel", "commandPalette", "filePicker", "projectSearch", "editor"] },
  { id: "threads", title: "Threads", prefixes: ["thread", "chat", "pullRequest"] },
  { id: "composer", title: "Composer", prefixes: ["composer", "modelPicker"] },
  { id: "terminal", title: "Terminal", prefixes: ["terminal"] },
  { id: "preview", title: "Preview & diff", prefixes: ["preview", "diff"] },
  { id: "appearance", title: "Appearance", prefixes: ["theme", "appearance", "themeEditor"] },
  { id: "scripts", title: "Project scripts", prefixes: ["script"] },
];
const OTHER = { id: "other", title: "Other", prefixes: [] as string[] };

export function groupRows(rows: KeybindingRow[]): KeybindingGroup[] {
  const buckets = new Map<string, KeybindingRow[]>();
  for (const row of rows) {
    const prefix = row.command.split(".")[0] ?? "";
    const group = GROUPS.find((g) => g.prefixes.includes(prefix)) ?? OTHER;
    buckets.set(group.id, [...(buckets.get(group.id) ?? []), row]);
  }
  return [...GROUPS, OTHER].flatMap((g) => (buckets.has(g.id) ? [{ id: g.id, title: g.title, rows: buckets.get(g.id)! }] : []));
}

// --- rows ---------------------------------------------------------------------

const rowId = (command: string, key: string, when: string) => `${command}\u0000${key}\u0000${when}`;

/** Where the user's rules sit among the defaults (mergeWithDefaultKeybindings). */
export function mergeWithDefaults(defaults: DefaultRule[], custom: DefaultRule[]): DefaultRule[] {
  if (custom.length === 0) return [...defaults];
  const overridden = new Set(custom.map((rule) => rule.command));
  return [...defaults.filter((rule) => !overridden.has(rule.command)), ...custom];
}

/** The server's resolved bindings as `{command, key, when}` rules. */
export function rulesFromResolved(resolved: Dict[]): DefaultRule[] {
  return resolved.flatMap((binding) => {
    const shortcut = binding.shortcut as Dict | undefined;
    if (typeof binding.command !== "string" || !shortcut) return [];
    return [{ command: binding.command, key: shortcutToInput(shortcut), when: whenToExpression(binding.whenAst) }];
  });
}

const whenConflicts = (a: string, b: string) => a !== "false" && b !== "false" && (a === "" || b === "" || a === b);

export function buildRows(defaults: DefaultRule[], custom: DefaultRule[]): KeybindingRow[] {
  const isDefault = (rule: DefaultRule) => defaults.some((d) => d.command === rule.command && d.key === rule.key && d.when === rule.when);
  const defaultFor = (rule: DefaultRule) =>
    defaults.find((d) => d.command === rule.command && d.key === rule.key && d.when === rule.when) ??
    (rule.when === "false" ? defaults.find((d) => d.command === rule.command && d.key === rule.key) : undefined) ??
    defaults.find((d) => d.command === rule.command && d.when === rule.when) ??
    defaults.find((d) => d.command === rule.command);
  const byId = new Map<string, KeybindingRow>();
  for (const rule of mergeWithDefaults(defaults, custom)) {
    const def = defaultFor(rule);
    byId.set(rowId(rule.command, rule.key, rule.when), {
      id: rowId(rule.command, rule.key, rule.when),
      command: rule.command,
      key: rule.key,
      when: rule.when,
      source: rule.command.startsWith("script.") ? "Project" : isDefault(rule) ? "Default" : "Custom",
      isUnassigned: rule.when === "false" && def !== undefined && rule.key === def.key,
      defaultKey: def?.key ?? null,
      defaultWhen: def?.when ?? "",
      conflicts: [],
    });
  }
  const rows = [...byId.values()];
  const withConflicts = rows.map((row) => {
    const labels = conflictLabels(rows, row.id, row.key, row.when);
    return labels.length > 0 ? { ...row, conflicts: labels } : row;
  });
  // buildKeybindingRows: alphabetical by command id, then by key.
  return withConflicts.sort((left, right) => left.command.localeCompare(right.command) || left.key.localeCompare(right.key));
}

export function conflictLabels(rows: KeybindingRow[], id: string, key: string, when: string): string[] {
  if (key.trim().length === 0) return [];
  const labels = rows.filter((r) => r.id !== id && r.key === key && whenConflicts(r.when, when)).map((r) => commandLabel(r.command));
  return [...new Set(labels)].sort();
}

export function filterRows(rows: KeybindingRow[], query: string): KeybindingRow[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return rows;
  return rows.filter((row) =>
    row.command.toLowerCase().includes(q) ||
    commandLabel(row.command).toLowerCase().includes(q) ||
    row.key.toLowerCase().includes(q) ||
    row.when.toLowerCase().includes(q) ||
    row.source.toLowerCase().includes(q));
}

/** The server.removeKeybinding / replace target for a row. */
export function rowTarget(row: KeybindingRow): { command: string; key: string; when?: string } {
  return { command: row.command, key: row.key, ...(row.when.trim().length > 0 ? { when: row.when } : {}) };
}

/** The payload that rebinds a row to `key` (and `when`, when the clause was edited) (server.upsertKeybinding). */
export function upsertPayload(row: KeybindingRow, key: string, when: string = row.when) {
  return {
    command: row.command,
    key: key.trim(),
    ...(when.trim().length > 0 ? { when: when.trim() } : {}),
    replace: rowTarget(row),
  };
}

/** The payload that adds a binding with no row to replace. */
export function newBindingPayload(command: string, key: string, when: string) {
  return { command, key: key.trim(), ...(when.trim().length > 0 ? { when: when.trim() } : {}) };
}

// --- when clauses --------------------------------------------------------------

export const CORE_WHEN_VARIABLES = ["terminalFocus", "terminalOpen", "previewOpen", "isWeb", "isDesktop", "true", "false"];

/** The identifiers a when clause may use without a warning: the core ones and those the defaults use. */
// Every row's when control asks for these at mount: scanning the whole catalog once per row made the first render of the
// list one JS call long enough to trip the runtime's 2 s budget on a loaded machine, so the scan is kept per catalog.
const knownByDefaults = new WeakMap<DefaultRule[], readonly string[]>();
export function knownWhenVariables(defaults: DefaultRule[]): string[] {
  const cached = knownByDefaults.get(defaults);
  if (cached) return [...cached];
  const known = new Set(CORE_WHEN_VARIABLES);
  for (const rule of defaults) for (const name of rule.when.match(/[A-Za-z_][A-Za-z0-9_.-]*/g) ?? []) known.add(name);
  const list = [...known];
  knownByDefaults.set(defaults, list);
  return [...list];
}

/** Identifiers in `expression` that no default rule uses (the web saves them with a warning). */
export function unknownWhenIdentifiers(expression: string, known: string[]): string[] {
  const names = new Set(expression.match(/[A-Za-z_][A-Za-z0-9_.-]*/g) ?? []);
  return [...names].filter((name) => !known.includes(name)).sort();
}

export const WHEN_PARSE_MESSAGE = "Use variables with !, &&, ||, and parentheses.";

/** The command ids a new binding can target: the defaults' and the server's, sorted. */
export function commandOptions(defaults: DefaultRule[], current: DefaultRule[]): string[] {
  return [...new Set([...defaults, ...current].map((rule) => rule.command))].sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
}

/** The payload that puts a row back on its default binding. */
export function resetPayload(row: KeybindingRow) {
  return {
    command: row.command,
    key: row.defaultKey ?? "",
    ...(row.defaultWhen.trim().length > 0 ? { when: row.defaultWhen } : {}),
    replace: rowTarget(row),
  };
}

// --- recording ----------------------------------------------------------------

/** NSH key names to the names keybindings.json uses. */
const NSH_TO_CONTRACT: Record<string, string> = { up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", plus: "=", minus: "-", escape: "esc" };

/** `ctrl+shift+up` as NSH writes it to `ctrl+shift+arrowup` as keybindings.json does. */
export function contractKeyFromNsh(keystroke: string): string {
  const parts = keystroke.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mods = parts.filter((p) => p !== "cmd").map((p) => p);
  return [...mods, NSH_TO_CONTRACT[key] ?? key].join("+");
}

const REC_KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789", "/", ".", ",", ";", "'", "[", "]", "\\", "plus", "minus", "`", "space", "enter", "tab", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)];
const MODS = ["mod", "ctrl", "alt", "shift"];

/** Every chord worth recording: a modifier plus any key, or a function key alone. */
export function recordableKeystrokes(): string[] {
  const out: string[] = [];
  for (let mask = 1; mask < 16; mask++) {
    const mods = MODS.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const key of REC_KEYS) out.push([...mods, key].join("+"));
  }
  for (let i = 1; i <= 12; i++) out.push(`f${i}`);
  return out;
}
