import { mount, signal, View } from "nsh";
import { WorkEntryRow } from "./TimelineRows";
import { activityFromTurnItem } from "./ingestActivity";

const svg = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#3366ff"/></svg>');
const turnItem = (id: string, toolIcon: unknown) => ({
  id, threadId: "t1", runId: "r1", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 1,
  status: "completed", title: null, startedAt: "2026-01-01T00:00:00Z", completedAt: null, updatedAt: "2026-01-01T00:00:01Z", type: "dynamic_tool",
  toolName: "mcp__docs__search", input: { query: "x" }, toolIcon,
});
const withIcon = activityFromTurnItem(turnItem("with-icon", { _tag: "website", pageUrl: "https://docs.test/", faviconUrl: svg }), 1)!;
const without = activityFromTurnItem(turnItem("no-icon", undefined), 2)!;
const expanded = signal(false);

function Fixture() {
  return (
    <View class="w-[600px]">
      <WorkEntryRow item={() => withIcon} expanded={expanded} onToggle={() => undefined} />
      <WorkEntryRow item={() => without} expanded={expanded} onToggle={() => undefined} />
    </View>
  );
}

mount(Fixture);
