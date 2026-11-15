import { mount, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, updateSetting } from "../../store";
import { SidebarThreadRow } from "../SidebarThreadRow";
import { sidebarSections } from "./sidebarModel";

const PROJECT = "project:1";
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const shell = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, projectId: PROJECT, title, creationSource: "web", providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"],
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  status: "completed", latestRunId: `run:${id}`, latestRunCompletedAt: iso(30), lastVisitedAt: iso(20),
  pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null,
  createdAt: iso(90), updatedAt: iso(30), latestUserMessageAt: iso(31), ...over,
});
const lineage = (id: string, over: Record<string, unknown>) => ({ parentThreadId: "root", relationshipToParent: null, rootThreadId: "root", ...over, ...(id ? {} : {}) });

updateSetting("boringSidebarEnabled", false);
applyConfigEventForTest({ type: "snapshot", config: { providers: [
  { instanceId: "codex", driver: "codex", displayName: "Codex", models: [] },
  { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", models: [] },
] } });
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [{ id: PROJECT, title: "legion", workspaceRoot: "/work/legion", pinnedAt: null, createdAt: iso(100), updatedAt: iso(30) }],
  threads: [
    shell("root", "Root thread", { providerInstanceHistory: ["codex", "claudeAgent"], providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" } }),
    shell("fork", "Greeting fork", { lineage: lineage("fork", { relationshipToParent: "fork" }), forkedFrom: { type: "run", threadId: "root", runId: "run:root" }, latestRunCompletedAt: iso(2), lastVisitedAt: iso(10) }),
    shell("side", "Side chat", { lineage: { ...lineage("side", {}), sideChat: true } }),
    shell("delegated", "Delegated task", { lineage: lineage("delegated", { relationshipToParent: "subagent" }), delegatedFrom: { environmentId: "e", threadId: "x", title: "T" } }),
    shell("native", "Provider subagent", { creationSource: "provider", lineage: lineage("native", { relationshipToParent: "subagent" }) }),
  ],
} });

function Fixture() {
  const rows = () => sidebarSections(Date.now()).loose;
  return (
    <View class="w-[300px] gap-px bg-sidebar p-2">
      {rows().map((thread) => (
        <SidebarThreadRow thread={thread} variant="card" active={false} projectName="legion" onPress={() => {}} />
      ))}
    </View>
  );
}

mount(Fixture);
