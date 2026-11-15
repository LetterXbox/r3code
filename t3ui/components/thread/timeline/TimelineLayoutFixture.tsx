import { mount, signal, Text, View } from "nsh";
import type { Message } from "../../../store";
import { ThreadTimeline } from "../../../pages/ThreadView";
import type { TimelineEntry } from "../timeline";
import { MessageRow } from "../MessageRow";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { WorkingRow } from "./TimelineRows";

const size = signal("");
const footer = signal("");
const bubble = signal("");
const markdown = signal("");
const user: Message = { id: "u1", role: "user", body: "hello", order: 1 };
const many: TimelineEntry[] = Array.from({ length: 60 }, (_, index) => ({
  kind: "message" as const, id: `message:m${index}`, order: index + 1, sequence: index,
  message: { id: `m${index}`, role: index % 2 ? ("assistant" as const) : ("user" as const), body: `Message number ${index}`, order: index + 1 },
}));
const scope = () => ({ environment: "e", generation: 1, threadId: "t" });

function Fixture() {
  return (
    <View class="w-[1280px] flex-1 flex-row">
      <View class="min-h-0 w-[900px] flex-1">
        <ThreadTimeline entries={() => many} scope={scope} expandedActivity={() => ({})} onToggleActivity={() => undefined} onOpenAttachment={() => undefined} />
        <View class="shrink-0 pb-3" onLayout={(event) => footer.set(`footer bottom ${Math.round(event.bounds.origin.y + event.bounds.size.height)}`)}>
          <View class="h-24" />
          <Text>Local checkout</Text>
        </View>
      </View>
      <View class="w-[360px]">
        <View onLayout={(event) => bubble.set(`bubble ${Math.round(event.bounds.size.width)}x${Math.round(event.bounds.size.height)}`)} class="self-start">
          <MessageRow message={() => user} />
        </View>
        <WorkingRow since={() => Date.now() - 4000} />
        <View onLayout={(event) => size.set(`row ${Math.round(event.bounds.size.height)}`)}><Text>x</Text></View>
        <View class="self-start" onLayout={(event) => markdown.set(`markdown ${Math.round(event.bounds.size.height)}`)}><ChatMarkdown text={() => "hello"} /></View>
        <Text>{markdown()}</Text>
        <Text>{bubble()}</Text>
        <Text>{footer()}</Text>
        <Text>{size()}</Text>
      </View>
    </View>
  );
}

mount(Fixture);
