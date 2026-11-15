import { expect, test } from "nsh/test";
import { composerMathRanges } from "./composerMath";
import { promptToDoc, type PromptTokenContext } from "./promptDocument";

test("inline formulas are found as remark-math reads them", () => {
  expect(composerMathRanges("so $x^2$ and $$y$$ and \\(z\\)").map((range) => range.source)).toEqual(["$x^2$", "$$y$$", "\\(z\\)"]);
  expect(composerMathRanges("costs \\$5 and `$x$` only")).toEqual([]);
  expect(composerMathRanges("no close $x")).toEqual([]);
  expect(composerMathRanges("$$a$b$$").map((range) => range.source)).toEqual(["$$a$b$$"]);
});

const context: PromptTokenContext = { richText: true, skills: new Map() };

test("math source is not styled or chipped", () => {
  const doc = promptToDoc("*a* $x *b* y$ *c*", context);
  const inline = ((doc.content ?? [])[0]?.content ?? []) as { text?: string; marks?: { type: string }[] }[];
  const math = inline.find((node) => (node.text ?? "").includes("$x"));
  expect(math?.text).toContain("$x *b* y$");
  expect(math?.marks ?? []).toEqual([]);
  const italic = inline.filter((node) => node.marks?.some((mark) => mark.type === "italic")).map((node) => node.text);
  expect(italic).toEqual(["a", "c"]);
});

test("a file link whose path holds dollars stays a chip and is not read as a formula", () => {
  const link = "[a.$x.$y.tsx](app/a.%24x.%24y.tsx)";
  const doc = promptToDoc(`fix ${link} now`, context);
  const kinds = ((doc.content ?? [])[0]?.content ?? []).map((node) => node.type);
  expect(kinds).toContain("token");
  expect(composerMathRanges("see [a.$x.$y](a.$x.$y) ok", [{ start: 4, end: 21 }])).toEqual([]);
});
