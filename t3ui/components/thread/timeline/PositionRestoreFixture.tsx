import { mount, signal, Text, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import type { TimelineEntry } from "../timeline";

const message = (thread: string, index: number): TimelineEntry => ({
  kind: "message", id: `message:${thread}${index}`, order: index + 1, sequence: index,
  message: { id: `${thread}${index}`, role: index % 2 ? "assistant" : "user", body: `Thread ${thread} line ${index}`, order: index + 1 },
});
const threads: Record<string, TimelineEntry[]> = {
  a: Array.from({ length: 60 }, (_, index) => message("a", index)),
  b: Array.from({ length: 60 }, (_, index) => message("b", index)),
};
const current = signal("a");
const extra = signal<TimelineEntry[]>([]);
const expanded = signal<Record<string, boolean>>({});

function Fixture() {
  return (
    <View class="h-[500px] w-[900px]">
      <ThreadTimeline
        entries={() => [...threads[current()], ...extra()]}
        scope={() => ({ environment: "e", generation: 1, threadId: current() })}
        expandedActivity={expanded}
        onToggleActivity={() => undefined}
        onOpenAttachment={() => undefined}
      />
      <View class="h-8 shrink-0" onPress={() => extra.update((list) => [...list, { kind: "message", id: "message:sent", order: 1000, sequence: 1000, message: { id: "sent", role: "user", body: "The message just sent", order: 1000, pending: true } }])} accessibilityLabel="Send" role="button"><Text>send</Text></View>
      <View class="h-8 shrink-0" onPress={() => extra.update((list) => [...list, { kind: "activity", id: "activity:tool", order: 1001, sequence: 1001, activity: { id: "tool", type: "command_execution", title: "Command", detail: "ls", status: "inProgress", order: 1001 } } as TimelineEntry])} accessibilityLabel="Tool" role="button"><Text>tool</Text></View>
      <View class="h-8 shrink-0" onPress={() => current.set("a")} accessibilityLabel="Open thread a" role="button"><Text>a</Text></View>
      <View class="h-8 shrink-0" onPress={() => current.set("b")} accessibilityLabel="Open thread b" role="button"><Text>b</Text></View>
    </View>
  );
}

mount(Fixture);
