import { mount, signal, Text, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import { mergeTimeline, type TimelineEntry } from "../timeline";

const message = (index: number): TimelineEntry => ({
  kind: "message", id: `message:m${index}`, order: index + 1, sequence: index,
  message: { id: `m${index}`, role: index % 2 ? "assistant" : "user", body: `Message number ${index}. ${"A longer conversation row. ".repeat(index % 7 + 1)}`, order: 1000 - index, ordinal: index + 1 },
});
const entries = signal<TimelineEntry[]>(Array.from({ length: 60 }, (_, index) => message(index)));
const ticks = signal(0);
const expanded = signal<Record<string, boolean>>({});

function Fixture() {
  return (
    <View class="h-full w-full flex-col">
      <View role="button" accessibilityLabel="Refresh conversation" class="h-12 shrink-0" onPress={() => {
        ticks.update((tick) => tick + 1);
        entries.update((all) => all.map((entry) => entry.kind === "message" ? { ...entry, message: { ...entry.message, ...(entry.message.id === "m59" ? { body: `Message number 59, update ${ticks()}` } : {}) } } : { ...entry }));
      }}><Text>{`Refresh conversation ${ticks()}`}</Text></View>
      <View role="button" accessibilityLabel="Stream message record" class="h-8 shrink-0" onPress={() => entries.update((all) => [...all, { kind: "message", id: "message:streaming", order: 2000, sequence: 60, message: { id: "streaming", role: "assistant", body: "New streamed response", order: 2000, streaming: true } }])}><Text>Stream message record</Text></View>
      <ThreadTimeline entries={() => mergeTimeline(entries().flatMap((entry) => entry.kind === "message" ? [entry.message] : []), [])} scope={() => ({ environment: "fixture", generation: 1, threadId: "fixture" })} expandedActivity={expanded} onToggleActivity={() => {}} onOpenAttachment={() => undefined} />
    </View>
  );
}

mount(Fixture);
