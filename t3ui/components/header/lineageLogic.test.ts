import { expect, test } from "nsh/test";
import { relationshipFailureToast, agentElapsedLabel, formatCompactElapsed, formatSubagentDisplayTitle, lineageModel, lineageTitle, projectionCanDetach, relationshipStatusLabel, type LineageThread } from "./lineageLogic";

const sub = { parentThreadId: "me", relationshipToParent: "subagent" as const, rootThreadId: "me", sideChat: false };
const agent = (id: string, status: string, createdAt: number): LineageThread => ({ id, title: id, status, createdAt, lineage: sub });

test("running agents, finished agents and side chats are grouped, newest first", () => {
  const model = lineageModel({
    current: { id: "me" }, showLineage: true, showSideChats: true,
    threads: [agent("old", "idle", 1), agent("run", "running", 3), agent("new", "completed", 2), { id: "chat", title: "Chat", status: "idle", lineage: { parentThreadId: "me", relationshipToParent: null, rootThreadId: "me", sideChat: true } }],
  });
  expect(model.active.map((row) => row.threadId)).toEqual(["run"]);
  expect(model.previous.map((row) => row.threadId)).toEqual(["new", "old"]);
  expect(model.sideChats.map((row) => row.threadId)).toEqual(["chat"]);
  expect(model.runningCount).toBe(1);
  expect(model.showLineageHeading).toBe(true);
  expect(lineageTitle(model.runningCount)).toBe("Lineage · 1 running");
});

test("workflow coordinator status determines its lineage group and running count", () => {
  const child = agent("child", "completed", 1);
  const coordinator = { id: "workflow", childThreadId: "child", title: "Workflow", status: "running", startedAt: 1, completedAt: null, providerInstanceId: null };
  const input = { current: { id: "me" }, threads: [child], subagents: [coordinator], showLineage: true, showSideChats: true };
  const active = lineageModel({ ...input, workflowStatuses: new Map([["child", "running"]]) });
  expect(active.active.map((row) => row.threadId)).toEqual(["child"]);
  expect(active.runningCount).toBe(1);
  const finished = lineageModel({ ...input, workflowStatuses: new Map([["child", "completed"]]) });
  expect(finished.previous.map((row) => row.threadId)).toEqual(["child"]);
  expect(finished.runningCount).toBe(0);
});

test("a lone Previous agents row has no heading", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [agent("a", "idle", 1)] });
  expect(model.showLineage).toBe(true);
  expect(model.showLineageHeading).toBe(false);
  expect(lineageTitle(0)).toBe("Lineage");
});

test("run forks belong to their source thread in the relationship graph", () => {
  const lineage = { parentThreadId: "other", relationshipToParent: "fork" as const, rootThreadId: "other", sideChat: false };
  const threads: LineageThread[] = [{ id: "source", title: "Source" }, { id: "child", title: "Child", lineage, forkSourceThreadId: "source" }];
  const input = { threads, showLineage: true, showSideChats: true };
  expect(lineageModel({ ...input, current: { id: "source" } }).related.map((row) => row.threadId)).toEqual(["child"]);
  expect(lineageModel({ ...input, current: { id: "child", lineage, forkSourceThreadId: "source" } }).related.map((row) => row.threadId)).toEqual(["source"]);
  expect(lineageModel({ ...input, current: { id: "other" } }).related).toEqual([]);
});

test("remote-only agents keep their lineage section and reference heading rules", () => {
  const input = { current: { id: "me" }, threads: [], showLineage: true, showSideChats: true };
  const previous = lineageModel({ ...input, remoteStatuses: ["completed"] });
  expect(previous.showLineage).toBe(true);
  expect(previous.showLineageHeading).toBe(false);
  const active = lineageModel({ ...input, remoteStatuses: ["waiting"] });
  expect(active.showLineage).toBe(true);
  expect(active.showLineageHeading).toBe(true);
  expect(lineageModel({ ...input, showLineage: false, remoteStatuses: ["completed"] }).showLineage).toBe(false);
});

