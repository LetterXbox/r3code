import { mount, signal, Text, View } from "nsh";
import { resolveWorkflowOpening, WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { readProjectedAgents } from "../../header/workflowModel";
import { loadShikiLanguage } from "../markdown/shikiHighlight";

// The script block's Shiki grammar compiles on a timer after mount (blocking): warm it up front so presses land.
loadShikiLanguage("javascript");

// The parent thread's projection (orchestration.getThreadProjection): the coordinator subagent with its workflow.
export const parentProjection = {
  subagents: [{
    id: "sub-1", threadId: "parent", runId: "run-1", origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent",
    childThreadId: "coordinator", title: "Audit the repo", status: "running", startedAt: "2026-01-01T00:00:00Z", completedAt: null,
    workflow: {
      name: "Repo audit", phases: [{ index: 0, title: "Scan" }],
      agents: [
        { index: 0, label: "Scan src", state: "completed", childThreadId: "member-a", phaseIndex: 0, startedAt: 1000, completedAt: 61000, result: "Found `3` issues" },
        { index: 1, label: "Scan tests", state: "running", childThreadId: null, phaseIndex: 0, startedAt: 1000 },
      ],
    },
  }],
};
export const script = "export const meta = { name: \"audit\" }\n" + Array.from({ length: 12 }, (_, i) => `step(${i})`).join("\n");

const opening = resolveWorkflowOpening({
  threadId: "coordinator", providerNativeSubagent: true,
  messages: [{ id: "m1", role: "user", text: script }], parentAgents: readProjectedAgents(parentProjection),
})!;
const opened = signal("none");

mount(() => (
  <View class="w-[700px]">
    <WorkflowOpeningBlock opening={() => opening} onOpenThread={(id) => opened.set(id)} now={() => 121000} />
    <Text>{`opened ${opened()}`}</Text>
  </View>
));
