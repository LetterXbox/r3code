import { expect, test } from "nsh/test";
import { codeBlockEnter, convertFenceOnEnter, convertFenceOnSpace, indentCodeBlock, unwrapCodeBlockAtStart } from "./codeBlockEditing";
import { docToPrompt, promptToDoc } from "./promptDocument";

const rich = { skills: new Map<string, string>(), richText: true };
const doc = (text: string) => promptToDoc(text, rich);
const after = (edit: ReturnType<typeof codeBlockEnter>) => (edit && "doc" in edit ? docToPrompt(edit.doc) : null);

test("Enter in a code block keeps the line's indent, else a plain new line", () => {
  const d = doc("```ts\n  a\n```");
  // content starts at 1: "  a", caret at its end is 4
  expect(codeBlockEnter(d, 4, 4)).toEqual({ insert: "\n  " });
  expect(codeBlockEnter(doc("```\nb\n```"), 2, 2)).toEqual({ insert: "\n" });
});

test("Enter on a typed closing fence leaves the block and keeps the rest as lines", () => {
  const d = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "", fence: "```", close: "" }, content: [{ type: "text", text: "x\n```" }] }] };
  const edit = codeBlockEnter(d, 6, 6)!;
  expect(after(edit)).toBe("```\nx\n```\n");
  expect("doc" in edit && edit.caret).toBe(4);
});

test("Enter after two blank lines at the end leaves the block and closes it", () => {
  const d = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "", fence: "```", close: "" }, content: [{ type: "text", text: "x\n\n" }] }] };
  expect(after(codeBlockEnter(d, 4, 4))).toBe("```\nx\n```\n");
});

test("a fence line becomes a code block on Enter, or on a space after ```lang", () => {
  const d = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "```ts" }] }] };
  const edit = convertFenceOnEnter(d, 6, 6, "```ts")!;
  expect(after(edit)).toBe("```ts\n```");
  const typed = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "```py " }] }] };
  expect(after(convertFenceOnSpace(typed, 7))).toBe("```py\n```");
  expect(convertFenceOnSpace({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "``` x" }] }] }, 6)).toBe(null);
});

test("Tab indents a caret by two spaces; Shift+Tab outdents the lines", () => {
  const d = doc("```\n  a\nb\n```");
  expect(indentCodeBlock(d, 2, 2, "in")).toEqual({ insert: "  " });
  expect(after(indentCodeBlock(d, 1, 6, "out"))).toBe("```\na\nb\n```");
  expect(after(indentCodeBlock(d, 1, 6, "in"))).toBe("```\n    a\n  b\n```");
});

test("Backspace at a code block's start makes its lines paragraphs", () => {
  expect(after(unwrapCodeBlockAtStart(doc("```\na\nb\n```"), 1, 1))).toBe("a\nb");
});
