import { mount, signal, View } from "nsh";
import { WorkGroupRow } from "./TimelineRows";
import { setItemDetailRequest } from "./itemDetail";
import { activityFromTurnItem } from "./ingestActivity";
import type { WorkItem } from "./workLog";

// A command whose output the environment withheld (contract shape), and the getTurnItem result carrying it.
const wire = { id: "cmd-1", threadId: "t1", type: "command_execution", status: "completed", title: null, updatedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", completedAt: null, input: "make build", output: "", outputOmitted: true, exitCode: 0 };
const calls = signal<string[]>([]);
setItemDetailRequest(async (method, payload) => {
  calls.update((all) => [...all, `${method}:${JSON.stringify(payload)}`]);
  return { item: { ...wire, output: "built 12 files", outputOmitted: false } };
});
const items: WorkItem[] = [activityFromTurnItem(wire, 1) as WorkItem];
const expanded = signal<Record<string, boolean>>({});

function Fixture() {
  return (
    <View>
      <WorkGroupRow id="work:cmd-1" items={() => items} active={() => false} expandedActivity={expanded} onToggle={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))} />
      <View testID="calls" accessibilityLabel={calls().join("|")} class="size-4" />
    </View>
  );
}

mount(Fixture);
