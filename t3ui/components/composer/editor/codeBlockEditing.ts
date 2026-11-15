// composer-code-block.ts and the code block parts of ComposerPromptEditorTiptap.tsx, on the editor's JSON document:
// Enter in a code block (leave it on a closing fence or after two blank lines, keep the line's indent, else a new
// line), a fence typed on its own line becoming a code block (on Enter, or on a space as Tiptap's input rule does),
// Tab / Shift+Tab indenting its lines, and Backspace at its start turning it back into lines.
import type { RichNodeJSON } from "nsh/base";
import { CODE_BLOCK_NODE, nodeSize } from "./promptDocument";
import { isClosingFence, parseOpeningFence } from "./richMarkdown";

const CODE_BLOCK_INDENT = "  ";

/** What an edit does: insert text at the selection (an ordinary, undoable keystroke), or replace the document. */
export type CodeBlockEdit = { insert: string } | { doc: RichNodeJSON; caret: number; anchor?: number };

// A block's content size: its children's ProseMirror sizes (a list's items nest).
const contentSize = (block: RichNodeJSON) => nodeSize(block) - 2;
const codeText = (block: RichNodeJSON) => (block.content ?? []).map((node) => node.text ?? "").join("");
const paragraph = (text: string): RichNodeJSON => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const codeBlock = (attrs: Record<string, unknown>, text: string): RichNodeJSON => ({ type: CODE_BLOCK_NODE, attrs, ...(text ? { content: [{ type: "text", text }] } : {}) });

/** The top-level block holding `pos`: its index, where its content starts, and the offset in it. */
export function blockAt(doc: RichNodeJSON, pos: number): { index: number; start: number; offset: number; node: RichNodeJSON } | null {
  let start = 1;
  const blocks = doc.content ?? [];
  for (let index = 0; index < blocks.length; index += 1) {
    const node = blocks[index]!;
    const size = contentSize(node);
    if (pos >= start && pos <= start + size) return { index, start, offset: pos - start, node };
    start += size + 2;
  }
  return null;
}

/** Where block `index`'s content starts. */
export function blockStart(blocks: readonly RichNodeJSON[], index: number): number {
  let start = 1;
  for (let at = 0; at < index; at += 1) start += contentSize(blocks[at]!) + 2;
  return start;
}

export const inCodeBlock = (doc: RichNodeJSON, pos: number) => blockAt(doc, pos)?.node.type === CODE_BLOCK_NODE;

const replaceBlocks = (doc: RichNodeJSON, index: number, next: RichNodeJSON[]): RichNodeJSON[] => {
  const blocks = [...(doc.content ?? [])];
  blocks.splice(index, 1, ...next);
  return blocks;
};

/** Enter inside a code block: exitCodeBlockOnClosingFence, exitCodeBlockOnTrailingBlankLines, indentedNewlineInCodeBlock, newlineInCode. */
export function codeBlockEnter(doc: RichNodeJSON, anchor: number, head: number): CodeBlockEdit | null {
  const at = blockAt(doc, head);
  if (!at || at.node.type !== CODE_BLOCK_NODE || blockAt(doc, anchor)?.index !== at.index) return null;
  const text = codeText(at.node);
  const attrs = at.node.attrs ?? {};
  const fence = typeof attrs.fence === "string" && attrs.fence ? attrs.fence : "```";
  if (anchor === head) {
    const caret = at.offset;
    const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
    const newlineAfter = text.indexOf("\n", caret);
    const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;
    const line = text.slice(lineStart, lineEnd);
    if (caret === lineEnd && isClosingFence(line, fence)) {
      const code = text.slice(0, Math.max(0, lineStart - 1));
      const rest = newlineAfter === -1 ? [] : text.slice(newlineAfter + 1).split("\n");
      const blocks = replaceBlocks(doc, at.index, [codeBlock({ ...attrs, close: `\n${line}` }, code), paragraph(""), ...rest.map(paragraph)]);
      return { doc: { ...doc, content: blocks }, caret: blockStart(blocks, at.index + 1) };
    }
    const trailing = /\n[ \t]*\n[ \t]*$/.exec(text);
    if (caret === text.length && trailing) {
      const close = typeof attrs.close === "string" && attrs.close ? attrs.close : `\n${fence}`;
      const blocks = replaceBlocks(doc, at.index, [codeBlock({ ...attrs, close }, text.slice(0, text.length - trailing[0].length)), paragraph("")]);
      return { doc: { ...doc, content: blocks }, caret: blockStart(blocks, at.index + 1) };
    }
  }
  const from = Math.min(anchor, head) - at.start;
  const before = text.slice(0, from);
  const indent = /^[ \t]*/.exec(before.slice(before.lastIndexOf("\n") + 1))?.[0] ?? "";
  return { insert: `\n${indent}` };
}

/** convertCodeFenceOnEnter: Enter at the end of a top-level line that is an opening fence makes it a code block. */
export function convertFenceOnEnter(doc: RichNodeJSON, anchor: number, head: number, lineText: string): CodeBlockEdit | null {
  const at = blockAt(doc, head);
  if (anchor !== head || !at || at.node.type !== "paragraph" || at.offset !== contentSize(at.node)) return null;
  const opening = parseOpeningFence(lineText);
  if (!opening) return null;
  const blocks = replaceBlocks(doc, at.index, [codeBlock({ language: opening.language, fence: opening.fence, close: `\n${opening.fence}` }, "")]);
  return { doc: { ...doc, content: blocks }, caret: blockStart(blocks, at.index) };
}

