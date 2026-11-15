import { mount, signal, Text, View } from "nsh";
import { ThreadTimeline } from "../../../pages/ThreadView";
import { mergeTimeline } from "../timeline";
import type { Message } from "../../../store";

const messages: Message[] = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, role: index % 2 === 0 ? "user" : "assistant", body: `message ${index}`, order: 1000 + index * 10 }) as Message);
const expanded = signal<Record<string, boolean>>({});

function Fixture() {
  return (
    <View class="h-[500px] w-[700px]">
      <ThreadTimeline
        entries={() => mergeTimeline(messages, [])}
        scope={() => ({ environment: "e", generation: 1, threadId: "t" })}
        expandedActivity={expanded}
        onToggleActivity={() => undefined}
        onOpenAttachment={() => undefined}
        working={() => ({ running: false, startedAt: null })}
        footer={() => <Text>queued footer item</Text>}
      />
    </View>
  );
}

mount(Fixture);
