import { expect, test } from "nsh/test";
import {
  canStopSubagent, canStopWorkflow, deriveWorkflowGroups, mergeBack, mergeBackLabel, mergeBackTooltip, phaseCountLabel, phaseElapsed, phaseStatusLabel, readMergeBack, readProjectedAgents,
  stopSubagent, stopWorkflow,
} from "./workflowModel";

const t = (iso: string) => Date.parse(iso);
const projection = {
  subagents: [
    {
      id: "wf-1", threadId: "parent", runId: "run-1", origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent", childThreadId: "wf-thread", title: "Review", status: "running",
      startedAt: "2026-11-11T10:00:00.000Z", completedAt: null, nativeTaskRef: { strength: "strong", nativeId: "task-1" },
      workflow: {
        name: "Parallel review", phases: [{ index: 0, title: "Survey" }, { index: 1, title: "Fix" }],
        agents: [
          { index: 0, label: "Read the diff", state: "completed", phaseIndex: 0, startedAt: 1000, completedAt: 5000, childThreadId: "c0", result: "ok" },
          { index: 1, label: "Check tests", state: "running", phaseIndex: 0, startedAt: 2000 },
          { index: 2, label: "Apply fixes", state: "queued", phaseIndex: 1 },
          { index: 3, label: "Summarise", state: "failed", startedAt: 3000, durationMs: 500, result: "boom" },
        ],
      },
    },
    { id: "sub-1", threadId: "parent", runId: "run-1", origin: "app_owned", driver: "codex", providerInstanceId: "codex", childThreadId: "child-1", title: "Helper", status: "running", startedAt: "2026-11-11T10:01:00.000Z", completedAt: null, nativeTaskRef: null },
    { id: "bad" },
  ],
};

test("the projection's subagents read with their workflow, native task and times", () => {
  const agents = readProjectedAgents(projection);
  expect(agents.map((agent) => agent.id)).toEqual(["wf-1", "sub-1"]);
  expect(agents[0]).toMatchObject({ origin: "provider_native", driver: "claudeAgent", nativeTask: { strength: "strong", nativeId: "task-1" }, startedAt: t("2026-11-11T10:00:00.000Z") });
  expect(agents[0]!.workflow?.agents).toHaveLength(4);
  expect(agents[1]!.workflow).toBeNull();
});

test("a workflow groups its agents by phase, with the declared phase titles and an unphased tail", () => {
  const [group] = deriveWorkflowGroups(readProjectedAgents(projection));
  expect(group!.name).toBe("Parallel review");
  expect(group!.phases.map((phase) => [phase.title, phase.state, phase.settledCount, phaseCountLabel(phase)])).toEqual([
    ["Survey", "running", 1, "1/2 agents"],
    ["Fix", "running", 0, "0/1 agent"],
  ]);
  expect(group!.phases[0]!.members.map((member) => [member.title, member.status])).toEqual([["Read the diff", "completed"], ["Check tests", "running"]]);
  expect(group!.phases[1]!.members[0]!.status).toBe("pending");
  expect(group!.unphasedMembers.map((member) => [member.title, member.status, member.completedAt])).toEqual([["Summarise", "failed", 3500]]);
  expect(deriveWorkflowGroups(readProjectedAgents({ subagents: [projection.subagents[1]] }))).toEqual([]);
});

test("a finished coordinator settles its queued and running agents, and a phase reads done, failed or stopped", () => {
  const ended = { subagents: [{ ...projection.subagents[0]!, status: "cancelled", completedAt: "2026-11-11T10:05:00.000Z" }] };
  const [group] = deriveWorkflowGroups(readProjectedAgents(ended));
  expect(group!.phases[0]!.members.map((member) => member.status)).toEqual(["completed", "cancelled"]);
  expect(group!.phases.map(phaseStatusLabel)).toEqual(["stopped", "stopped"]);
  const [live] = deriveWorkflowGroups(readProjectedAgents(projection));
  expect(live!.phases.map(phaseStatusLabel)).toEqual(["running", "running"]);
  const done = { ...live!.phases[0]!, state: "done" as const, members: live!.phases[0]!.members.map((member) => ({ ...member, status: "completed" })) };
  expect(phaseStatusLabel(done)).toBe("done");
  expect(phaseStatusLabel({ ...done, members: done.members.map((member) => ({ ...member, status: "failed" })) })).toBe("failed");
  expect(phaseStatusLabel({ ...done, state: "pending", members: [] })).toBe("not started");
});

test("a phase's elapsed time runs from its first start to its last end, and only while running or once finished", () => {
  const [group] = deriveWorkflowGroups(readProjectedAgents(projection));
  expect(phaseElapsed(group!.phases[0]!)).toEqual({ status: "running", startedAt: 1000, completedAt: null });
  expect(phaseElapsed({ ...group!.phases[0]!, state: "done" })).toEqual({ status: "completed", startedAt: 1000, completedAt: 5000 });
  expect(phaseElapsed({ ...group!.phases[1]!, state: "pending", members: [] })).toEqual({ status: "completed", startedAt: null, completedAt: null });
});

