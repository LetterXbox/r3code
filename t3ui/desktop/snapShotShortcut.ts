// lib/snapShotShortcut.ts: labels, equality and keybinding conflicts of a SnapShot shortcut, plus the conversion to and
// from the keystrokes `nsh/keymap` binds (the port's in-app capture shortcut and its recorder).
import {
  isModifierPairShortcut,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
  type SnapShotKeyChord,
  type SnapShotModifier,
  type SnapShotShortcut,
} from "./snapShotTypes";

const NSH_KEY: Record<string, string> = {
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", " ": "space", "+": "plus", "=": "plus", "-": "minus", esc: "escape",
};
const CHORD_KEY: Record<string, string> = { up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", space: " ", plus: "+", minus: "-" };

/** The `nsh/keymap` keystroke of a chord ("mod+shift+2"), null for a modifier pair (keymap cannot bind modifiers alone). */
export function snapShotKeystroke(shortcut: SnapShotShortcut, mac = true): string | null {
  if (isModifierPairShortcut(shortcut)) return null;
  const mods: string[] = [];
  const command = shortcut.modKey || (mac && shortcut.metaKey);
  const control = shortcut.ctrlKey || (!mac && shortcut.modKey);
  if (command) mods.push("mod");
  else if (shortcut.metaKey) mods.push("cmd");
  if (control && !(command && !mac)) mods.push("ctrl");
  if (shortcut.altKey) mods.push("alt");
  if (shortcut.shiftKey) mods.push("shift");
  const key = shortcut.key.toLowerCase();
  return [...mods, NSH_KEY[key] ?? key].join("+");
}

/** The chord a recorded keystroke names ("mod+shift+2" -> modKey + shiftKey + "2"). */
export function chordFromKeystroke(keystroke: string): SnapShotKeyChord | null {
  const parts = keystroke.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  if (!key) return null;
  const chord: SnapShotKeyChord = { key: CHORD_KEY[key] ?? key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false };
  for (const part of parts) {
    if (part === "mod") chord.modKey = true;
    else if (part === "cmd") chord.metaKey = true;
    else if (part === "ctrl") chord.ctrlKey = true;
    else if (part === "alt") chord.altKey = true;
    else if (part === "shift") chord.shiftKey = true;
    else return null;
  }
  // A global shortcut without a modifier would take that key from every app.
  if (!chord.modKey && !chord.metaKey && !chord.ctrlKey && !chord.altKey && !chord.shiftKey) return null;
  return chord;
}

function modifierKeyLabel(modifier: SnapShotModifier, mac: boolean): string {
  if (modifier === "shift") return "⇧";
  if (mac) return modifier === "meta" ? "⌘" : modifier === "control" ? "⌃" : "⌥";
  if (modifier === "meta") return "Super";
  return modifier === "control" ? "Ctrl" : "Alt";
}

const KEY_LABELS: Record<string, string> = {
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", enter: "↵", escape: "Esc", tab: "Tab", backspace: "⌫", delete: "⌦", " ": "Space",
  pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End",
};

function keyLabel(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_LABELS[lower]) return KEY_LABELS[lower];
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** snapShotShortcutKeyLabels: one label per key, in the reference's order (control, alt, shift, meta, key). */
export function snapShotShortcutKeyLabels(shortcut: SnapShotShortcut, mac = true): readonly string[] {
  if (isModifierPairShortcut(shortcut)) {
    const label = modifierKeyLabel(snapShotShortcutModifierPair(shortcut), mac);
    return [label, label];
  }
  const modifiers: readonly [boolean, SnapShotModifier][] = [
    [shortcut.ctrlKey || (shortcut.modKey && !mac), "control"],
    [shortcut.altKey, "alt"],
    [shortcut.shiftKey, "shift"],
    [shortcut.metaKey || (shortcut.modKey && mac), "meta"],
  ];
  return [...modifiers.filter(([on]) => on).map(([, modifier]) => modifierKeyLabel(modifier, mac)), keyLabel(shortcut.key)];
}

/** formatSnapShotShortcutLabel. */
export function formatSnapShotShortcutLabel(shortcut: SnapShotShortcut, mac = true): string {
  return isModifierPairShortcut(shortcut)
    ? snapShotModifierPairLabel(snapShotShortcutModifierPair(shortcut), mac)
    : snapShotShortcutKeyLabels(shortcut, mac).join(mac ? "" : "+");
}

export function sameSnapShotShortcut(left: SnapShotShortcut, right: SnapShotShortcut, mac = true): boolean {
  if (isModifierPairShortcut(left) || isModifierPairShortcut(right)) {
    return isModifierPairShortcut(left) && isModifierPairShortcut(right) && snapShotShortcutModifierPair(left) === snapShotShortcutModifierPair(right);
  }
  return snapShotKeystroke(left, mac) === snapShotKeystroke(right, mac);
}

/** snapShotKeybindingConflict: the app command already on this chord, from the resolved keybindings. */
export function snapShotKeybindingConflict(
  shortcut: SnapShotShortcut,
  rules: ReadonlyArray<{ readonly command: string; readonly keystroke: string | null }>,
  mac = true,
): string | null {
  const keystroke = snapShotKeystroke(shortcut, mac);
  if (keystroke === null) return null;
  return rules.find((rule) => rule.keystroke === keystroke)?.command ?? null;
}

/** DesktopSnapShot.ts snapShotShortcutRegistrationFailureMessage for a modifier pair. */
export function modifierPairUnavailableMessage(shortcut: SnapShotShortcut, mac = true): string | null {
  return isModifierPairShortcut(shortcut) ? `${snapShotModifierPairLabel(snapShotShortcutModifierPair(shortcut), mac)} is not available on this system.` : null;
}
