import { mount, signal, Text, View } from "nsh";
import { diffSelectionFor } from "../../diff/diffPanelStore";
import { WorkGroupRow } from "./TimelineRows";
import { activityFromTurnItem } from "./ingestActivity";
import type { WorkItem } from "./workLog";

// Contract-shaped turn items (orchestrationV2.ts OrchestrationV2TurnItem) for each inspector kind.
const base = (id: string, type: string, extra: Record<string, unknown>) => ({
  id, threadId: "t1", runId: "r1", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 1, status: "completed", title: null, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", updatedAt: "2026-01-01T00:00:01Z", type, ...extra,
});
const wire = [
  base("cmd", "command_execution", { input: "npm test", output: "1 failing", exitCode: 2 }),
  base("edit", "file_change", { fileName: "/work/space/src/a.ts", additions: 3, deletions: 1, changes: [{ operation: "rename", oldPath: "src/old.ts", path: "/work/space/src/a.ts", fileType: "text", mimeType: "text/typescript" }] }),
  base("find", "file_search", { pattern: "TODO", results: [{ fileName: "/work/space/src/b.ts", line: 4, column: 7, preview: "// TODO: ship" }] }),
  base("web", "web_search", { patterns: ["gpui docs"], results: [{ title: "GPUI", url: "https://gpui.rs", snippet: "A fast UI framework" }] }),
  base("tool", "dynamic_tool", { toolName: "lookup", input: { query: "gpui", limit: 3 }, output: { content: [{ type: "text", text: "{\"ok\":true}" }] } }),
  base("todo", "todo_list", { planId: "p1", steps: [{ text: "Read", status: "completed" }, { text: "Write", status: "running" }, { text: "Ship", status: "pending" }] }),
];
const items: WorkItem[] = wire.map((item, index) => activityFromTurnItem(item, index + 1) as WorkItem);
const expanded = signal<Record<string, boolean>>({});

function Fixture() {
  return (
    <View>
      <Text>{`diff ${JSON.stringify(diffSelectionFor("t1"))}`}</Text>
      <WorkGroupRow id="work:all" items={() => items} active={() => false} expandedActivity={expanded} onToggle={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))} />
    </View>
  );
}

mount(Fixture);
