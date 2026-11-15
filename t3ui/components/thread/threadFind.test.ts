import { expect, test } from "nsh/test";
import { countOccurrences, findStartIndex, findThreadMatches, formatThreadFindCount, markFindMatches, stepThreadFindIndex } from "./threadFind";

test("matches are counted per row, case-insensitively, in order", () => {
  const entries = [{ id: "a", text: "Hello hello" }, { id: "b", text: "none" }, { id: "c", text: "say HELLO" }];
  expect(countOccurrences("aaaa", "aa")).toBe(2);
  expect(findThreadMatches(entries, "hello")).toEqual([
    { entryId: "a", occurrence: 0 }, { entryId: "a", occurrence: 1 }, { entryId: "c", occurrence: 0 },
  ]);
  expect(findThreadMatches(entries, "  ")).toEqual([]);
});

test("next and previous wrap around", () => {
  expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
  expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
  expect(stepThreadFindIndex(0, 0, 1)).toBe(0);
  expect(formatThreadFindCount(1, 3)).toBe("2/3");
  expect(formatThreadFindCount(0, 0)).toBe("0/0");
});

test("markFindMatches marks prose but not code spans, link destinations or urls", () => {
  expect(markFindMatches("a Foo and `foo` and [foo](http://foo.dev/foo) at https://foo.io", "foo"))
    .toBe("a <mark>Foo</mark> and `foo` and [<mark>foo</mark>](http://foo.dev/foo) at https://foo.io");
  expect(markFindMatches("a.b (a.b)", "a.b")).toBe("<mark>a.b</mark> (<mark>a.b</mark>)");
  expect(markFindMatches("text", "")).toBe("text");
});

test("a new query starts at the first match at or below the first row in view", () => {
  const entries = [{ id: "a", text: "x" }, { id: "b", text: "none" }, { id: "c", text: "x x" }, { id: "d", text: "x" }];
  const matches = findThreadMatches(entries, "x");
  expect(findStartIndex(entries, matches, null)).toBe(0);
  expect(findStartIndex(entries, matches, "b")).toBe(1);
  expect(findStartIndex(entries, matches, "d")).toBe(3);
  expect(findStartIndex(entries, matches, "fold-unknown")).toBe(0);
  expect(findStartIndex([...entries, { id: "e", text: "" }], matches, "e")).toBe(0);
});

test("a palette message hit opens find on the query as the snippet writes it, at its message", async () => {
  const { findForMessageMatch } = await import("./threadFindState");
  expect(findForMessageMatch({ snippet: "We fixed the Sidebar layout", messageId: "m1" }, "sidebar layout"))
    .toEqual({ query: "Sidebar layout", start: { entryId: "m1", occurrence: 0 } });
  expect(findForMessageMatch({ snippet: "the sidebar was wrong", messageId: null }, "fix sidebar")).toEqual({ query: "sidebar" });
});

test("the active occurrence's highlight takes the active colour, in document order, on a copy", async () => {
  const { colorFindOccurrence, holdsFindColor, FIND_ACTIVE_HIGHLIGHT } = await import("./threadFind");
  const tree = [{ kind: "leaf", block: { type: "paragraph", content: [{ type: "highlight", content: [{ type: "text", text: "a" }] }, { type: "text", text: " " }, { type: "highlight", content: [{ type: "text", text: "a" }] }] } }];
  const second = colorFindOccurrence(tree, 1, FIND_ACTIVE_HIGHLIGHT);
  expect(holdsFindColor(second, FIND_ACTIVE_HIGHLIGHT)).toBe(true);
  expect((second[0].block.content[2] as { color?: string }).color).toBe(FIND_ACTIVE_HIGHLIGHT);
  expect((second[0].block.content[0] as { color?: string }).color).toBeUndefined();
  expect(holdsFindColor(tree, FIND_ACTIVE_HIGHLIGHT)).toBe(false);
  expect(colorFindOccurrence(tree, 5, FIND_ACTIVE_HIGHLIGHT)).toBe(tree);
});

test("revealing a match scrolls only as far as keeps it 96pt inside the view", async () => {
  const { findRevealDelta } = await import("./threadFind");
  expect(findRevealDelta({ top: 300, height: 20 }, 800)).toBe(0);
  expect(findRevealDelta({ top: 40, height: 20 }, 800)).toBe(-56);
  expect(findRevealDelta({ top: 900, height: 20 }, 800)).toBe(216);
  // A view too short for the margin centres the match.
  expect(findRevealDelta({ top: -10, height: 20 }, 100)).toBe(-50);
});

test("find matches in code are cut out of the highlighted tokens, with their line and column", async () => {
  const { findCodeMatches, splitTokensAtMatches } = await import("./threadFind");
  const code = "const a = 1\nlet needle = needle";
  const matches = findCodeMatches(code, "NEEDLE");
  expect(matches.map((m) => [m.line, m.column])).toEqual([[1, 4], [1, 13]]);
  const pieces = splitTokensAtMatches([{ kind: "kw", text: "let " }, { kind: "id", text: "needle = needle" }], matches, 12);
  expect(pieces.map((p) => [p.text, p.match])).toEqual([["let ", null], ["needle", 0], [" = ", null], ["needle", 1]]);
});
