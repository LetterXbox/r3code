import { expect, test } from "nsh/test";
import { keybindingCalls, keybindingValueForCommand } from "./scriptKeybindings";

const rule = (command: string, key: string, mods: object = {}) => ({ command, shortcut: { key, modKey: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods } });
const resolved = [rule("script.dev.run", "k", { modKey: true, shiftKey: true }), rule("chat.new", "n", { modKey: true })];

test("a script's shortcut is read back as it is typed", () => {
  expect(keybindingValueForCommand(resolved, "script.dev.run")).toBe("mod+shift+k");
  expect(keybindingValueForCommand(resolved, "script.other.run")).toBeNull();
  expect(keybindingValueForCommand(resolved, null)).toBeNull();
});

test("changing a shortcut replaces the old rule, clearing removes it, a new one upserts", () => {
  expect(keybindingCalls([], "script.dev.run", "mod+j")).toEqual([{ method: "server.upsertKeybinding", payload: { command: "script.dev.run", key: "mod+j" } }]);
  expect(keybindingCalls(resolved, "script.dev.run", "mod+j")).toEqual([
    { method: "server.upsertKeybinding", payload: { command: "script.dev.run", key: "mod+j", replace: { command: "script.dev.run", key: "mod+shift+k" } } },
  ]);
  expect(keybindingCalls(resolved, "script.dev.run", "")).toEqual([{ method: "server.removeKeybinding", payload: { command: "script.dev.run", key: "mod+shift+k" } }]);
  expect(keybindingCalls(resolved, "script.dev.run", "mod+shift+k")).toEqual([]);
});
