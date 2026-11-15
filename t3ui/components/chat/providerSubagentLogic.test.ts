import { expect, test } from "nsh/test";
import { formatProviderSubagentStatus, subagentStatusFor } from "./providerSubagentLogic";
import { threadRelationsFromShell } from "../header/threadRelations";

test("the status reads Starting, Working with a live clock, Completed in, and Interrupted", () => {
  const node = (status: string, end: number | null = null) => ({ kind: "root_turn", runId: null, status, startedAt: new Date(1_000).toISOString(), completedAt: end === null ? null : new Date(end).toISOString() });
  expect(formatProviderSubagentStatus(null, 0)).toBe("Starting");
  expect(formatProviderSubagentStatus(subagentStatusFor([node("running")]), 66_000)).toBe("Working 1m 5s");
  expect(formatProviderSubagentStatus(subagentStatusFor([node("completed", 12_000)]), 99_000)).toBe("Completed in 11s");
  expect(formatProviderSubagentStatus(subagentStatusFor([node("interrupted", 5_000)]), 9_000)).toBe("Interrupted");
  expect(formatProviderSubagentStatus(subagentStatusFor([node("waiting")]), 3_000)).toBe("Waiting 2s");
  expect(formatProviderSubagentStatus(subagentStatusFor([node("completed", 12_000), node("running")]), 66_000)).toBe("Working 1m 5s");
  expect(subagentStatusFor([{ kind: "root_turn", runId: "ordinary-run", status: "completed" }])).toBe(null);
});

test("only a subagent the provider created, which cannot take messages, carries the bar", () => {
  const shell = (creationSource: string, relationship: string) => ({
    id: "t", lineage: { parentThreadId: "p", relationshipToParent: relationship, sideChat: false },
    creationSource, modelSelection: { instanceId: "codex", model: "gpt-5", options: [{ id: "reasoningEffort", value: "high" }] },
  });
  expect(threadRelationsFromShell(shell("provider", "subagent"))?.providerSubagent).toEqual({ instanceId: "codex", model: "gpt-5", effort: "high" });
  expect(threadRelationsFromShell(shell("app", "subagent"))?.providerSubagent).toBeUndefined();
  expect(threadRelationsFromShell(shell("provider", "fork"))?.providerSubagent).toBeUndefined();
});

test("the subagent bar badges its provider mark when the instance has an accent or shares its driver (shouldShowInstanceBadge)", async () => {
  const { subagentInstanceBadge } = await import("./ProviderSubagentBar");
  const codex = { driver: "codex", accentColor: null };
  expect(subagentInstanceBadge(codex, [codex])).toBe(false);
  expect(subagentInstanceBadge(codex, [codex, { driver: "codex" }])).toBe(true);
  expect(subagentInstanceBadge({ driver: "claudeAgent", accentColor: "#f00" }, [codex])).toBe(true);
  expect(subagentInstanceBadge(undefined, [codex])).toBe(false);
});
