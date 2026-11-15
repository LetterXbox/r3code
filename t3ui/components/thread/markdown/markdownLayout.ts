// Block layout for chat markdown, ported from index.css `.chat-markdown`:
//
//   p, ul, ol, blockquote, pre, table      margin: 0.65rem 0
//   h1-h6                                  margin: 1.25rem 0 0.5rem
//   ul / ol                                padding-inline-start 1.25rem (--list-gutter)
//   li + li                                margin-top: 0.25rem
//   > :first-child / > :last-child         margin-top / margin-bottom: 0
//
// A browser collapses vertical margins (siblings take the larger one, and a container
// without padding or border shares its first and last child's margin). GPUI has no margin
// collapsing, so this module resolves it: it turns blocks into flow nodes and says how far
// apart every sibling sits. Pure data in, numbers out, so the spacing can be tested without
// drawing anything.
import type { TextViewAlert, TextViewBlock, TextViewFootnote, TextViewInline, TextViewListItem } from "nsh/base";
import type { CodexArtifactTemplate } from "./codexDirectives";

export const REM = 16;
/** `margin: 0.65rem 0`, the block margin of paragraphs, lists, quotes, code blocks and tables. */
export const BLOCK_MARGIN = 0.65 * REM;
/** `.chat-markdown li + li { margin-top: 0.25rem }`. */
export const LIST_ITEM_GAP = 0.25 * REM;
/** `padding-inline-start: 1.25rem`, the width a list marker sits in. */
export const LIST_GUTTER = 1.25 * REM;
/** `ch` in the interface font at the chat's 14pt size (the width of a "0"). */
export const CH = 8;

/** A box in vertical flow: its own margins, and the boxes inside it when it is a container with no padding or border. */
export interface FlowNode {
  mt: number;
  mb: number;
  children?: FlowNode[];
}

export interface Flow {
  /** The margin above the first box after collapsing through its first children. */
  top: number;
  /** The margin below the last box after collapsing through its last children. */
  bottom: number;
  /** `gaps[i]` is the space between box i - 1 and box i (0 for the first). */
  gaps: number[];
}

/** A node's margins once a container's own margin has merged with its first and last child's. */
export function effectiveMargins(node: FlowNode): { top: number; bottom: number } {
  if (!node.children || node.children.length === 0) return { top: node.mt, bottom: node.mb };
  const inner = flowOf(node.children);
  return { top: Math.max(node.mt, inner.top), bottom: Math.max(node.mb, inner.bottom) };
}

/** Lays boxes out one after another: each pair is separated by the larger of the two margins that meet. */
export function flowOf(nodes: FlowNode[]): Flow {
  const margins = nodes.map(effectiveMargins);
  const gaps = margins.map((m, index) => (index === 0 ? 0 : Math.max(margins[index - 1].bottom, m.top)));
  return {
    top: margins.length === 0 ? 0 : margins[0].top,
    bottom: margins.length === 0 ? 0 : margins[margins.length - 1].bottom,
    gaps,
  };
}

/** The gaps between the top-level blocks of a message: `.chat-markdown > :first-child` and `:last-child` lose their outer margin. */
export function rootGaps(nodes: FlowNode[]): number[] {
  if (nodes.length === 0) return [];
  const trimmed = nodes.map((node, index) => ({
    ...node,
    mt: index === 0 ? 0 : node.mt,
    mb: index === nodes.length - 1 ? 0 : node.mb,
  }));
  return flowOf(trimmed).gaps;
}

// --- render tree ----------------------------------------------------------------------

export type ListStyle = "disc" | "circle" | "square" | "decimal" | "lower-alpha" | "lower-roman";

