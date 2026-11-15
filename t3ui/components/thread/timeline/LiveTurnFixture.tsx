import { mount, signal, Text, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import { mergeTimeline } from "../timeline";
import type { ActivityItem, Message } from "../../../store";

// The owner's screenshot: a running turn with one reasoning item and one running command.
const user: Message = { id: "u1", role: "user", body: "is the server current?", order: 1000 };
const thought = "I'm checking whether we're running the current server code: the frozen copy at commit bbdc7dca3, with its dist copied at 18:13, against T3code's dist, looking for any change to it since, via the commit or the dist mtime.";
const reasoning: ActivityItem = { id: "r1", type: "reasoning", title: "Reasoning", detail: thought, status: "running", order: 1100 };
const command: ActivityItem = { id: "c1", type: "command_execution", title: "Command", detail: "/bin/zsh -lc 'cat /tmp/dist-info.json'", status: "running", order: 1200 };

const activity = signal<ActivityItem[]>([reasoning, command]);
const running = signal(true);
const tops = signal<Record<string, number>>({});
const expanded = signal<Record<string, boolean>>({});
const entries = () => mergeTimeline([user], activity());
const scope = () => ({ environment: "e", generation: 1, threadId: "t" });

function Fixture() {
  return (
    <View class="h-[600px] w-[900px]">
      <View class="h-6" onPress={() => { activity.set([{ ...reasoning, status: "completed" }, { ...command, status: "completed" }]); running.set(false); }} accessibilityLabel="Finish turn" role="button" />
      <ThreadTimeline entries={entries} scope={scope} expandedActivity={expanded} onToggleActivity={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))} onOpenAttachment={() => undefined} onRowLayout={(id, top) => tops.update((current) => ({ ...current, [id]: top }))} working={() => ({ running: running(), startedAt: Date.now() - 19000 })} />
      <Text>{`order: ${Object.entries(tops()).sort((a, b) => a[1] - b[1]).map(([id]) => id).join(" > ")}`}</Text>
    </View>
  );
}

mount(Fixture);
