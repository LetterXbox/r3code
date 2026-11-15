import { expect, test } from "nsh/test";
import { createStableTimelineRows } from "./stableTimelineRows";
import type { FoldedRow } from "./turnFolds";

const row = (id: string, body: string): FoldedRow => ({ kind: "entry", id, entry: { kind: "message", id, order: 1, sequence: 0, message: { id, role: "assistant", body } } });

test("unchanged rows keep their identity while changed messages update", () => {
  const stable = createStableTimelineRows();
  const first = stable("thread-a", [row("a", "old"), row("b", "same")]);
  const identical = stable("thread-a", [row("a", "old"), row("b", "same")]);
  expect(identical === first).toBe(true);
  const changed = stable("thread-a", [row("a", "new"), row("b", "same")]);
  expect(changed[0] === first[0]).toBe(false);
  expect(changed[1] === first[1]).toBe(true);
  const otherThread = stable("thread-b", [row("a", "new"), row("b", "same")]);
  expect(otherThread[1] === changed[1]).toBe(false);
});

test("insertions and ordering preserve only the rows with the same identity and content", () => {
  const stable = createStableTimelineRows();
  const first = stable("thread", [row("a", "a"), row("b", "b")]);
  const next = stable("thread", [row("b", "b"), row("c", "c"), row("a", "a")]);
  expect(next[0] === first[1]).toBe(true);
  expect(next[2] === first[0]).toBe(true);
  expect(next.map((item) => item.id)).toEqual(["b", "c", "a"]);
});
