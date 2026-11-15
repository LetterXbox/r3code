import { mount, signal, Text, View } from "nsh";
import { ProposedPlanCard, SystemDivider, ThreadErrorBanner, WorkGroupRow, WorkingRow } from "./TimelineRows";
import type { WorkItem } from "./workLog";

const expanded = signal<Record<string, boolean>>({});
const dismissed = signal(false);
const items: WorkItem[] = [
  { id: "c1", type: "command_execution", title: "Command", detail: "npm test\n\nAll tests passed", status: "completed", order: Date.now() - 3_600_000 },
  { id: "f1", type: "file_change", title: "File change", detail: "src/a.ts\n\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+more", status: "completed" },
];
const plan: WorkItem = { id: "p1", type: "proposed_plan", title: "Plan", detail: "# Ship it\n\nStep one", status: "completed" };
const toggle = (id: string) => expanded.update((current) => ({ ...current, [id]: !current[id] }));

function Fixture() {
  return (
    <View>
      <WorkGroupRow id="work:c1" items={() => items} active={() => false} expandedActivity={expanded} onToggle={toggle} />
      <WorkingRow since={() => Date.now() - 65_000} />
      <SystemDivider label="Context compacted" detail="saved 12k tokens" />
      <ProposedPlanCard item={() => plan} />
      <ThreadErrorBanner error={() => (dismissed() ? null : '{"error":{"message":"Rate limited"}}')} onDismiss={() => dismissed.set(true)} />
      {dismissed() ? <Text>Banner dismissed</Text> : null}
    </View>
  );
}

mount(Fixture);
