import { expect, test } from "nsh/test";
import type { FoldedRow } from "./turnFolds";
import { attemptFoldHiding, foldSupersededAttempts, resolveAttempt } from "./attemptFolds";

const attempts = [
  { id: "att-1", runId: "run-1", rootNodeId: "node-1", status: "superseded", completedAt: "2026-01-01T00:00:10.000Z" },
  { id: "att-2", runId: "run-1", rootNodeId: "node-2", status: "running", completedAt: null },
];
const nodes = [{ id: "node-1b", rootNodeId: "node-1", parentNodeId: "node-1" }];
const tool = (id: string, nodeId: string) => ({ id, type: "command_execution", title: "Command", detail: "ls", status: "completed", order: 1, item: { id, type: "command_execution", runId: "run-1", nodeId } as never });
const message = (id: string, role: "user" | "assistant") => ({ kind: "entry" as const, id, entry: { kind: "message", id, message: { id, role, body: id } } as never });

const rows: FoldedRow[] = [
  message("u1", "user"),
  { kind: "work", id: "w1", items: [tool("t1", "node-1b")], active: false },
  message("a1", "assistant"),
  message("u2", "user"),
  { kind: "work", id: "w2", items: [tool("t2", "node-2")], active: false },
];
const messageItems = new Map<unknown, Record<string, unknown>>([
  ["u1", { id: "i-u1", type: "user_message", messageId: "u1", runId: "run-1", nodeId: "node-1" }],
  ["a1", { id: "i-a1", type: "assistant_message", messageId: "a1", runId: "run-1", nodeId: "node-1", status: "completed", completedAt: "2026-01-01T00:00:20.000Z" }],
]);

test("resolveAttempt walks an item's node to its attempt's root", () => {
  expect(resolveAttempt({ runId: "run-1", nodeId: "node-1b" }, { attempts, nodes })?.id).toBe("att-1");
  expect(resolveAttempt({ runId: "run-2", nodeId: "node-1b" }, { attempts, nodes })).toBe(undefined);
});

test("a superseded attempt folds its output behind one Superseded attempt row, the user's messages stay", () => {
  const folded = foldSupersededAttempts(rows, { attempts, nodes, messageItems }, {});
  expect(folded.map((row) => row.kind === "fold" ? `${row.label}:${row.id}` : row.id)).toEqual(["u1", "Superseded attempt:attempt-fold:att-1", "u2", "w2"]);
  const open = foldSupersededAttempts(rows, { attempts, nodes, messageItems }, { "attempt-fold:att-1": true });
  expect(open.map((row) => row.id)).toEqual(["u1", "attempt-fold:att-1", "w1", "a1", "u2", "w2"]);
});

test("an attempt whose reply completed before the steer, or a run still active, stays open", () => {
  const early = new Map(messageItems);
  early.set("a1", { ...messageItems.get("a1"), completedAt: "2026-01-01T00:00:05.000Z" });
  expect(foldSupersededAttempts(rows, { attempts, nodes, messageItems: early }, {}).some((row) => row.kind === "fold")).toBe(false);
  expect(foldSupersededAttempts(rows, { attempts, nodes, messageItems, runs: [{ id: "run-1", status: "running" }] }, {}).some((row) => row.kind === "fold")).toBe(false);
});

test("find opens the superseded attempt that hides a match", () => {
  expect(attemptFoldHiding(rows, { attempts, nodes, messageItems }, "a1")).toBe("attempt-fold:att-1");
  expect(attemptFoldHiding(rows, { attempts, nodes, messageItems }, "w2")).toBe(null);
});
