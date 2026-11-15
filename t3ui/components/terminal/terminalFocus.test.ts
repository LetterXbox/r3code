import { expect, test } from "nsh/test";
import { reportTerminalFocus, terminalFocused, terminalFocusTarget } from "./terminalCommands";

test("terminalFocus follows the focus the terminal page reports, and a blur only clears its own focus", () => {
  expect(terminalFocused()).toBe(false);
  reportTerminalFocus({ kind: "drawer" }, true);
  expect(terminalFocused()).toBe(true);
  reportTerminalFocus({ kind: "panel", surfaceId: "terminal:term-2", terminalId: "term-2" }, true);
  expect(terminalFocusTarget()).toEqual({ kind: "panel", surfaceId: "terminal:term-2", terminalId: "term-2" });
  // The drawer's terminal blurs after the panel's took the focus: the panel keeps it.
  reportTerminalFocus({ kind: "drawer" }, false);
  expect(terminalFocused()).toBe(true);
  reportTerminalFocus({ kind: "panel", surfaceId: "terminal:term-2", terminalId: "term-2" }, false);
  expect(terminalFocused()).toBe(false);
});
