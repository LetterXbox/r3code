import { mount, signal, Text, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import type { TimelineEntry } from "../timeline";

const message = (index: number): TimelineEntry => ({
  kind: "message", id: `message:m${index}`, order: index + 1, sequence: index,
  message: { id: `m${index}`, role: index % 2 ? "assistant" : "user", body: `Message number ${index}`, order: index + 1 },
});
const entries = signal<TimelineEntry[]>(Array.from({ length: 60 }, (_, index) => message(index)));
const expanded = signal<Record<string, boolean>>({});
const scope = () => ({ environment: "e", generation: 1, threadId: "t" });

function Fixture() {
  return (
    <View class="h-[500px] w-[900px]">
      <ThreadTimeline
        entries={entries}
        scope={scope}
        expandedActivity={expanded}
        onToggleActivity={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))}
        onOpenAttachment={() => undefined}
        scrollSummary={() => "Subagent waiting \u00b7 2 queued"}
      />
      <View class="h-12 shrink-0" onPress={() => entries.update((all) => [...all, message(all.length)])} accessibilityLabel="Append reply" role="button">
        <Text>Composer</Text>
      </View>
    </View>
  );
}

mount(Fixture);
