import { mount, signal, Text, View } from "nsh";
import { HtmlRenderFrame } from "./HtmlRender";
import { buildTimelineRows } from "./workLog";
import { activityFromTurnItem } from "./ingestActivity";
import type { TimelineEntry } from "../timeline";

// A completed html_render dynamic_tool turn item, its output the MCP envelope the server records.
export const htmlRenderItem = {
  id: "tool-1", threadId: "t1", runId: "run-1", ordinal: 2, status: "completed", type: "dynamic_tool", title: null, updatedAt: "2026-01-01T00:00:00Z",
  toolName: "mcp__t3-code__html_render", input: { title: "Chart" },
  output: { content: [{ type: "text", text: JSON.stringify({ htmlRender: { attachmentId: "att-1", title: "Sales chart", height: 320 } }) }] },
};
const entries = [{ kind: "activity", id: "tool-1", activity: activityFromTurnItem(htmlRenderItem, 1)! }] as unknown as TimelineEntry[];
const row = buildTimelineRows(entries, false)[0] as { kind: string; htmlRender?: { attachmentId: string; title: string; height: number } };
const calls = signal<string[]>([]);
// The timeline rebuilds rows on every event: the reference is a new object with the same attachment each time.
const reference = signal(row.htmlRender!);
const request = (method: string, payload: unknown) => {
  calls.update((all) => [...all, `${method} ${JSON.stringify(payload)}`]);
  return Promise.resolve({ relativeUrl: "/api/assets/att-1?sig=x", expiresAt: Date.now() + 3_600_000 });
};

mount(() => (
  <View class="w-[800px] gap-4">
    <Text>{`row ${row.kind}`}</Text>
    <View accessibilityLabel="Rebuild rows" onPress={() => reference.set({ ...reference() })}><Text>rebuild</Text></View>
    <View accessibilityLabel="inline frame"><HtmlRenderFrame reference={reference} request={request} endpoint="http://127.0.0.1:1" inline={() => true} /></View>
    <View accessibilityLabel="card frame"><HtmlRenderFrame reference={() => row.htmlRender!} request={request} endpoint="http://127.0.0.1:1" inline={() => false} /></View>
    <Text>{`calls ${calls().length} ${calls()[0] ?? ""}`}</Text>
  </View>
));
