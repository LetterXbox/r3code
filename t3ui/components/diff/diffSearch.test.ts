import { expect, test } from "nsh/test";
import { countInLine, countInPatch, locateMatch, searchResultLabel, stepMatch } from "./diffSearch";

const p = (text: string, extra: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }> = {}) => ({ text, caseSensitive: false, wholeWord: false, regex: false, ...extra });
const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@ foo\n keep foo\n-old foo\n+new Foo\n\\ No newline at end of file\n";

test("a patch's matches are counted as the DiffView shows its lines", () => {
  // Headers and hunk headers are not lines; a context line is on both sides of a split view.
  expect(countInPatch(PATCH, p("foo"), false)).toBe(3);
  expect(countInPatch(PATCH, p("foo"), true)).toBe(4);
  expect(countInPatch(PATCH, p("foo", { caseSensitive: true }), false)).toBe(2);
});

test("whole words follow CodeViewSearch's separators; a bad regexp finds nothing", () => {
  expect(countInLine("foo food foo.bar", p("foo", { wholeWord: true }))).toBe(2);
  expect(countInLine("a1 a22", p("a\\d+", { regex: true }))).toBe(2);
  expect(countInLine("a.b axb", p("a.b"))).toBe(1);
  expect(countInLine("x", p("(", { regex: true }))).toBe(0);
});

test("the result text, wrapping steps and matches across files follow the search panel", () => {
  expect(searchResultLabel(0, null)).toBe("No results");
  expect(searchResultLabel(5, null)).toBe("5 results");
  expect(searchResultLabel(5, 1)).toBe("2 of 5");
  expect(stepMatch(3, null, false)).toBe(0);
  expect(stepMatch(3, 2, false)).toBe(0);
  expect(stepMatch(3, 0, true)).toBe(2);
  expect(locateMatch([2, 0, 3], 3)).toEqual({ file: 2, local: 1 });
  expect(locateMatch([2], 5)).toBe(null);
});
