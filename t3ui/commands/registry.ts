// The shared command dispatcher: the app's named commands (the ids of
// packages/shared/src/keybindings.ts DEFAULT_KEYBINDINGS), bound from the RESOLVED
// keybindings (the server's defaults plus the user's overrides, or the web's
// defaults while no server has answered), re-bound live when they change.
//
// Modules register what a command does (`registerCommand`) and report what is
// true right now for when-clauses (`defineContext`: terminalFocus, composerFocus,
// usagePageOpen ...). `keymap` has one slot per keystroke, so this module owns one
// binding per keystroke and picks the command per press, as the web's
// dispatcher does: the newest matching rule wins, its when-clause must hold, and the
// newest handler for that command that does not return `false` runs.
import { noteUserInput } from "../components/userActivity";
import { cleanup, effect, keymap, signal } from "nsh";
import { rulesFromResolved, type DefaultRule } from "../pages/settings/keybindingsLogic";
import { serverKeybindings } from "../pages/settings/settingsState";
import { DEFAULT_KEYBINDING_RULES } from "./defaultKeybindings";
import { nshKeystroke } from "./keystroke";
import { shortcutLabelFor } from "./shortcutLabel";
import { whenHolds } from "./whenClause";
import { settingValue } from "../store";

/** Return `false` to let the next older handler of the same command try. */
export type CommandHandler = () => boolean | void;

export interface ActiveRule { command: string; key: string; when: string; keystroke: string | null }

const stacks = new Map<string, CommandHandler[]>();
const registrations = signal(0);

function addTo<T>(list: T[], item: T, onChange: () => void): () => void {
  list.push(item);
  onChange();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = list.lastIndexOf(item);
    if (index !== -1) list.splice(index, 1);
    onChange();
  };
}

function ownedByRender(remove: () => void) {
  // Inside a component or effect the registration goes with it; outside one it stays.
  try { cleanup(remove); } catch { /* module scope */ }
}

/** Registers what `command` does. Returns the unregister function (also run when the calling component goes away). */
export function registerCommand(command: string, handler: CommandHandler): () => void {
  let stack = stacks.get(command);
  if (!stack) { stack = []; stacks.set(command, stack); }
  const remove = addTo(stack, handler, () => registrations.update((n) => n + 1));
  ownedByRender(remove);
  return remove;
}

export function registerCommands(handlers: Record<string, CommandHandler>): () => void {
  const removers = Object.entries(handlers).map(([command, handler]) => registerCommand(command, handler));
  return () => removers.forEach((remove) => remove());
}

/** useKeybindingCommands' `fallback`: a handler for a command no one registered by name (ChatView: `script.<id>.run`). */
export type CommandFallback = (command: string) => CommandHandler | undefined;
const fallbacks: CommandFallback[] = [];
export function registerCommandFallback(fallback: CommandFallback): () => void {
  const remove = addTo(fallbacks, fallback, () => registrations.update((n) => n + 1));
  ownedByRender(remove);
  return remove;
}
function fallbackFor(command: string): CommandHandler | undefined {
  for (let index = fallbacks.length - 1; index >= 0; index -= 1) {
    const handler = fallbacks[index]!(command);
    if (handler) return handler;
  }
  return undefined;
}

export function hasCommandHandler(command: string): boolean {
  return (stacks.get(command)?.length ?? 0) > 0 || fallbackFor(command) !== undefined;
}

// --- when-clause context ------------------------------------------------------

// This is the desktop app: the web's `isDesktop` holds and `isWeb` does not.
const getters = new Map<string, () => boolean>([["isDesktop", () => true], ["isWeb", () => false]]);

/** Reports a when-clause identifier. The newest definition of a name wins. */
export function defineContext(name: string, read: () => boolean): () => void {
  const entry = () => read();
  getters.set(name, entry);
  const remove = () => { if (getters.get(name) === entry) getters.delete(name); };
  ownedByRender(remove);
  return remove;
}

/** True when something already reports `name` (the focus defaults leave such a name alone). */
export function hasContext(name: string): boolean {
  return getters.has(name);
}

/** Every context value as of now (read at key time, never tracked). */
export function readContext(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, read] of getters) {
    try { out[name] = Boolean(read()); } catch { out[name] = false; }
  }
  return out;
}

// --- rules --------------------------------------------------------------------