test("Stop shows for live app-owned tasks and for Claude's strongly-referenced native ones, and workflows stop only when Claude's run", () => {
  const [workflow, helper] = readProjectedAgents(projection);
  expect(canStopSubagent(helper)).toBe(true);
  expect(canStopSubagent(workflow)).toBe(true);
  expect(canStopSubagent({ ...helper!, status: "completed" })).toBe(false);
  expect(canStopSubagent({ ...helper!, startedAt: null })).toBe(false);
  expect(canStopSubagent({ ...workflow!, nativeTask: { strength: "weak", nativeId: "x" } })).toBe(false);
  expect(canStopSubagent({ ...workflow!, driver: "codex" })).toBe(false);
  expect(canStopSubagent(undefined)).toBe(false);
  expect(canStopWorkflow(workflow, true)).toBe(true);
  expect(canStopWorkflow(workflow, false)).toBe(false);
  expect(canStopWorkflow({ ...workflow!, status: "completed" }, true)).toBe(false);
  expect(canStopWorkflow(helper, true)).toBe(false);
});

const fork = (overrides: Record<string, unknown> = {}) => ({
  thread: { lineage: { relationshipToParent: "fork", parentThreadId: "parent" }, forkedFrom: { type: "run", threadId: "source" }, ...overrides },
  runs: [{ id: "r1", ordinal: 1, status: "completed" }, { id: "r2", ordinal: 2, status: "waiting" }],
});

test("a fork merges back into the thread it forked from, from its latest finished run", () => {
  expect(readMergeBack(fork())).toEqual({ targetThreadId: "source", latestRunId: "r2" });
  expect(readMergeBack(fork({ forkedFrom: null }))).toEqual({ targetThreadId: "parent", latestRunId: "r2" });
  expect(readMergeBack({ ...fork(), runs: [{ id: "r1", ordinal: 1, status: "completed" }, { id: "r2", ordinal: 2, status: "running" }] })).toEqual({ targetThreadId: "source", latestRunId: null });
  expect(readMergeBack({ ...fork(), runs: [{ id: "r1", ordinal: 1, status: "failed" }] }).latestRunId).toBeNull();
  expect(readMergeBack({ thread: { lineage: { relationshipToParent: "subagent", parentThreadId: "p" } }, runs: [] })).toEqual({ targetThreadId: null, latestRunId: null });
  expect(readMergeBack(null)).toEqual({ targetThreadId: null, latestRunId: null });
});

test("the merge-back copy names the source or says to complete a run first", () => {
  expect(mergeBackLabel("Plan")).toBe("Merge back to Plan");
  expect(mergeBackLabel(null)).toBe("Merge back to source conversation");
  expect(mergeBackTooltip(null, "Plan")).toBe("Complete a run in this fork before merging it back");
  expect(mergeBackTooltip("r2", "Plan")).toBe("Merge this conversation back into Plan");
  expect(mergeBackTooltip("r2", null)).toBe("Merge this conversation back into its source");
});

test("merge back, stop subagent and stop workflow dispatch the contract's commands", async () => {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const request = async (method: string, payload: unknown) => { calls.push({ method, payload: payload as Record<string, unknown> }); return {}; };
  await mergeBack({ sourceThreadId: "fork", targetThreadId: "source", runId: "r2" }, request);
  expect(calls[0]!.payload).toMatchObject({ type: "thread.merge_back", sourceThreadId: "fork", targetThreadId: "source", sourcePoint: { type: "run", runId: "r2" }, createdBy: "user", creationSource: "web" });
  calls.length = 0;
  await stopSubagent({ id: "sub-1", threadId: "parent", runId: "run-1", origin: "app_owned", childThreadId: "child-1" }, request);
  expect(calls.map((call) => [call.payload.type, call.payload.threadId])).toEqual([["subagent.stop", "parent"], ["thread.stop", "child-1"]]);
  calls.length = 0;
  await stopSubagent({ id: "n-1", threadId: "parent", runId: "run-1", origin: "provider_native", childThreadId: null }, request);
  expect(calls.map((call) => [call.payload.type, call.payload.subagentId])).toEqual([["subagent.stop", "n-1"]]);
  calls.length = 0;
  await stopSubagent({ id: "n-2", threadId: "parent", runId: null, origin: "provider_native", childThreadId: null }, request);
  expect(calls).toEqual([]);
  await stopWorkflow({ threadId: "parent", subagentId: "wf-1" }, request);
  expect(calls[0]).toEqual({ method: "orchestration.stopWorkflow", payload: { threadId: "parent", subagentId: "wf-1" } });
});

test("a task delegated to a linked environment keeps its remote child", () => {
  const [agent] = readProjectedAgents({ subagents: [{ id: "n1", threadId: "t", status: "running", title: "Subagent: review", remoteChild: { environmentId: "env-b", threadId: "rt", label: "Build box", title: "review" } }] });
  expect(agent?.remoteChild).toEqual({ environmentId: "env-b", threadId: "rt", label: "Build box", title: "review" });
  expect(readProjectedAgents({ subagents: [{ id: "n2", status: "running" }] })[0]?.remoteChild).toBe(null);
});
