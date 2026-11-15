import { mount, signal, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import { mergeTimeline } from "../timeline";

const expanded = signal<Record<string, boolean>>({});
const findId = signal<string | null>(null);
const entries = mergeTimeline(
  [
    { id: "u1", role: "user", body: "Fix the bug", order: 1000 },
    { id: "a1", role: "assistant", body: "All fixed.", order: 14_000 },
  ],
  [
    { id: "c1", type: "command_execution", title: "Command", detail: "npm test\n\nok", status: "completed", order: 3000 },
    { id: "c2", type: "command_execution", title: "Command", detail: "ls", status: "completed", order: 9000 },
  ],
);

function Fixture() {
  return (
    <View class="h-[500px] w-[900px]">
      <ThreadTimeline
        entries={() => entries}
        scope={() => ({ environment: "e", generation: 1, threadId: "t" })}
        expandedActivity={expanded}
        onToggleActivity={(id) => expanded.update((current) => ({ ...current, [id]: !current[id] }))}
        onOpenAttachment={() => undefined}
        findRowId={findId}
      />
      <View testID="find-hidden" onPress={() => findId.set("work:c1")} class="size-4" />
    </View>
  );
}

mount(Fixture);
