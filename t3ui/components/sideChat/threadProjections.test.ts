// Two threads subscribed at once (the open thread and a retained side chat), fed interleaved contract-shaped
// subscribeThread items: each keeps its own transcript, runs, approvals and activity.
import { expect, test } from "nsh/test";
import {
  applyShellEventForTest, applyThreadEventForTest, openThreadById, retainThread, retainedThreadCount, threadActiveRunIdFor,
  threadActivityFor, threadApprovalsFor, threadMessages, threadMessagesFor, threadRunsFor, threadApprovals, threadWorkFor,
} from "../../store";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const shell = (id: string) => ({
  id, projectId: "p1", title: id, creationSource: "web", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "m" },
  providerInstanceHistory: ["codex"], lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, status: "completed",
  latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: iso(90), updatedAt: iso(30),
});
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [{ id: "p1", title: "legion", workspaceRoot: "/work/legion", pinnedAt: null, createdAt: iso(100), updatedAt: iso(30) }],
  threads: [shell("A"), shell("B")],
} });
openThreadById("A");

test("a retained provider subagent follows its runless execution node", () => {
  const release = retainThread("side-runless");
  const startedAt = "2026-11-13T15:30:00.000Z";
  const node = { id: "node:side", kind: "root_turn", runId: null, status: "running", startedAt };
  applyThreadEventForTest("side-runless", { kind: "snapshot", projection: {
    thread: { creationSource: "provider", lineage: { relationshipToParent: "subagent" } },
    messages: [], runs: [], nodes: [node], turnItems: [],
  } });
  expect(threadWorkFor("side-runless")).toEqual({ working: true, startedAt: Date.parse(startedAt) });
  applyThreadEventForTest("side-runless", { kind: "event", sequence: 1, event: { type: "node.updated", payload: { ...node, status: "completed" } } });
  expect(threadWorkFor("side-runless").working).toBe(false);
  release();
});

const snapshot = (threadId: string, text: string) => ({ kind: "snapshot", projection: {
  messages: [{ id: `${threadId}:m1`, role: "user", text, createdAt: iso(5) }],
  runs: [{ id: `${threadId}:run1`, threadId, ordinal: 1, status: "running" }], runtimeRequests: [], turnItems: [], subagents: [],
} });
const event = (type: string, payload: Record<string, unknown>) => ({ kind: "event", event: { type, payload } });

test("interleaved events for two subscribed threads land in their own projections", () => {
  const release = retainThread("B");
  expect(retainedThreadCount("B")).toBe(1);
  applyThreadEventForTest("A", snapshot("A", "question for A"));
  applyThreadEventForTest("B", snapshot("B", "question for B"));
  applyThreadEventForTest("B", event("message.updated", { id: "B:m2", role: "assistant", text: "answer B", createdAt: iso(4) }));
  applyThreadEventForTest("A", event("message.updated", { id: "A:m2", role: "assistant", text: "answer A", createdAt: iso(4) }));
  applyThreadEventForTest("B", event("runtime-request.updated", { id: "req:B", kind: "command", status: "pending", responseCapability: { type: "live" } }));
  applyThreadEventForTest("B", event("turn-item.updated", { id: "item:B", type: "approval_request", requestId: "req:B", title: "Run ls", prompt: "ls", startedAt: iso(3) }));
  applyThreadEventForTest("A", event("run.updated", { id: "A:run1", threadId: "A", ordinal: 1, status: "completed" }));
  applyThreadEventForTest("B", event("turn-item.updated", { id: "item:B2", type: "command_execution", input: "pwd", status: "completed", startedAt: iso(2) }));

  expect(threadMessages().map((message) => message.body)).toEqual(["question for A", "answer A"]);
  expect(threadMessagesFor("A").map((message) => message.body)).toEqual(["question for A", "answer A"]);
  expect(threadMessagesFor("B").map((message) => message.body)).toEqual(["question for B", "answer B"]);
  expect(threadApprovals()).toEqual([]);
  expect(threadApprovalsFor("B").map((item) => item.id)).toEqual(["req:B"]);
  expect(threadRunsFor("A").map((run) => run.status)).toEqual(["completed"]);
  expect(threadRunsFor("B").map((run) => run.status)).toEqual(["running"]);
  expect(threadActiveRunIdFor("B")).toBe("B:run1");
  expect(threadActivityFor("A").length).toBe(0);
  expect(threadActivityFor("B").some((item) => item.id === "item:B2")).toBe(true);

  const second = retainThread("B");
  release();
  expect(retainedThreadCount("B")).toBe(1);
  second();
  expect(retainedThreadCount("B")).toBe(0);
  // Released: its events are no longer projected.
  applyThreadEventForTest("B", event("run.updated", { id: "B:run2", threadId: "B", ordinal: 2, status: "running" }));
  expect(threadRunsFor("B")).toEqual([]);
});