test("agent status follows the active run, then the agent record, then the finished child run", () => {
  const child: LineageThread = { id: "child", title: "Child", status: "running", hasRun: false, lineage: { parentThreadId: "me", relationshipToParent: "subagent", rootThreadId: "me", sideChat: false } };
  const agent = { id: "agent", childThreadId: "child", title: "Child", status: "completed", startedAt: 1, completedAt: 2, providerInstanceId: null };
  const input = { current: { id: "me" }, threads: [child], subagents: [agent], showLineage: true, showSideChats: true };
  expect(lineageModel(input).previous.map((row) => row.threadId)).toEqual(["child"]);
  expect(lineageModel({ ...input, threads: [{ ...child, activityRunStatus: "running" }] }).active.map((row) => row.threadId)).toEqual(["child"]);
  expect(lineageModel({ ...input, threads: [{ ...child, status: "failed", hasRun: true }] }).previous[0]?.status).toBe("failed");
});

test("a parent that no list or title lookup knows has no row", () => {
  const current = { id: "me", lineage: { parentThreadId: "gone", relationshipToParent: "fork" as const, rootThreadId: "gone", sideChat: false } };
  const hidden = lineageModel({ current, showLineage: true, showSideChats: true, threads: [] });
  expect(hidden.showLineage).toBe(false);
  const resolved = lineageModel({ current, showLineage: true, showSideChats: true, threads: [], resolvedTitles: new Map([["gone", "Old work"]]) });
  expect(resolved.related.map((row) => [row.title, row.label, row.isParent])).toEqual([["Old work", "Parent thread", true]]);
});

test("a running subagent with no thread counts as running without a row", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [], subagents: [{ id: "n1", childThreadId: null, title: null, status: "running", startedAt: 1, completedAt: null, providerInstanceId: null }] });
  expect(model.runningCount).toBe(1);
  expect(model.showLineage).toBe(true);
  expect(model.active).toEqual([]);
});

test("a child the shells leave out comes from the projection's subagents", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [], subagents: [{ id: "n1", childThreadId: "kid", title: "Subagent: /root/code_reviewer", status: "completed", startedAt: 1, completedAt: 2, providerInstanceId: "codex" }] });
  expect(model.previous.map((row) => [row.threadId, row.title, row.providerInstanceId])).toEqual([["kid", "Code Reviewer", "codex"]]);
});

test("projected children use known shell status and creation time even without a matching lineage edge", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true,
    threads: [{ id: "z", title: "Known", createdAt: 10, activityRunStatus: "running" }],
    subagents: [
      { id: "1", childThreadId: "a", title: "Missing", status: "running", startedAt: 2, completedAt: null, providerInstanceId: null },
      { id: "2", childThreadId: "z", title: "Known", status: "completed", startedAt: 1, completedAt: 2, providerInstanceId: null },
    ] });
  expect(model.active.map((row) => row.threadId)).toEqual(["z", "a"]);
  expect(model.runningCount).toBe(2);
});

test("a live shell wins over its stale archived copy during refresh", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true,
    threads: [{ id: "child", title: "Live", activityRunStatus: "running", createdAt: 10 }, { id: "child", title: "Archived", status: "completed", createdAt: 1 }],
    subagents: [{ id: "agent", childThreadId: "child", title: null, status: "completed", startedAt: 1, completedAt: 2, providerInstanceId: null }] });
  expect(model.active.map((row) => [row.title, row.status])).toEqual([["Live", "running"]]);
  expect(model.previous).toEqual([]);
});

test("a stale archived shell cannot resurrect a relationship removed from its live copy", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true,
    threads: [
      { id: "child", title: "Live", lineage: { rootThreadId: "other", parentThreadId: "other", relationshipToParent: "subagent", sideChat: false }, status: "completed" },
      { id: "child", title: "Archived", lineage: { rootThreadId: "me", parentThreadId: "me", relationshipToParent: "subagent", sideChat: false }, status: "completed" },
    ] });
  expect(model.previous).toEqual([]);
  expect(model.active).toEqual([]);
  expect(model.showLineage).toBe(false);
});

test("context transfers add related threads without duplicating stronger relationships", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true,
    threads: [{ id: "fork", title: "Fork", lineage: { rootThreadId: "me", parentThreadId: "me", relationshipToParent: "fork", sideChat: false }, createdAt: 20 }],
    resolvedTitles: new Map([["other", "Transferred thread"]]),
    transfers: [
      { sourceThreadId: "me", targetThreadId: "fork", status: "consumed" },
      { sourceThreadId: "other", targetThreadId: "me", status: "consumed" },
      { sourceThreadId: "me", targetThreadId: "me", status: "consumed" },
      { sourceThreadId: "else", targetThreadId: "elsewhere", status: "consumed" },
    ] });
  expect(model.related.map((row) => [row.threadId, row.kind, row.status])).toEqual([
    ["fork", "fork", null], ["other", "transfer", "consumed"],
  ]);
});

