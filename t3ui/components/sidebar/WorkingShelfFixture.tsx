// The reference screenshot: a Working shelf holding two threads from different projects (one
// running, one waiting), a closed Settled shelf holding two. Built from shell records through the
// same functions the sidebar uses, so the labels, counts and card lines come from real fields.
import { mount, View } from "nsh";
import { SidebarThreadRow } from "../SidebarThreadRow";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { threadMetaFromShell } from "./threadMeta";
import { partitionActive } from "./workingShelf";
import type { Thread } from "../../store";

const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();

const shell = (id: string, projectId: string, title: string, patch: Record<string, unknown>): Thread => {
  const value = {
    id, projectId, title, status: "idle", branch: null, latestRunId: null, activeRunId: null, activeProviderThreadId: null,
    providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
    interactionMode: "default", hasActionableProposedPlan: false, pendingRuntimeRequest: null, ...patch,
  };
  return { id, projectId, title, status: value.status === "running" ? "running" : "idle", pinned: false, updatedAt: now, createdAt: now - 3_600_000, meta: threadMetaFromShell(value) };
};

export const threads: Thread[] = [
  shell("t3", "p-t3", "Match T3 Code Functionality And Design", {
    status: "running", latestRunId: "run-1", activeRunId: "run-1", activityRunStatus: "running",
    activityRunStartedAt: iso(6 * 60_000 + 5_000), providerInstanceId: "codex", providerInstanceHistory: ["claudeAgent"],
  }),
  shell("legion", "p-legion", "Agent Harness Reliability Review", {
    status: "completed", latestRunId: "run-9", latestRunCompletedAt: iso(24 * 60_000 + 5_000), branch: "legion-merge",
    pendingBackgroundTasks: [{ kind: "subagent", awaited: true }],
  }),
  shell("s1", "p-t3", "Old finished thread", { status: "completed", latestRunId: "run-3", settledOverride: "settled" }),
  shell("s2", "p-legion", "Another finished thread", { status: "completed", latestRunId: "run-4", settledOverride: "settled" }),
];
const names: Record<string, string> = { "p-t3": "t3codegpui", "p-legion": "jasonkneen/legion" };

function Fixture() {
  const active = threads.filter((thread) => !thread.meta?.settled);
  const { working } = partitionActive(active, true);
  const settled = threads.filter((thread) => thread.meta?.settled);
  return (
    <View class="w-[300px] gap-px bg-sidebar p-2">
      <SidebarSectionHeader label="Working" shelf="working" count={working.length} expanded={true} onToggle={() => {}} />
      {working.map((thread) => (
        <SidebarThreadRow thread={thread} variant="card" active={thread.id === "t3"} projectName={names[thread.projectId]} onPress={() => {}} />
      ))}
      <SidebarSectionHeader label="Settled" shelf="settled" count={settled.length} expanded={false} onToggle={() => {}} />
    </View>
  );
}

mount(Fixture);