// Tiptap's CodeBlock input rules (backtickInputRegex, tildeInputRegex): a fence and a language, then a space.
const FENCE_ON_SPACE = /^(?:```|~~~)([a-z]+)?\s$/;

/** A line typed as a fence, an optional language and a space becomes an empty code block (the space is not kept). */
export function convertFenceOnSpace(doc: RichNodeJSON, head: number): CodeBlockEdit | null {
  const at = blockAt(doc, head);
  if (!at || at.node.type !== "paragraph" || at.offset !== contentSize(at.node)) return null;
  const nodes = at.node.content ?? [];
  if (nodes.length !== 1 || nodes[0]!.type !== "text" || (nodes[0]!.marks?.length ?? 0) > 0) return null;
  const match = FENCE_ON_SPACE.exec(nodes[0]!.text ?? "");
  if (!match) return null;
  const blocks = replaceBlocks(doc, at.index, [codeBlock({ language: match[1] ?? "", fence: "```", close: "\n```" }, "")]);
  return { doc: { ...doc, content: blocks }, caret: blockStart(blocks, at.index) };
}

function outdentLine(line: string): string {
  if (line.startsWith(CODE_BLOCK_INDENT)) return line.slice(CODE_BLOCK_INDENT.length);
  if (line.startsWith("\t") || line.startsWith(" ")) return line.slice(1);
  return line;
}

/** indentCodeBlock: Tab at a caret inserts two spaces; over lines, or Shift+Tab, indents or outdents each line. */
export function indentCodeBlock(doc: RichNodeJSON, anchor: number, head: number, direction: "in" | "out"): CodeBlockEdit | null {
  const at = blockAt(doc, head);
  if (!at || at.node.type !== CODE_BLOCK_NODE || blockAt(doc, anchor)?.index !== at.index) return null;
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  if (from === to && direction === "in") return { insert: CODE_BLOCK_INDENT };
  const text = codeText(at.node);
  const startOffset = from - at.start;
  const endOffset = to - at.start;
  const lineStart = text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const newlineAfter = text.indexOf("\n", Math.max(startOffset, endOffset - 1));
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;
  const original = text.slice(lineStart, lineEnd).split("\n");
  const next = original.map((line) => (direction === "in" ? (line.length === 0 ? line : `${CODE_BLOCK_INDENT}${line}`) : outdentLine(line)));
  if (next.join("\n") === original.join("\n")) return { doc, caret: head, anchor };
  const replaced = text.slice(0, lineStart) + next.join("\n") + text.slice(lineEnd);
  const firstDelta = (next[0]?.length ?? 0) - (original[0]?.length ?? 0);
  const totalDelta = next.join("\n").length - original.join("\n").length;
  const nextFrom = Math.max(at.start + lineStart, from + firstDelta);
  const nextTo = Math.max(nextFrom, to + totalDelta);
  const blocks = replaceBlocks(doc, at.index, [codeBlock(at.node.attrs ?? {}, replaced)]);
  return { doc: { ...doc, content: blocks }, anchor: anchor <= head ? nextFrom : nextTo, caret: anchor <= head ? nextTo : nextFrom };
}

/** unwrapCodeBlockAtStart: Backspace at a code block's start turns its lines back into paragraphs. */
export function unwrapCodeBlockAtStart(doc: RichNodeJSON, anchor: number, head: number): CodeBlockEdit | null {
  const at = blockAt(doc, head);
  if (anchor !== head || !at || at.node.type !== CODE_BLOCK_NODE || at.offset !== 0) return null;
  const blocks = replaceBlocks(doc, at.index, codeText(at.node).split("\n").map(paragraph));
  return { doc: { ...doc, content: blocks }, caret: blockStart(blocks, at.index) };
}

/** The code block's info string and where it starts, for the language picker. */
export function codeBlockAt(doc: RichNodeJSON, pos: number): { start: number; language: string } | null {
  const at = blockAt(doc, pos);
  return at && at.node.type === CODE_BLOCK_NODE ? { start: at.start, language: String(at.node.attrs?.language ?? "") } : null;
}

/** The document with block `start`'s info string set (the language picker's pick). */
export function withCodeBlockLanguage(doc: RichNodeJSON, start: number, language: string): RichNodeJSON {
  const at = blockAt(doc, start);
  if (!at || at.node.type !== CODE_BLOCK_NODE) return doc;
  return { ...doc, content: replaceBlocks(doc, at.index, [{ ...at.node, attrs: { ...(at.node.attrs ?? {}), language } }]) };
}

/** Every code block's content start and info string (where the editor draws their headers). */
export function codeBlocks(doc: RichNodeJSON): { start: number; language: string }[] {
  const blocks = doc.content ?? [];
  return blocks.flatMap((block, index) => (block.type === CODE_BLOCK_NODE ? [{ start: blockStart(blocks, index), language: String(block.attrs?.language ?? "") }] : []));
}
