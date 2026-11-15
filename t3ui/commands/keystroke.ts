// keybindings.json keys ("mod+shift+[", "mod++", "alt+arrowup") to the keystrokes
// `keymap.bind` takes ("mod+shift+[", "mod+plus", "alt+up"), and back for comparison.
import { splitKey } from "../pages/settings/keybindingsLogic";

const KEY_TO_NSH: Record<string, string> = {
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
  esc: "escape", "=": "plus", "+": "plus", "-": "minus", " ": "space",
};
const MODIFIERS: Record<string, string> = { mod: "mod", cmd: "cmd", meta: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };
const ORDER = ["mod", "cmd", "ctrl", "alt", "shift"];

/**
 * The canonical keystroke for a rule key, or null when `keymap` cannot express it
 * (a key that needs Shift to type, like `?`, is written `shift+/` there).
 */
export function nshKeystroke(ruleKey: string): string | null {
  const parts = splitKey(ruleKey.trim().toLowerCase());
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1]!;
  if (MODIFIERS[key] !== undefined && parts.length === 1) return null;
  const mods = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIERS[part];
    if (mod === undefined) return null;
    mods.add(mod);
  }
  const name = KEY_TO_NSH[key] ?? key;
  return [...ORDER.filter((mod) => mods.has(mod)), name].join("+");
}
