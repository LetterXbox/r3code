import { expect, test } from "nsh/test";
import { highlightSegments, normalizeMatchRanges, parseMatchRanges, trimmedHighlightSegments } from "./highlightedSearchLine";
import { parseContentHits } from "./paletteSearch";

test("ranges are clamped, sorted and merged", () => {
  expect(normalizeMatchRanges("abcdef", [{ start: 4, end: 9 }, { start: 0, end: 2 }, { start: 1, end: 3 }, { start: 3, end: 3 }])).toEqual([{ start: 0, end: 3 }, { start: 4, end: 6 }]);
});

test("segments split the line at the matches", () => {
  expect(highlightSegments("const foo = foo()", [{ start: 6, end: 9 }, { start: 12, end: 15 }])).toEqual([
    { text: "const ", match: false }, { text: "foo", match: true }, { text: " = ", match: false }, { text: "foo", match: true }, { text: "()", match: false },
  ]);
});

test("trimmed rows shift the ranges; contract payloads keep matchRanges", () => {
  expect(trimmedHighlightSegments("    foo bar", [{ start: 8, end: 11 }])).toEqual([{ text: "foo ", match: false }, { text: "bar", match: true }]);
  expect(trimmedHighlightSegments("foo", [])).toBe(null);
  expect(parseMatchRanges([{ start: 1, end: 2 }, { start: "x" }])).toEqual([{ start: 1, end: 2 }]);
  const parsed = parseContentHits({ matches: [{ path: "a.ts", lineNumber: 3, lineContent: "  hit", matchRanges: [{ start: 2, end: 5 }] }], truncated: false });
  expect(parsed.matches[0].matchRanges).toEqual([{ start: 2, end: 5 }]);
});

import { emptyMessage } from "./paletteLogic";

test("content search waits for and needs file access", () => {
  expect(emptyMessage("content", "x", false, "checking")).toBe("Checking file access…");
  expect(emptyMessage("content", "x", false, "denied")).toBe("This connection cannot search host files.");
  expect(emptyMessage("content", "", false, "granted")).toBe("Type to search across your project.");
});

import { syntaxHighlightSegments } from "./highlightedSearchLine";

test("syntax tokens are split at matches and keep their kind", () => {
  const segments = syntaxHighlightSegments("const foo = 1", [{ start: 6, end: 9 }], "a.ts");
  expect(segments.map((segment) => segment.text).join("")).toBe("const foo = 1");
  expect(segments.find((segment) => segment.match)?.text).toBe("foo");
  expect(segments[0]?.kind).toBe("keyword");
  expect(syntaxHighlightSegments("plain text", [], "notes.unknownext")).toEqual([{ text: "plain text", match: false, kind: "plain" }]);
});