export type RenderNode =
  | { kind: "leaf"; block: TextViewBlock; flow: FlowNode }
  | { kind: "code"; language: string; code: string; /** The fence has not closed, or the reply is still streaming. */ open?: boolean; title?: string | null; flow: FlowNode }
  | { kind: "footnotes"; footnotes: TextViewFootnote[]; flow: FlowNode }
  | { kind: "quote"; children: RenderNode[]; flow: FlowNode }
  /** MarkdownDetails: a disclosure with a chevron and the summary ("Details" when it has none), its blocks indented below. */
  | { kind: "details"; open: boolean; summary: TextViewInline[]; children: RenderNode[]; flow: FlowNode }
  /** GITHUB_ALERT_PRESENTATIONS: a coloured rule, an icon and label ("Note", "Tip" ...), then the alert's blocks. */
  | { kind: "alert"; alert: TextViewAlert; children: RenderNode[]; flow: FlowNode }
  /** A `::artifact-template{...}` line: the template card. */
  | { kind: "template"; template: CodexArtifactTemplate; flow: FlowNode }
  | {
      kind: "list";
      ordered: boolean;
      style: ListStyle;
      /** The width the markers sit in. */
      gutter: number;
      items: RenderItem[];
      flow: FlowNode;
    };

export interface RenderItem {
  /** A task item's state; `undefined` for an ordinary item. */
  checked?: boolean;
  /** Which task of the message this is (0, 1, ...), for the task toggle. */
  taskIndex?: number;
  /** The item's own marker text for an ordered list: "1.", "b.", "iv.". Empty for bullets. */
  label: string;
  children: RenderNode[];
  flow: FlowNode;
}

export interface ListContext {
  /** `ul` ancestors: 0 draws discs, 1 circles, 2 or more squares. */
  ulDepth: number;
  /** `ol` ancestors: 0 draws numbers, 1 letters, 2 or more roman numerals. */
  olDepth: number;
  /** Inside a tight list item a paragraph has no `<p>` and so no margin. */
  tight: boolean;
  /** Counts the message's task items in reading order (shared by every list of one message). */
  tasks?: { count: number };
}

export const ROOT_CONTEXT: ListContext = { ulDepth: 0, olDepth: 0, tight: false };

export function bulletStyle(ulDepth: number): ListStyle {
  return ulDepth === 0 ? "disc" : ulDepth === 1 ? "circle" : "square";
}

export function orderedStyle(olDepth: number): ListStyle {
  return olDepth === 0 ? "decimal" : olDepth === 1 ? "lower-alpha" : "lower-roman";
}

