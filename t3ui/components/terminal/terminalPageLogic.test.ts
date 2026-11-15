import { expect, test } from "nsh/test";
import { isTerminalClearShortcut, pageSelection, selectionActionPosition, terminalDeleteShortcutData, terminalNavigationShortcutData, terminalSelectionLineRange, terminalShellKey } from "./terminalPageLogic";

const key = (name: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ type: "keydown", key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("Option+Arrow moves by word, and on the Mac Cmd+Arrow moves to the line's ends", () => {
  expect(terminalNavigationShortcutData(key("ArrowLeft", { altKey: true }), true)).toBe("\u001bb");
  expect(terminalNavigationShortcutData(key("ArrowRight", { altKey: true }), true)).toBe("\u001bf");
  expect(terminalNavigationShortcutData(key("ArrowLeft", { metaKey: true }), true)).toBe("\u0001");
  expect(terminalNavigationShortcutData(key("ArrowRight", { metaKey: true }), true)).toBe("\u0005");
  // Off the Mac only Alt moves, and Ctrl/Meta stay the shell's or the app's.
  expect(terminalNavigationShortcutData(key("ArrowLeft", { altKey: true }), false)).toBe("\u001bb");
  expect(terminalNavigationShortcutData(key("ArrowLeft", { metaKey: true }), false)).toBeNull();
  // Shift, a second modifier, other arrows and key-ups are not these mappings.
  expect(terminalNavigationShortcutData(key("ArrowLeft", { altKey: true, shiftKey: true }), true)).toBeNull();
  expect(terminalNavigationShortcutData(key("ArrowLeft", { altKey: true, metaKey: true }), true)).toBeNull();
  expect(terminalNavigationShortcutData(key("ArrowUp", { altKey: true }), true)).toBeNull();
  expect(terminalNavigationShortcutData({ ...key("ArrowLeft", { altKey: true }), type: "keyup" }, true)).toBeNull();
});

test("Cmd+Backspace deletes to the line start on the Mac only", () => {
  expect(terminalDeleteShortcutData(key("Backspace", { metaKey: true }), true)).toBe("\u0015");
  expect(terminalDeleteShortcutData(key("Backspace", { metaKey: true }), false)).toBeNull();
  expect(terminalDeleteShortcutData(key("Backspace", { metaKey: true, shiftKey: true }), true)).toBeNull();
  expect(terminalDeleteShortcutData(key("Backspace"), true)).toBeNull();
});

test("Ctrl+L clears everywhere and Cmd+K clears on the Mac", () => {
  expect(isTerminalClearShortcut(key("l", { ctrlKey: true }), false)).toBe(true);
  expect(isTerminalClearShortcut(key("L", { ctrlKey: true }), true)).toBe(true);
  expect(isTerminalClearShortcut(key("k", { metaKey: true }), true)).toBe(true);
  expect(isTerminalClearShortcut(key("k", { metaKey: true }), false)).toBe(false);
  expect(isTerminalClearShortcut(key("k", { metaKey: true, shiftKey: true }), true)).toBe(false);
});

test("a mapped key is typed into the shell with the web's failure copy; any other key is not mapped", () => {
  expect(terminalShellKey(key("ArrowLeft", { altKey: true }), true)).toEqual({ data: "\u001bb", failure: "Failed to move cursor" });
  expect(terminalShellKey(key("Backspace", { metaKey: true }), true)).toEqual({ data: "\u0015", failure: "Failed to delete terminal input" });
  expect(terminalShellKey(key("k", { metaKey: true }), true)).toEqual({ data: "\u000c", failure: "Failed to clear terminal" });
  expect(terminalShellKey(key("l", { ctrlKey: true }), false)).toEqual({ data: "\u000c", failure: "Failed to clear terminal" });
  expect(terminalShellKey(key("a"), true)).toBeNull();
  expect(terminalShellKey(key("d", { metaKey: true }), true)).toBeNull();
});

test("a selection reports 1-based rows and normalized text, and a blank one reports nothing", () => {
  expect(terminalSelectionLineRange({ start: { y: 2 }, end: { y: 4 } })).toEqual({ lineStart: 3, lineEnd: 5 });
  expect(terminalSelectionLineRange({ start: { y: 2 }, end: { y: 0 } })).toEqual({ lineStart: 3, lineEnd: 3 });
  expect(pageSelection("\r\nerror: boom\r\nat main\r\n", { start: { y: 2 }, end: { y: 3 } })).toEqual({ clipboardText: "\r\nerror: boom\r\nat main\r\n", text: "error: boom\nat main", lineStart: 3, lineEnd: 4 });
  expect(pageSelection("\n\n", { start: { y: 0 }, end: { y: 1 } })).toBeNull();
  expect(pageSelection("x", null)).toBeNull();
});

test("the selection menu opens at the pointer, kept inside the terminal and 8 px inside the window", () => {
  const bounds = { left: 0, top: 100, width: 400, height: 200 };
  const viewport = { width: 500, height: 600 };
  expect(selectionActionPosition({ bounds, pointer: { x: 120, y: 150 }, selectionEnd: null, viewport })).toEqual({ x: 120, y: 150 });
  expect(selectionActionPosition({ bounds, pointer: { x: 999, y: 999 }, selectionEnd: null, viewport })).toEqual({ x: 400, y: 300 });
  expect(selectionActionPosition({ bounds, pointer: { x: -5, y: 0 }, selectionEnd: null, viewport })).toEqual({ x: 8, y: 100 });
  expect(selectionActionPosition({ bounds, pointer: null, selectionEnd: { right: 50, bottom: 140 }, viewport })).toEqual({ x: 50, y: 144 });
  expect(selectionActionPosition({ bounds, pointer: null, selectionEnd: null, viewport })).toEqual({ x: 260, y: 112 });
});
