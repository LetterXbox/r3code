import { expect, test } from "nsh/test";
import { initialDrawerState, reconcileDrawerTerminals } from "./terminalLogic";

test("fm13: the drawer follows the server's terminals; a strict subset and closed ids change nothing", () => {
  const start = initialDrawerState();
  expect(reconcileDrawerTerminals(start, [])).toBe(start);
  expect(reconcileDrawerTerminals(start, ["term-1"])).toBe(start);
  const grown = reconcileDrawerTerminals(start, ["term-1", "term-5"]);
  expect(grown.groups.map((g) => g.terminalIds)).toEqual([["term-1"], ["term-5"]]);
  expect(grown.activeTerminalId).toBe("term-1");
  const moved = reconcileDrawerTerminals(grown, ["term-5", "term-9"]);
  expect(moved.groups.map((g) => g.terminalIds)).toEqual([["term-5"], ["term-9"]]);
  expect(moved.activeTerminalId).toBe("term-5");
  expect(reconcileDrawerTerminals(start, ["term-1", "term-7"], new Set(["term-7"]))).toBe(start);
});
