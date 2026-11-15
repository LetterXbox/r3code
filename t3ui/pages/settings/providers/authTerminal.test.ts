import { expect, test } from "nsh/test";
import { terminalResponseFor, terminalWrite } from "./authTerminal";

test("terminalWrite appends the new tail, replays on a jump and ignores an unchanged offset", () => {
  expect(terminalWrite("abcdef", 6, 3)).toEqual({ write: { kind: "append", data: "def" }, offset: 6 });
  expect(terminalWrite("abcdef", undefined, 0)).toEqual({ write: { kind: "append", data: "abcdef" }, offset: 6 });
  expect(terminalWrite("abcdef", 6, 6)).toEqual({ write: { kind: "none" }, offset: 6 });
  expect(terminalWrite("xyz", 2, 9)).toEqual({ write: { kind: "reset", data: "xyz" }, offset: 2 });
  expect(terminalWrite("xyz", 90, 5)).toEqual({ write: { kind: "reset", data: "xyz" }, offset: 90 });
});

test("terminalResponseFor forwards raw input and clamped resizes", () => {
  expect(terminalResponseFor({ type: "input", data: "\u001b[A" })).toEqual({ type: "terminal", data: "\u001b[A" });
  expect(terminalResponseFor({ type: "resize", cols: 900.7, rows: 0 })).toEqual({ type: "terminal", data: "", size: { cols: 500, rows: 1 } });
  expect(terminalResponseFor({ type: "ready", cols: 80, rows: 24 })).toEqual({ type: "terminal", data: "", size: { cols: 80, rows: 24 } });
  expect(terminalResponseFor({ type: "input", data: "" })).toBeNull();
  expect(terminalResponseFor({ type: "resize", cols: "x", rows: 2 })).toBeNull();
});
