// A project script's shortcut (lib/projectScriptKeybindings.ts, useProjectScriptEditing.ts): environment-wide
// keybindings.json rules whose command is `script.<id>.run`, written through server.upsertKeybinding and
// server.removeKeybinding after the scripts themselves are saved.
import { shortcutToInput } from "../../pages/settings/keybindingsLogic";

type Dict = Record<string, unknown>;

/** keybindingValueForCommand: the last resolved rule for `command`, spelled as it is typed (`mod+shift+k`), or null. */
export function keybindingValueForCommand(resolved: readonly Dict[], command: string | null): string | null {
  if (command === null) return null;
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    const rule = resolved[index];
    if (!rule || rule.command !== command) continue;
    const shortcut = rule.shortcut;
    return typeof shortcut === "object" && shortcut !== null ? shortcutToInput(shortcut as Dict) : null;
  }
  return null;
}

/** The server calls that make `command`'s shortcut `key` (null removes it): drop the old rules, upsert the new key. */
export function keybindingCalls(resolved: readonly Dict[], command: string, key: string | null): { method: "server.upsertKeybinding" | "server.removeKeybinding"; payload: Dict }[] {
  const wanted = key?.trim() || null;
  const previous = resolved
    .filter((rule) => rule.command === command && rule.whenAst === undefined)
    .flatMap((rule) => (typeof rule.shortcut === "object" && rule.shortcut !== null ? [{ command, key: shortcutToInput(rule.shortcut as Dict) }] : []));
  const last = previous.at(-1);
  const removals = (wanted ? previous.slice(0, -1) : previous).map((rule) => ({ method: "server.removeKeybinding" as const, payload: rule }));
  if (!wanted) return removals;
  if (last?.key === wanted) return removals;
  return [...removals, { method: "server.upsertKeybinding", payload: last ? { command, key: wanted, replace: last } : { command, key: wanted } }];
}