/** `a`, `b`, ... `z`, `aa`, `ab` (CSS lower-alpha). */
export function alphaLabel(n: number): string {
  if (n < 1) return String(n);
  let out = "";
  let rest = n;
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** `i`, `ii`, `iv` (CSS lower-roman; numbers past 3999 fall back to digits as browsers do). */
export function romanLabel(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  let out = "";
  let rest = n;
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/** The marker text of an ordered item: its number in the list's style, then a full stop. */
export function orderedLabel(style: ListStyle, n: number): string {
  return `${style === "lower-alpha" ? alphaLabel(n) : style === "lower-roman" ? romanLabel(n) : String(n)}.`;
}

/**
 * ChatMarkdown's `orderedListGutterStyle`: a list whose widest number has more than one digit
 * widens the gutter to `digits + 2` ch so the right-aligned marker is not clipped.
 */
export function orderedGutter(start: number, itemCount: number): number {
  const first = Number.isNaN(start) ? 1 : start;
  const last = first + Math.max(itemCount - 1, 0);
  const width = Math.max(String(first).length, String(last).length);
  return width <= 1 ? LIST_GUTTER : (width + 2) * CH;
}

function leafFlow(block: TextViewBlock, ctx: ListContext): FlowNode {
  switch (block.type) {
    case "paragraph":
      return ctx.tight ? { mt: 0, mb: 0 } : { mt: BLOCK_MARGIN, mb: BLOCK_MARGIN };
    case "heading":
      return { mt: 1.25 * REM, mb: 0.5 * REM };
    // Tailwind's preflight zeroes an hr's margin; index.css gives it none.
    case "rule":
      return { mt: 0, mb: 0 };
    // MarkdownDetails: `my-2`.
    case "details":
      return { mt: 0.5 * REM, mb: 0.5 * REM };
    // A GitHub alert is `my-1`.
    case "blockquote":
      return { mt: 0.25 * REM, mb: 0.25 * REM };
    default:
      return { mt: BLOCK_MARGIN, mb: BLOCK_MARGIN };
  }
}

function itemNode(item: TextViewListItem, index: number, label: string, loose: boolean, ctx: ListContext): RenderItem {
  const taskIndex = item.checked !== undefined && ctx.tasks ? ctx.tasks.count++ : undefined;
  const children = buildNodes(item.children, { ...ctx, tight: !loose });
  return {
    checked: item.checked,
    ...(taskIndex !== undefined ? { taskIndex } : {}),
    label,
    children,
    flow: { mt: index === 0 ? 0 : LIST_ITEM_GAP, mb: 0, children: children.map((child) => child.flow) },
  };
}

/** Turns a document's blocks into the tree the renderer draws, each node carrying its margins. */
export function buildNodes(blocks: TextViewBlock[], ctx: ListContext = ROOT_CONTEXT): RenderNode[] {
  return blocks.map((block): RenderNode => {
    if (block.type === "list") {
      const ordered = block.ordered === true;
      const style = ordered ? orderedStyle(ctx.olDepth) : bulletStyle(ctx.ulDepth);
      const start = ordered ? (block.start ?? 1) : 1;
      const nested: ListContext = {
        ulDepth: ctx.ulDepth + (ordered ? 0 : 1),
        olDepth: ctx.olDepth + (ordered ? 1 : 0),
        tight: false,
        tasks: ctx.tasks,
      };
      const items = block.items.map((item, index) =>
        itemNode(item, index, ordered ? orderedLabel(style, start + index) : "", block.loose === true, nested),
      );
      return {
        kind: "list",
        ordered,
        style,
        gutter: ordered ? orderedGutter(start, block.items.length) : LIST_GUTTER,
        items,
        flow: { mt: BLOCK_MARGIN, mb: BLOCK_MARGIN, children: items.map((item) => item.flow) },
      };
    }
    if (block.type === "blockquote" && block.alert !== undefined) {
      const children = buildNodes(block.children, { ...ctx, tight: false });
      // `my-1` around a title (a paragraph's own margins) and the blocks: the container shares its first and last child's margins.
      return { kind: "alert", alert: block.alert, children, flow: { mt: 0.25 * REM, mb: 0.25 * REM, children: [{ mt: BLOCK_MARGIN, mb: BLOCK_MARGIN }, ...children.map((child) => child.flow)] } };
    }
    if (block.type === "details") {
      const children = buildNodes(block.children, { ...ctx, tight: false });
      return { kind: "details", open: block.open === true, summary: block.summary, children, flow: { mt: 0.5 * REM, mb: 0.5 * REM } };
    }
    if (block.type === "blockquote" && block.alert === undefined) {
      const children = buildNodes(block.children, { ...ctx, tight: false });
      return { kind: "quote", children, flow: { mt: BLOCK_MARGIN, mb: BLOCK_MARGIN, children: children.map((child) => child.flow) } };
    }
    return { kind: "leaf", block, flow: leafFlow(block, ctx) };
  });
}

/** The card of a `::artifact-template` line. */
export function templateNode(template: CodexArtifactTemplate): RenderNode {
  return { kind: "template", template, flow: { mt: BLOCK_MARGIN, mb: BLOCK_MARGIN } };
}

/** A fenced code block card (`.chat-markdown pre`: `margin: 0.65rem 0`). */
export function codeNode(language: string, code: string, open = false, title: string | null = null): RenderNode {
  return { kind: "code", language, code, open, title, flow: { mt: BLOCK_MARGIN, mb: BLOCK_MARGIN } };
}

/** The footnotes section after the blocks: `margin-top: 1.25rem`. */
export function footnotesNode(footnotes: TextViewFootnote[]): RenderNode {
  return { kind: "footnotes", footnotes, flow: { mt: 1.25 * REM, mb: 0 } };
}
