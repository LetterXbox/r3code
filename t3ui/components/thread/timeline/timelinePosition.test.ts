import { expect, test } from "nsh/test";
import { anchoredEndSpace, anchorReleasedByToolActivity, createPositionMemory, firstViewableId, restoreTarget, rowRestoreOffset, settleListScroll, shouldAnchorNewUserMessage, SETTLE_MAX_FRAMES } from "./timelinePosition";

test("only a locally pending message anchors a new turn", () => {
  const message = { id: "m", role: "user" as const, body: "hello", order: 1 };
  const entry = { kind: "message" as const, id: "message:m", order: 1, sequence: 0, message };
  expect(shouldAnchorNewUserMessage(entry)).toBe(false);
  expect(shouldAnchorNewUserMessage({ ...entry, message: { ...message, pending: true } })).toBe(true);
  expect(shouldAnchorNewUserMessage(undefined)).toBe(false);
});

const rows = ["m1", "work:a", "m2", "m3"];

test("a thread left at its end, or never left, opens at its end", () => {
  expect(restoreTarget(undefined, rows)).toEqual({ kind: "end" });
  expect(restoreTarget({ rowId: "m1", atEnd: true, scrollOffset: 40 }, rows)).toEqual({ kind: "end" });
});

test("a thread left in its history opens at the row that was in view, else at the offset", () => {
  expect(restoreTarget({ rowId: "m2", atEnd: false, scrollOffset: 900 }, rows)).toEqual({ kind: "row", index: 2, rowId: "m2", offsetWithinRow: 0 });
  expect(restoreTarget({ rowId: "m2", atEnd: false, scrollOffset: 900, offsetWithinRow: 37 }, rows)).toEqual({ kind: "row", index: 2, rowId: "m2", offsetWithinRow: 37 });
  expect(restoreTarget({ rowId: "gone", atEnd: false, scrollOffset: 900 }, rows)).toEqual({ kind: "offset", offset: 900 });
  expect(restoreTarget({ rowId: null, atEnd: false, scrollOffset: -5 }, rows)).toEqual({ kind: "offset", offset: 0 });
});

test("the memory keeps the latest position per thread and drops the least recently left past its limit", () => {
  const memory = createPositionMemory(2);
  memory.remember("a", { rowId: "1", atEnd: false, scrollOffset: 1 });
  memory.remember("b", { rowId: "2", atEnd: false, scrollOffset: 2 });
  memory.remember("a", { rowId: "3", atEnd: true, scrollOffset: 3 });
  memory.remember("c", { rowId: "4", atEnd: false, scrollOffset: 4 });
  expect(memory.recall("b")).toBeUndefined();
  expect(memory.recall("a")?.rowId).toBe("3");
  expect(memory.recall("c")?.rowId).toBe("4");
  memory.forget("a");
  expect(memory.recall("a")).toBeUndefined();
});

test("the first row in view is the lowest viewable index", () => {
  expect(firstViewableId([{ key: "m3", index: 3, isViewable: true }, { key: "m2", index: 2, isViewable: true }, { key: "m1", index: 1, isViewable: false }])).toBe("m2");
  expect(firstViewableId([])).toBe(null);
});

const frames = () => { const queue: Array<() => void> = []; return { requestFrame: (cb: () => void) => { queue.push(cb); }, async run(limit = 200) { let n = 0; while (queue.length && n < limit) { queue.shift()!(); n += 1; await Promise.resolve(); await Promise.resolve(); } return n; } }; };

test("settleListScroll corrects until the target holds two frames", async () => {
  const f = frames();
  let offset = 0;
  // The first scroll lands short (estimated rows); the measured target then holds.
  const writes: number[] = [];
  let done = false;
  void settleListScroll({ requestFrame: f.requestFrame, scrollOffset: () => offset, target: async () => 500, scrollToOffset: (to) => { writes.push(to); offset = to - (writes.length === 1 ? 80 : 0); }, isCancelled: () => false }).then(() => { done = true; });
  await f.run();
  expect(done).toBe(true);
  expect(offset).toBe(500);
  expect(writes).toEqual([500, 500]);
});

test("settleListScroll stops on cancel, a vanished target, or after the frame budget", async () => {
  const f = frames();
  let cancelled = false;
  let done = 0;
  void settleListScroll({ requestFrame: f.requestFrame, scrollOffset: () => 0, target: () => 100, scrollToOffset: () => { cancelled = true; }, isCancelled: () => cancelled }).then(() => { done += 1; });
  void settleListScroll({ requestFrame: f.requestFrame, scrollOffset: () => 0, target: () => undefined, scrollToOffset: () => {}, isCancelled: () => false }).then(() => { done += 1; });
  let writes = 0;
  // A target that never holds still (a streaming end) gives up after SETTLE_MAX_FRAMES.
  void settleListScroll({ requestFrame: f.requestFrame, scrollOffset: () => 0, target: () => 10 + writes, scrollToOffset: () => { writes += 1; }, isCancelled: () => false }).then(() => { done += 1; });
  await f.run(1000);
  expect(done).toBe(3);
  expect(writes).toBe(SETTLE_MAX_FRAMES);
});

test("a saved row restores at its measured top plus the offset into it, inside the content", () => {
  expect(rowRestoreOffset({ scrollOffset: 1000, rowTopInView: 120, offsetWithinRow: 30, maxOffset: 5000 })).toBe(1150);
  expect(rowRestoreOffset({ scrollOffset: 1000, rowTopInView: 120, offsetWithinRow: 30, maxOffset: 1100 })).toBe(1100);
  expect(rowRestoreOffset({ scrollOffset: 0, rowTopInView: -50, offsetWithinRow: 0, maxOffset: 1100 })).toBe(0);
});

test("the anchored end space lets the sent message sit 24pt below the top, and goes once the rows after it fill the view", () => {
  // Message at 2000 in 2300 of content, 600 viewport: the end is 1700, the anchor needs 1976, so 276 of space.
  expect(anchoredEndSpace({ anchorTopInContent: 2000, contentHeight: 2300, viewportHeight: 600 })).toBe(276);
  expect(anchoredEndSpace({ anchorTopInContent: 2000, contentHeight: 2700, viewportHeight: 600 })).toBe(0);
});

test("tool activity after the anchored message releases it; a streaming answer does not", () => {
  const rows = [{ id: "message:u1", kind: "entry" }, { id: "message:a1", kind: "entry" }];
  expect(anchorReleasedByToolActivity(rows, "message:u1")).toBe(false);
  expect(anchorReleasedByToolActivity([...rows, { id: "work:1", kind: "work" }], "message:u1")).toBe(true);
  expect(anchorReleasedByToolActivity([{ id: "work:0", kind: "work" }, ...rows], "message:u1")).toBe(false);
  expect(anchorReleasedByToolActivity(rows, null)).toBe(false);
});
