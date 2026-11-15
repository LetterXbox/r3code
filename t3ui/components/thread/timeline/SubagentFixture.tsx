import { mount, signal, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import { mergeTimeline } from "../timeline";
import { activityFromTurnItem } from "./ingestActivity";
import { overlaySubagent } from "./subagents";
import type { ActivityItem, Message } from "../../../store";

// Contract-shaped `subagent` turn items (OrchestrationV2TurnItem) and the thread's live `subagents` records.
const NOW = Date.now();
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const expanded = signal<Record<string, boolean>>({});
const base = { runId: "run-1", providerTurnId: "turn-1", threadId: "t", parentItemId: null, deferredWork: undefined };

function agent(n: number, title: string, status: string, startedAgo: number, endedAgo: number | null, progress: string | null, result: string | null) {
  return {
    ...base, id: `item-${n}`, ordinal: 10 + n, type: "subagent", subagentId: `agent-${n}`, origin: "provider_native", driver: "claudeAgent",
    providerInstanceId: "claudeAgent", childThreadId: `child-${n}`, prompt: "do it", title, status,
    startedAt: iso(startedAgo), completedAt: endedAgo === null ? null : iso(endedAgo), updatedAt: iso(0), progress: progress ?? undefined, result,
  };
}

const items: Record<string, unknown>[] = [
  agent(1, "Debug sidebar missing threads live", "completed", 72, 53, null, "I stopped before doing anything. Neither of the two files the task depends on exists: /private/tmp/claude-501/-Users-jk"),
  agent(2, "Chat column layout and header banners", "completed", 60, 48, null, "I could not start the work: the brief and both reference captures are missing."),
  agent(3, "Theme token audit for unknown classes", "completed", 58, 44, null, "I stopped before doing any of the audit work, because the brief doesn't exist."),
  agent(4, "Composer menus and remaining items", "completed", 55, 42, null, "I can't start: the brief you told me to read first doesn't exist."),
  agent(5, "Settings remaining panels and fidelity", "running", 15, null, "Running find /private/tmp /tmp /Users/jkneen/Documents/Gi", null),
  agent(6, "Live turn detail and per-tool rows", "running", 0, null, null, null),
];
const mcp = { ...base, id: "tool-1", ordinal: 5, type: "dynamic_tool", toolName: "mcp__kimi-cu__click", input: {}, status: "completed", title: null, startedAt: iso(80), completedAt: iso(79), updatedAt: iso(79), toolSource: { key: "mcp:kimi-cu", name: "kimi-cu", kind: "integration" } };

const records = signal<Record<string, Record<string, unknown>>>({});
const messages: Message[] = [{ id: "u1", role: "user", body: "Run ten agents", order: NOW - 90_000 }];
const entries = () => mergeTimeline(messages, [mcp, ...items].flatMap((item, index) => {
  const activity = activityFromTurnItem(item, NOW - 80_000 + index * 1000);
  if (activity?.subagent) activity.subagent = overlaySubagent(activity.subagent, records()[activity.subagent.subagentId]);
  return activity ? [activity as ActivityItem] : [];
}));
const finish = () => records.set({ "agent-5": { id: "agent-5", status: "completed", result: "Settings panels audited.", startedAt: iso(15), completedAt: iso(0) } });

function Fixture() {
  return (
    <View class="h-[800px] w-[900px]">
      <ThreadTimeline
        entries={entries}
        scope={() => ({ environment: "e", generation: 1, threadId: "t" })}
        working={() => ({ running: true, startedAt: NOW - 90_000 })}
        expandedActivity={expanded}
        onToggleActivity={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))}
        onOpenAttachment={() => undefined}
      />
      <View testID="finish" onPress={finish} class="size-4" />
    </View>
  );
}

mount(Fixture);
