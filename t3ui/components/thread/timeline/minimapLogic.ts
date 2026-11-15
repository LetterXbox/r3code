// chat/timelineMinimapItems.ts and the minimap functions of chat/MessagesTimeline.logic.ts, over the port's timeline rows.
// One strip per user message; hovering a strip shows that turn's message and the start of its final answer.
import { isAttachmentOnlyBootstrapPrompt } from "./userMessagePresentation";
import type { Message } from "../../../store";
import type { FoldedRow } from "./turnFolds";
import { rowMessage } from "./workLog";
import type { TimelineRow } from "./workLog";

export interface TimelineMinimapItem {
  readonly id: string;
  /** The index of the user message's row in the list (what the list scrolls to). */
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

/** MessagesTimeline.logic.ts: fewer user messages than this show no minimap. */
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const ITEM_SPACING = 8;
/** `calc(100vh - 18rem)`: the rail never grows past the window less 18rem. */
const MAX_HEIGHT_REM = 18;
const REM = 16;
const PERSISTENT_GUTTER = 48;
const HIT_STRIP_LEFT = 12;
const HIT_STRIP_MAX_WIDTH = 40;
/** `22rem`: the hit strip while a preview shows, so the pointer can move onto the card. */
export const EXPANDED_HIT_STRIP_WIDTH = 22 * REM;
const NAVIGATION_REACH = 14;

function messageOf(row: FoldedRow): Message | undefined {
  return row.kind === "fold" ? undefined : rowMessage(row as TimelineRow);
}

/**
 * `rows` are the list's rows (what a strip scrolls to), `all` the same transcript with its turn folds open: a folded
 * turn's answer is in `all` only, and user messages are never folded away.
 */
export function deriveTimelineMinimapItems(rows: ReadonlyArray<FoldedRow>, all: ReadonlyArray<FoldedRow> = rows): TimelineMinimapItem[] {
  const rowIndexById = new Map(rows.map((row, index) => [row.id, index] as const));
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const row = all[index]!;
    const message = messageOf(row);
    const rowIndex = rowIndexById.get(row.id);
    if (!message || message.role !== "user" || rowIndex === undefined) continue;
    // timelineMinimapItems: an attachment-only send's bootstrap prompt previews as no text.
    const bootstrap = isAttachmentOnlyBootstrapPrompt(message.body);
    items.push({ id: row.id, rowIndex, userText: bootstrap ? "" : message.body, assistantText: finalAssistantText(all, index) });
  }
  return items;
}

/** The last assistant message after the user row and before the next user row. */
function finalAssistantText(rows: ReadonlyArray<FoldedRow>, userRowIndex: number): string | null {
  let text: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const message = messageOf(rows[index]!);
    if (!message) continue;
    if (message.role === "user") break;
    if (message.role === "assistant") text = message.body ?? null;
  }
  return text;
}

const BLOCK_TAGS = /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i;

/**
 * The text a markdown source reads as (markdownNodeText over a remark tree in the reference): the port has no
 * markdown tree at hand here, so this strips the syntax with patterns. Fences keep their code, links their label, images
 * their alt text, HTML its text, and a thread link reads "a thread".
 */
export function markdownPreviewText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) => (BLOCK_TAGS.test(tag) ? " " : ""))
    .replace(/^ {0,3}(```|~~~)[^\n]*$/gm, " ")
    .replace(/!\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_, label: string, href: string) => (/^t3:\/\/thread\//.test(href) || /\/thread\/[^/\s]+$/.test(label) ? "a thread" : label))
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^ {0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1");
}

function compact(text: string | null | undefined): string | null {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  return value.length > 0 ? value : null;
}

/** The text the preview card shows: whitespace collapsed, the answer read as plain text from its first 1,500 characters. */
export function resolveTimelineMinimapPreview(item: TimelineMinimapItem | null): TimelineMinimapItem | null {
  return item === null
    ? null
    : { ...item, userText: compact(item.userText), assistantText: compact(item.assistantText === null ? null : markdownPreviewText(item.assistantText.slice(0, 1_500))) };
}

/** The rail's height in points: one 8pt step per gap between strips, never more than the window less 18rem. */
export function timelineMinimapHeight(itemCount: number, windowHeight: number): number {
  const natural = Math.max(1, (itemCount - 1) * ITEM_SPACING);
  return Math.max(0, Math.min(natural, windowHeight - MAX_HEIGHT_REM * REM));
}

export function timelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

/** The strip the pointer is over, from its distance down the rail. */
export function timelineMinimapIndexFromPointer(input: { itemCount: number; railTop: number; railHeight: number; pointerY: number }): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null;
  if (input.itemCount === 1) return 0;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** The fisheye: a strip's width by its distance from the hovered one. */
export function timelineMinimapStripScale(activeDistance: number | null): number {
  if (activeDistance === null) return 0.333;
  return activeDistance === 0 ? 1 : activeDistance === 1 ? 0.667 : activeDistance === 2 ? 0.417 : 0.333;
}

/** Where the preview card sits against its strip: the first and last cards hang from or rise to their strip. */
export function timelineMinimapPreviewShift(index: number, itemCount: number, cardHeight: number): number {
  return index === 0 ? 0 : index === itemCount - 1 ? -cardHeight : -cardHeight / 2;
}

/** The gutter beside the transcript lane. */
export function timelineMinimapHasPersistentGutter(gutter: number): boolean {
  return gutter >= PERSISTENT_GUTTER;
}

export function timelineMinimapHitStripWidth(gutter: number): number {
  return Math.max(0, Math.min(HIT_STRIP_MAX_WIDTH, Math.floor(gutter) - HIT_STRIP_LEFT));
}

export function timelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= NAVIGATION_REACH;
}

export function timelineMinimapInteractiveWidth(collapsedWidth: number, expanded: boolean): number {
  return expanded ? EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

/** Whether a user row is inside the viewable rows. */
export function timelineMinimapRowVisible(rowIndex: number, range: { start: number; end: number } | null): boolean {
  return range !== null && rowIndex >= range.start && rowIndex <= range.end;
}

/** The turn being read: the first user message in view, else the one before the view. */
export function timelineMinimapCurrentIndex(range: { start: number; end: number } | null, rowIndices: ReadonlyArray<number>): number | null {
  if (range === null) return null;
  let preceding: number | null = null;
  for (const [index, rowIndex] of rowIndices.entries()) {
    if (rowIndex >= range.start) return rowIndex <= range.end ? index : preceding;
    preceding = index;
  }
  return preceding;
}

/** The viewable rows of a list report as a range. */
export function viewableRange(viewable: ReadonlyArray<{ index: number | null; isViewable: boolean }>): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const token of viewable) {
    if (!token.isViewable || token.index === null) continue;
    start = Math.min(start, token.index);
    end = Math.max(end, token.index);
  }
  return start === Infinity ? null : { start, end };
}

/** TimelineMinimap's keys: Up/Down step the previewed message (clamped), Home/End go to the first and last. */
export function stepMinimapIndex(index: number | null, count: number, key: "up" | "down" | "home" | "end"): number | null {
  if (count <= 0) return null;
  if (key === "home") return 0;
  if (key === "end") return count - 1;
  const from = index ?? 0;
  return Math.min(count - 1, Math.max(0, from + (key === "down" ? 1 : -1)));
}
