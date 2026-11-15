import { expect, test } from "nsh/test";
import { nshKeystroke } from "./keystroke";
import { resolveCommand, type ActiveRule } from "./registry";
import { parseWhen, whenHolds } from "./whenClause";

test("when-clauses evaluate identifiers, negation, and, or and parentheses", () => {
  expect(whenHolds("", {})).toBe(true);
  expect(whenHolds("terminalFocus", { terminalFocus: true })).toBe(true);
  expect(whenHolds("!terminalFocus && !previewFocus", { previewFocus: true })).toBe(false);
  expect(whenHolds("a || (b && !c)", { b: true })).toBe(true);
  expect(whenHolds("composerFocus && turnRunning", { composerFocus: true })).toBe(false);
  expect(whenHolds("true && !false", {})).toBe(true);
  expect(parseWhen("a &&")).toBeNull();
  expect(whenHolds("a &&", { a: true })).toBe(false);
});

test("rule keys become keymap keystrokes", () => {
  expect(nshKeystroke("mod+shift+[")).toBe("mod+shift+[");
  expect(nshKeystroke("mod+=")).toBe("mod+plus");
  expect(nshKeystroke("mod++")).toBe("mod+plus");
  expect(nshKeystroke("mod+-")).toBe("mod+minus");
  expect(nshKeystroke("alt+arrowup")).toBe("alt+up");
  expect(nshKeystroke("shift+mod+K")).toBe("mod+shift+k");
  expect(nshKeystroke("meta+esc")).toBe("cmd+escape");
  expect(nshKeystroke("mod+nope+k")).toBeNull();
  expect(nshKeystroke("mod")).toBeNull();
});

const rule = (command: string, key: string, when = ""): ActiveRule => ({ command, key, when, keystroke: nshKeystroke(key) });

test("the newest rule whose when-clause holds wins", () => {
  const rules = [rule("terminal.new", "mod+n", "terminalFocus"), rule("chat.new", "mod+n", "!terminalFocus"), rule("sidebar.toggle", "mod+b")];
  expect(resolveCommand(rules, "mod+n", {})).toBe("chat.new");
  expect(resolveCommand(rules, "mod+n", { terminalFocus: true })).toBe("terminal.new");
  expect(resolveCommand(rules, "mod+b", {})).toBe("sidebar.toggle");
  expect(resolveCommand(rules, "mod+x", {})).toBeNull();
  const overridden = [...rules, rule("thread.next", "mod+n")];
  expect(resolveCommand(overridden, "mod+n", {})).toBe("thread.next");
});

import { DEFAULT_KEYBINDING_RULES } from "./defaultKeybindings";
import { formatShortcutLabel, shortcutLabelFor } from "./shortcutLabel";

test("shortcut labels follow the web's mac format and the newest rule", () => {
  expect(formatShortcutLabel("mod+shift+n")).toBe("⇧⌘N");
  expect(formatShortcutLabel("mod+alt+arrowup")).toBe("⌥⌘Up");
  expect(formatShortcutLabel("f6")).toBe("F6");
  expect(shortcutLabelFor(DEFAULT_KEYBINDING_RULES, "chat.newLocal")).toBe("⇧⌘N");
  expect(shortcutLabelFor(DEFAULT_KEYBINDING_RULES, "chat.new")).toBe("⇧⌘O");
  expect(shortcutLabelFor(DEFAULT_KEYBINDING_RULES, "terminal.new")).toBeNull();
  expect(shortcutLabelFor(DEFAULT_KEYBINDING_RULES, "terminal.new", { terminalFocus: true })).toBe("⌘N");
  expect(shortcutLabelFor(DEFAULT_KEYBINDING_RULES, "nope")).toBeNull();
  // A user override replaces the default; the shadowed default shows nothing.
  const overridden = [...DEFAULT_KEYBINDING_RULES, { command: "sidebar.toggle", key: "mod+shift+e", when: "" }, { command: "thread.next", key: "mod+n", when: "" }];
  expect(shortcutLabelFor(overridden, "sidebar.toggle")).toBe("⇧⌘E");
  expect(shortcutLabelFor(overridden, "chat.new")).toBe("⇧⌘O");
});

test("the default rules carry the commands the app registers", () => {
  const commands = new Set(DEFAULT_KEYBINDING_RULES.map((rule) => rule.command));
  for (const command of ["navigation.back", "navigation.forward", "chat.newWithoutProject", "theme.select", "workspace.focusNext", "workspace.focusPrevious"]) expect(commands.has(command)).toBe(true);
  expect(shortcutLabelFor(DEFAULT_KEYBINDING_RULES, "navigation.back")).toBe("⌘[");
});
