import { mount, signal, View } from "nsh";
import { WorkEntryRow } from "./TimelineRows";
import { activityFromTurnItem } from "./ingestActivity";
import { setItemDetailRequest } from "./itemDetail";
import type { WorkItem } from "./workLog";

const wire = { id: "tool-summary", threadId: "thread-1", type: "dynamic_tool", status: "completed", title: "Inspect", toolName: "inspect", updatedAt: "now", input: { truncated: true, summary: "Partial" }, output: null };
const item = activityFromTurnItem(wire, 1) as WorkItem;
setItemDetailRequest(async () => ({ item: { ...wire, input: { request: "The complete tool input is available" } } }));
const expanded = signal(false);
mount(() => <View><WorkEntryRow item={() => item} expanded={() => expanded()} onToggle={() => expanded.set(!expanded())} /></View>);
