import { expect, test } from "nsh/test";
import { forwardedShortcuts, handleForwardedShortcutMessage, pageKeystroke } from "./previewForwardedShortcuts";

const rules = [
  { command: "sidebar.toggle", key: "mod+b", when: "", keystroke: "mod+b" },
  { command: "preview.focusUrl", key: "mod+l", when: "previewFocus", keystroke: "mod+l" },
  { command: "terminal.toggle", key: "mod+j", when: "", keystroke: "mod+j" },
  { command: "rightPanel.toggle", key: "mod+alt+b", when: "terminalFocus", keystroke: "mod+alt+b" },
  { command: "workspace.focusNext", key: "f6", when: "", keystroke: "f6" },
];

test("only the reference's commands are forwarded, with the preview-focus context", () => {
  const list = forwardedShortcuts(rules, {}, false);
  expect(list).toEqual([{ command: "workspace.focusNext", keystroke: "f6" }, { command: "sidebar.toggle", keystroke: "mod+b" }, { command: "preview.focusUrl", keystroke: "mod+l" }]);
  // A later rule on the same chord for another command shadows it.
  expect(forwardedShortcuts([...rules, { command: "chat.new", key: "mod+b", when: "", keystroke: "mod+b" }], {}, false).some((s) => s.command === "sidebar.toggle")).toBe(false);
});

test("the page's keydown keystroke matches the registry's form", () => {
  expect(pageKeystroke({ key: "B", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, true)).toBe("mod+shift+b");
  expect(pageKeystroke({ key: "ArrowUp", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }, true)).toBe("alt+up");
  expect(pageKeystroke({ key: "Meta", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe(null);
});

test("a forwarded message runs its command; an unknown one is swallowed", () => {
  const ran: string[] = [];
  const allowed = [{ command: "sidebar.toggle", keystroke: "mod+b" }];
  expect(handleForwardedShortcutMessage(JSON.stringify({ t3: "shortcut", command: "sidebar.toggle" }), allowed, (c) => { ran.push(c); return true; })).toBe(true);
  expect(handleForwardedShortcutMessage(JSON.stringify({ t3: "shortcut", command: "app.quit" }), allowed, (c) => { ran.push(c); return true; })).toBe(true);
  expect(handleForwardedShortcutMessage(JSON.stringify({ t3: "open" }), allowed)).toBe(false);
  expect(ran).toEqual(["sidebar.toggle"]);
});
