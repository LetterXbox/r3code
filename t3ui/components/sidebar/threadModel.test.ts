// The hover card's model row, read from contract-shaped config and shell payloads.
import { expect, test } from "nsh/test";
import { allThreads, applyConfigEventForTest, applyShellEventForTest } from "../../store";
import { handedOffFrom, threadModelFact } from "./threadModel";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
applyConfigEventForTest({ type: "snapshot", config: { providers: [
  { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", models: [{ slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" }] },
  { instanceId: "codex", driver: "codex", displayName: "Codex", models: [] },
] } });
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [{ id: "p1", title: "legion", workspaceRoot: "/work/legion", pinnedAt: null, createdAt: iso(100), updatedAt: iso(30) }],
  threads: [{
    id: "t1", projectId: "p1", title: "Greeting", creationSource: "web", providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" }, providerInstanceHistory: ["codex", "claudeAgent"],
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t1" }, status: "completed",
    latestRunId: "run:t1", latestRunCompletedAt: iso(30), lastVisitedAt: iso(20), pendingBackgroundTasks: [], pinnedAt: null,
    settledOverride: null, snoozedUntil: null, createdAt: iso(90), updatedAt: iso(30), latestUserMessageAt: iso(31),
  }],
} });

test("the model row reads the trigger's short name from the provider snapshot", async () => {
  const thread = allThreads().find((item) => item.id === "t1")!;
  const fact = threadModelFact(thread);
  await expect(fact?.label).toBe("Haiku 5.5");
  await expect(fact?.providerName).toBe("Claude");
});

test("a thread handed off between providers names the ones it left", async () => {
  const thread = allThreads().find((item) => item.id === "t1")!;
  await expect(handedOffFrom(thread)).toEqual(["Codex"]);
});