test("rolled-back subagents are counted among previous agents", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [],
    subagents: [{ id: "a", childThreadId: "child", title: "Agent", status: "rolled_back", startedAt: 1, completedAt: 2, providerInstanceId: null }] });
  expect(model.active).toEqual([]);
  expect(model.previous.map((row) => [row.threadId, row.status])).toEqual([["child", "interrupted"]]);
});

test("running agents whose shells are missing are ordered by thread id", () => {
  const subagents = [
    { id: "a", childThreadId: "branch", title: "Branch Inventory", status: "running", startedAt: 100, completedAt: null, providerInstanceId: null },
    { id: "b", childThreadId: "merge", title: "Merge Inventory", status: "running", startedAt: 200, completedAt: null, providerInstanceId: null },
    { id: "c", childThreadId: "presence", title: "Presence Reconcile", status: "running", startedAt: 300, completedAt: null, providerInstanceId: null },
  ];
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [], subagents });
  expect(model.active.map((row) => row.threadId)).toEqual(["branch", "merge", "presence"]);
});

test("the merge target precedes other children regardless of creation time", () => {
  const model = lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true,
    mergeTargetThreadId: "older", threads: [agent("newer", "running", 20), agent("older", "running", 10)] });
  expect(model.active.map((row) => row.threadId)).toEqual(["older", "newer"]);
});

test("side chats show their own section only when asked for, and detach alone shows Lineage for a side-chat-only thread", () => {
  const chat: LineageThread = { id: "chat", title: "Chat", status: "idle", lineage: { parentThreadId: "me", relationshipToParent: null, rootThreadId: "me", sideChat: true } };
  expect(lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: false, threads: [chat] }).showSideChats).toBe(false);
  expect(lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [chat] }).showLineage).toBe(false);
  expect(lineageModel({ current: { id: "me" }, showLineage: true, showSideChats: true, threads: [chat], canDetach: true }).showLineage).toBe(true);
});

test("status labels, compact elapsed time and titles follow the web", () => {
  expect(relationshipStatusLabel("completed")).toBe("Done");
  expect(relationshipStatusLabel(null)).toBe("Unknown");
  expect(formatCompactElapsed(42)).toBe("42s");
  expect(formatCompactElapsed(240)).toBe("4m");
  expect(formatCompactElapsed(5400)).toBe("1.5h");
  expect(agentElapsedLabel({ status: "running", startedAt: 0, completedAt: null }, 240_000)).toBe("4m");
  expect(agentElapsedLabel({ status: "completed", startedAt: 0, completedAt: 61_000 }, 999_999)).toBe("1m");
  expect(agentElapsedLabel({ status: "completed", startedAt: 0, completedAt: null }, 5)).toBeNull();
  expect(formatSubagentDisplayTitle("Subagent: Fix it")).toBe("Fix it");
});

test("a session that is attached and not stopped can be disconnected", () => {
  expect(projectionCanDetach({ providerSessions: [{ id: "s", status: "running" }], runs: [], providerThreads: [] })).toBe(true);
  expect(projectionCanDetach({ providerSessions: [{ id: "s", status: "stopped" }], runs: [], providerThreads: [] })).toBe(false);
  expect(projectionCanDetach({ providerSessions: [] })).toBe(false);
  expect(projectionCanDetach(null)).toBe(false);
});

test("a thread delegated from a linked environment shows Lineage and its heading on that row alone", async () => {
  const { lineageModel } = await import("./lineageLogic");
  const base = { current: { id: "t" }, threads: [], showLineage: true, showSideChats: true };
  expect(lineageModel(base).showLineage).toBe(false);
  const delegated = lineageModel({ ...base, delegatedFrom: true });
  expect(delegated.showLineage).toBe(true);
  expect(delegated.showLineageHeading).toBe(true);
  expect(lineageModel({ ...base, delegatedFrom: true, showLineage: false }).showLineage).toBe(false);
});

test("a failed relationship action toasts its title alone", () => {
  expect(relationshipFailureToast("Could not stop workflow")).toEqual({ type: "error", title: "Could not stop workflow" });
});
