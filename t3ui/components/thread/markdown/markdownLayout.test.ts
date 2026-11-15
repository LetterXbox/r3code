import { expect, test } from "nsh/test";
import { TextView } from "nsh/base";
import {
  alphaLabel, buildNodes, codeNode, flowOf, orderedGutter, orderedLabel, rootGaps, romanLabel,
  BLOCK_MARGIN, LIST_GUTTER, LIST_ITEM_GAP, type RenderNode,
} from "./markdownLayout";

const text = (value: string) => [{ type: "text" as const, text: value }];
const p = (value: string) => ({ type: "paragraph" as const, content: text(value) });
const h = (level: 1 | 2 | 3, value: string) => ({ type: "heading" as const, level, content: text(value) });
const li = (...children: ReturnType<typeof p>[] | any[]) => ({ children });

function gapsOf(nodes: RenderNode[]) {
  return rootGaps(nodes.map((node) => node.flow));
}

test("a heading and the paragraph under it are 0.65rem apart, not the sum of their margins", () => {
  const nodes = buildNodes([h(2, "Title"), p("Body")]);
  expect(gapsOf(nodes)).toEqual([0, BLOCK_MARGIN]);
  expect(BLOCK_MARGIN).toBe(10.4);
});

test("a heading takes 1.25rem above it when it follows a paragraph", () => {
  const nodes = buildNodes([p("Intro"), h(2, "Title"), p("Body")]);
  expect(gapsOf(nodes)).toEqual([0, 20, 10.4]);
});

test("the first block loses its top margin and the last its bottom margin", () => {
  const nodes = buildNodes([h(1, "Top"), p("Only")]);
  expect(gapsOf(nodes)[0]).toBe(0);
  expect(rootGaps([{ mt: 20, mb: 8 }])).toEqual([0]);
  expect(rootGaps([])).toEqual([]);
});

test("a tight list has 0.25rem between items and 0.65rem around the list", () => {
  const list = { type: "list" as const, items: [li(p("one")), li(p("two")), li(p("three"))] };
  const nodes = buildNodes([p("Before"), list, p("After")]);
  expect(gapsOf(nodes)).toEqual([0, 10.4, 10.4]);
  const node = nodes[1];
  if (node.kind !== "list") throw new Error("expected a list");
  expect(flowOf(node.items.map((item) => item.flow)).gaps).toEqual([0, LIST_ITEM_GAP, LIST_ITEM_GAP]);
  // Tight paragraphs are unwrapped `li` text: no margin inside the item.
  expect(flowOf(node.items[0].children.map((child) => child.flow)).gaps).toEqual([0]);
});

test("a loose list spaces its items by the paragraph margin", () => {
  const list = { type: "list" as const, loose: true, items: [li(p("one")), li(p("two"))] };
  const nodes = buildNodes([list]);
  const node = nodes[0];
  if (node.kind !== "list") throw new Error("expected a list");
  expect(flowOf(node.items.map((item) => item.flow)).gaps).toEqual([0, 10.4]);
});

test("a nested list keeps 0.65rem above it and shares its bottom margin with the next item", () => {
  const nested = { type: "list" as const, items: [li(p("inner a")), li(p("inner b"))] };
  const outer = { type: "list" as const, items: [li(p("outer one"), nested), li(p("outer two"))] };
  const nodes = buildNodes([outer]);
  const node = nodes[0];
  if (node.kind !== "list") throw new Error("expected a list");
  expect(flowOf(node.items[0].children.map((child) => child.flow)).gaps).toEqual([0, 10.4]);
  expect(flowOf(node.items.map((item) => item.flow)).gaps).toEqual([0, 10.4]);
});

test("markers follow the list type and how deeply lists are nested", () => {
  const inner = { type: "list" as const, items: [li(p("c"))] };
  const middle = { type: "list" as const, items: [li(p("b"), inner)] };
  const outer = { type: "list" as const, items: [li(p("a"), middle)] };
  const [top] = buildNodes([outer]);
  if (top.kind !== "list") throw new Error("expected a list");
  expect(top.style).toBe("disc");
  const mid = top.items[0].children[1];
  if (mid.kind !== "list") throw new Error("expected a list");
  expect(mid.style).toBe("circle");
  const deep = mid.items[0].children[1];
  if (deep.kind !== "list") throw new Error("expected a list");
  expect(deep.style).toBe("square");
  const ordered = { type: "list" as const, ordered: true, start: 3, items: [li(p("x")), li(p("y"))] };
  const [numbers] = buildNodes([ordered]);
  if (numbers.kind !== "list") throw new Error("expected a list");
  expect(numbers.items.map((item) => item.label)).toEqual(["3.", "4."]);
});

test("ordered lists nest as numbers, letters then roman numerals, and a numbered list under bullets starts at numbers", () => {
  const level3 = { type: "list" as const, ordered: true, items: [li(p("i"))] };
  const level2 = { type: "list" as const, ordered: true, items: [li(p("a"), level3)] };
  const level1 = { type: "list" as const, ordered: true, items: [li(p("1"), level2)] };
  const [top] = buildNodes([level1]);
  if (top.kind !== "list") throw new Error("expected a list");
  const second = top.items[0].children[1];
  if (second.kind !== "list") throw new Error("expected a list");
  const third = second.items[0].children[1];
  if (third.kind !== "list") throw new Error("expected a list");
  expect([top.style, second.style, third.style]).toEqual(["decimal", "lower-alpha", "lower-roman"]);
  expect([top.items[0].label, second.items[0].label, third.items[0].label]).toEqual(["1.", "a.", "i."]);
});

test("alphabetic and roman labels count the way CSS counters do", () => {
  expect([1, 2, 26, 27, 52, 53].map(alphaLabel)).toEqual(["a", "b", "z", "aa", "az", "ba"]);
  expect([1, 4, 9, 14, 40, 1994].map(romanLabel)).toEqual(["i", "iv", "ix", "xiv", "xl", "mcmxciv"]);
  expect(orderedLabel("decimal", 12)).toBe("12.");
});

test("the ordered gutter widens only when a number has more than one digit", () => {
  expect(orderedGutter(1, 9)).toBe(LIST_GUTTER);
  expect(orderedGutter(1, 10)).toBe(32);
  expect(orderedGutter(98, 3)).toBe(40);
});

test("a code card sits 0.65rem from the text around it, merged with the paragraph's margin", () => {
  const nodes = [...buildNodes([p("Intro")]), codeNode("ts", "x"), ...buildNodes([p("Outro")])];
  expect(gapsOf(nodes)).toEqual([0, 10.4, 10.4]);
});

test("the real parser marks tight and loose lists the way the layout expects", () => {
  const tight = TextView.parse("## Title\n\nBody\n\n- one\n  - nested\n- two\n");
  const nodes = buildNodes(tight.blocks);
  expect(nodes.map((node) => node.kind)).toEqual(["leaf", "leaf", "list"]);
  expect(gapsOf(nodes)).toEqual([0, 10.4, 10.4]);
  const list = nodes[2];
  if (list.kind !== "list") throw new Error("expected a list");
  expect(list.items.length).toBe(2);
  expect(list.items[0].children.map((child) => child.kind)).toEqual(["leaf", "list"]);
  const loose = TextView.parse("- one\n\n- two\n");
  const looseList = buildNodes(loose.blocks)[0];
  if (looseList.kind !== "list") throw new Error("expected a list");
  expect(flowOf(looseList.items.map((item) => item.flow)).gaps).toEqual([0, 10.4]);
});