/** composerRequiresModifier (keybindings.ts:113): with Mod+Enter sending, a saved plain mod+enter composer.sendAlternate resolves to mod+shift+enter. */
export function shortcutForContext(rule: DefaultRule, composerRequiresModifier: boolean): DefaultRule {
  if (composerRequiresModifier && rule.command === "composer.sendAlternate" && rule.key.trim().toLowerCase() === "mod+enter") return { ...rule, key: "mod+shift+enter" };
  return rule;
}

function activate(rules: DefaultRule[]): ActiveRule[] {
  const shortcut = settingValue("sendShortcut");
  const requiresModifier = shortcut === "mod-enter" || shortcut === "mod-enter-multiline";
  return rules.map((rule) => shortcutForContext(rule, requiresModifier)).map((rule) => ({ ...rule, keystroke: nshKeystroke(rule.key) }));
}

/** The resolved bindings: the server's (defaults merged with the user's), else the web's defaults. */
export function activeRules(): ActiveRule[] {
  const resolved = serverKeybindings();
  return activate(resolved.length > 0 ? rulesFromResolved(resolved) : DEFAULT_KEYBINDING_RULES);
}

/** The command a press resolves to: the newest rule on the keystroke whose when-clause holds. */
export function resolveCommand(rules: readonly ActiveRule[], keystroke: string, context: Readonly<Record<string, boolean>>): string | null {
  const pressed = keystroke.toLowerCase();
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (rule.keystroke !== pressed) continue;
    if (!whenHolds(rule.when, context)) continue;
    return rule.command;
  }
  return null;
}

/** Runs the newest handler of `command` that accepts it. True when one did. */
export function runCommand(command: string): boolean {
  const stack = stacks.get(command) ?? [];
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!() !== false) return true;
  }
  const fallback = fallbackFor(command);
  return fallback ? fallback() !== false : false;
}

export function dispatchKeystroke(keystroke: string): boolean {
  const command = resolveCommand(activeRules(), keystroke, readContext());
  return command === null ? false : runCommand(command);
}

// --- binding ------------------------------------------------------------------

const bound = new Map<string, () => void>();

const keystrokeFallbacks = new Map<string, () => void>();
/**
 * What a chord does when no command takes it: Cmd+0 / Cmd+= / Cmd+- belong to the preview's zoom only while a preview has the focus
 * (their when-clause), and are the app zoom's otherwise (the desktop menu's View items).
 */
export function registerKeystrokeFallback(keystroke: string, run: () => void): () => void {
  keystrokeFallbacks.set(keystroke, run);
  return () => { if (keystrokeFallbacks.get(keystroke) === run) keystrokeFallbacks.delete(keystroke); };
}

/** The keystrokes this module holds a binding for (for tests and diagnostics). */
export function boundKeystrokes(): string[] {
  return [...bound.keys()].sort();
}

/**
 * Keeps one `keymap` binding per keystroke that some rule gives a command that has a
 * handler. Re-runs when the keybindings or the registered commands change, and only
 * adds or removes the keystrokes that changed so a binding a modal dialog made
 * after ours keeps winning over it.
 */
export function installKeybindings() {
  effect(() => {
    const rules = activeRules();
    registrations();
    const wanted = new Set<string>();
    for (const rule of rules) if (rule.keystroke && hasCommandHandler(rule.command)) wanted.add(rule.keystroke);
    // Applied outside the effect so the bindings belong to no owner that re-runs.
    queueMicrotask(() => apply(wanted));
  });
}

function apply(wanted: Set<string>) {
  for (const [keystroke, unbind] of bound) {
    if (wanted.has(keystroke)) continue;
    unbind();
    bound.delete(keystroke);
  }
  for (const keystroke of wanted) {
    if (bound.has(keystroke)) continue;
    try { bound.set(keystroke, keymap.bind(keystroke, () => { noteUserInput(); if (!dispatchKeystroke(keystroke)) keystrokeFallbacks.get(keystroke)?.(); })); } catch { /* a keystroke the platform keeps */ }
  }
}

// --- shortcut labels ------------------------------------------------------------

/**
 * The shortcut of `command` as the palette and tooltips show it ("⇧⌘N"), from the RESOLVED
 * bindings (the user's overrides included); null when it has none. Read inside a component
 * or an effect it follows a re-bind. `context` adds when-clause values (default: none hold).
 */
export function shortcutLabel(command: string, context?: Readonly<Record<string, boolean>>): string | null {
  return shortcutLabelFor(activeRules(), command, context);
}
