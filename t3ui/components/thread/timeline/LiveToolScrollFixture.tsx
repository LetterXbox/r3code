import { mount, signal, Text, View } from "nsh";
import { LiveWorkRow } from "./TimelineRows";
import type { WorkItem } from "./workLog";
const items: WorkItem[] = Array.from({ length: 80 }, (_, index) => ({ id: `tool-${index}`, type: "command_execution", title: "Command", detail: `echo Tool ${index}`, status: index === 79 ? "running" : "completed" }));
const expanded = signal<Record<string, boolean>>({ group: true });
mount(() => <View class="h-[700px] w-[900px]">
  <LiveWorkRow row={() => ({ kind: "live", id: "live", groupId: "group", items, entry: items[79]!, thought: null, active: true })} expandedActivity={expanded} onToggle={(id) => expanded.set({ ...expanded(), [id]: !expanded()[id] })} />
  <Text>After the capped tool list</Text>
</View>);
