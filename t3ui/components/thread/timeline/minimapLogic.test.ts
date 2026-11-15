import { expect, test } from "nsh/test";
import { chatLaneLeft } from "../chatLane";
import {
  deriveTimelineMinimapItems,
  markdownPreviewText,
  resolveTimelineMinimapPreview,
  timelineMinimapCurrentIndex,
  timelineMinimapHasPersistentGutter,
  timelineMinimapHeight,
  timelineMinimapHitStripWidth,
  timelineMinimapIndexFromPointer,
  timelineMinimapInteractiveWidth,
  timelineMinimapPreviewShift,
  timelineMinimapStripScale,
  timelineMinimapTopPercent,
  viewableRange,
} from "./minimapLogic";

const entry = (id: string, role: "user" | "assistant", body: string) => ({ kind: "entry", id, entry: { kind: "message", id, message: { id, role, body } } }) as never;

test("one item per user message, with the final answer of its turn, read from the unfolded rows when a turn is folded", () => {
  const all = [entry("u1", "user", "first"), entry("a1", "assistant", "draft"), entry("a2", "assistant", "final one"), entry("u2", "user", "second"), entry("a3", "assistant", "only")];
  const folded = [entry("u1", "user", "first"), entry("u2", "user", "second"), entry("a3", "assistant", "only")];
  expect(deriveTimelineMinimapItems(folded, all)).toEqual([
    { id: "u1", rowIndex: 0, userText: "first", assistantText: "final one" },
    { id: "u2", rowIndex: 1, userText: "second", assistantText: "only" },
  ]);
  const withSystem = [entry("u1", "user", "first"), entry("a1", "assistant", "answer"), { kind: "entry", id: "s1", entry: { kind: "message", id: "s1", message: { id: "s1", role: "system", body: "ignored system note" } } } as never];
  expect(deriveTimelineMinimapItems(withSystem, withSystem)).toEqual([
    { id: "u1", rowIndex: 0, userText: "first", assistantText: "answer" },
  ]);
});

test("the preview collapses whitespace and reads markdown as plain text", () => {
  expect(markdownPreviewText("## Title\n\n- **bold** and [link](http://x.y) with `code`\n![alt](a.png)")).toMatch(/Title\s+bold and link with code\s+alt/);
  const preview = resolveTimelineMinimapPreview({ id: "a", rowIndex: 0, userText: "  a \n b  ", assistantText: "x\n\ny" });
  expect(preview?.userText).toBe("a b");
  expect(preview?.assistantText).toBe("x y");
  expect(resolveTimelineMinimapPreview({ id: "a", rowIndex: 0, userText: "   ", assistantText: null })?.userText).toBeNull();
});

test("the rail is 8pt a gap, capped at the window less 18rem; strips sit by their share of it", () => {
  expect(timelineMinimapHeight(12, 900)).toBe(88);
  expect(timelineMinimapHeight(200, 600)).toBe(312);
  expect(timelineMinimapHeight(1, 900)).toBe(1);
  expect(timelineMinimapTopPercent(0, 5)).toBe(0);
  expect(timelineMinimapTopPercent(2, 5)).toBe(50);
  expect(timelineMinimapTopPercent(9, 5)).toBe(100);
});

test("the pointer picks the nearest strip; strips fan out by distance; the card hangs, centres or rises", () => {
  expect(timelineMinimapIndexFromPointer({ itemCount: 5, railTop: 0, railHeight: 100, pointerY: 50 })).toBe(2);
  expect(timelineMinimapIndexFromPointer({ itemCount: 5, railTop: 0, railHeight: 100, pointerY: -40 })).toBe(0);
  expect(timelineMinimapIndexFromPointer({ itemCount: 0, railTop: 0, railHeight: 100, pointerY: 5 })).toBeNull();
  expect([0, 1, 2, 3, null].map(timelineMinimapStripScale)).toEqual([1, 0.667, 0.417, 0.333, 0.333]);
  expect([0, 2, 4].map((index) => timelineMinimapPreviewShift(index, 5, 60))).toEqual([0, -30, -60]);
});

test("the gutter decides whether the rail stays, how wide it reacts and how wide it grows with a card", () => {
  expect(timelineMinimapHasPersistentGutter(48)).toBe(true);
  expect(timelineMinimapHasPersistentGutter(12)).toBe(false);
  expect(timelineMinimapHitStripWidth(48)).toBe(36);
  expect(timelineMinimapHitStripWidth(200)).toBe(40);
  expect(timelineMinimapHitStripWidth(12)).toBe(0);
  expect(timelineMinimapInteractiveWidth(36, true)).toBe(352);
  expect(timelineMinimapInteractiveWidth(36, false)).toBe(36);
});

test("a centered message column gives the ladder its full available gutter", () => {
  const gutter = chatLaneLeft(1000, 12, "comfortable");
  expect(gutter).toBe(132);
  expect(timelineMinimapHasPersistentGutter(gutter)).toBe(true);
  expect(timelineMinimapHitStripWidth(gutter)).toBe(40);
  expect(chatLaneLeft(500, 12, "comfortable")).toBe(12);
});

test("the current turn is the first user message in view, else the one before the view", () => {
  expect(timelineMinimapCurrentIndex({ start: 4, end: 8 }, [0, 5, 9])).toBe(1);
  expect(timelineMinimapCurrentIndex({ start: 6, end: 8 }, [0, 5, 9])).toBe(1);
  expect(timelineMinimapCurrentIndex({ start: 0, end: 2 }, [3, 9])).toBeNull();
  expect(timelineMinimapCurrentIndex(null, [0])).toBeNull();
  expect(viewableRange([{ index: 3, isViewable: true }, { index: 5, isViewable: true }, { index: 9, isViewable: false }])).toEqual({ start: 3, end: 5 });
  expect(viewableRange([])).toBeNull();
});

test("an attachment-only send's bootstrap prompt previews as no text", async () => {
  const { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } = await import("./userMessagePresentation");
  const rows = [entry("u1", "user", `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`)];
  expect(deriveTimelineMinimapItems(rows, rows)[0]!.userText).toBe("");
});

test("minimap keys step the previewed message, clamp at the ends, and Home/End jump", async () => {
  const { stepMinimapIndex } = await import("./minimapLogic");
  expect(stepMinimapIndex(null, 4, "down")).toBe(1);
  expect(stepMinimapIndex(3, 4, "down")).toBe(3);
  expect(stepMinimapIndex(0, 4, "up")).toBe(0);
  expect(stepMinimapIndex(2, 4, "home")).toBe(0);
  expect(stepMinimapIndex(0, 4, "end")).toBe(3);
  expect(stepMinimapIndex(0, 0, "down")).toBe(null);
});
