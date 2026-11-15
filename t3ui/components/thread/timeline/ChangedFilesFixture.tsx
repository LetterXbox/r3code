import { mount, signal, Text, View } from "nsh";
import { ChangedFilesCard, checkpointSummary } from "./ChangedFilesCard";
import { activityFromTurnItem } from "./ingestActivity";
import { buildTimelineRows } from "./workLog";
import type { TimelineEntry } from "../timeline";

// A run's checkpoint turn item (orchestrationV2.ts, type "checkpoint") as the server sends it.
const checkpoint = {
  id: "cp-1", threadId: "t1", runId: "run-1", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 3, status: "completed", title: null, startedAt: null, completedAt: null, updatedAt: "2026-01-01T00:00:00Z",
  type: "checkpoint", checkpointId: "c1", scopeId: "s1",
  files: [{ path: "src/lib/a.ts", kind: "modified", additions: 4, deletions: 1 }, { path: "README.md", kind: "modified", additions: 2, deletions: 0 }],
  filesTotal: { count: 3, additions: 9, deletions: 1 },
};
const entries = [{ kind: "activity", id: "cp-1", activity: activityFromTurnItem(checkpoint, 1)! }] as unknown as TimelineEntry[];
const row = buildTimelineRows(entries, false)[0] as { kind: string; id: string; item: { item?: never } };

const opened = signal("none");
const extraDirectory = signal(false);

function Fixture() {
  return (
    <View>
      <View accessibilityLabel={`row:${row.kind}`} class="size-4" />
      <ChangedFilesCard id={row.id} summary={() => {
        const summary = checkpointSummary(row.item.item)!;
        return extraDirectory() ? { ...summary, files: [...summary.files, { path: "other/new.ts", previousPath: null, additions: 1, deletions: 0 }] } : summary;
      }} onOpenTurnDiff={(runId, filePath) => opened.set(`${runId}:${filePath ?? ""}`)} onFileContextMenu={(filePath) => opened.set(`menu:${filePath}`)} />
      <View role="button" accessibilityLabel="Add directory" onPress={() => extraDirectory.set(true)}><Text>Add directory</Text></View>
      <Text>{`opened ${opened()}`}</Text>
    </View>
  );
}

mount(Fixture);
