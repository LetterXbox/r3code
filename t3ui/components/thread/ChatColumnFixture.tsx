import { mount, signal, Text, View } from "nsh";
import { Composer } from "../Composer";
import { ThreadTimeline } from "../../pages/ThreadView";
import { chatLaneInset } from "./chatLane";
import { ComposerLane } from "./ComposerLane";
import { mergeTimeline } from "./timeline";
import { applyShellEventForTest, createThread, updateSetting } from "../../store";
import { installKeybindings } from "../../commands/registry";

applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] },
});
createThread("project-1");
installKeybindings();

const entries = mergeTimeline([
  { id: "u1", role: "user", body: "hello", order: 1 },
  { id: "a1", role: "assistant", body: "Hi there", order: 2 },
], []);
const area = signal(0);
const rowWidth = signal("");
const composerWidth = signal("");
const composerBottom = signal("");
const scope = () => ({ environment: "e", generation: 1, threadId: "t" });

// The chat column of ThreadView at a 1229pt window with a 256pt sidebar (973pt of chat area).
function Fixture() {
  return (
    <View class="flex-1 flex-row">
      <View class="w-[256px]" />
      <View class="min-h-0 flex-1" onLayout={(event) => area.set(event.bounds.size.width)}>
        <ThreadTimeline
          entries={() => entries}
          scope={scope}
          expandedActivity={() => ({})}
          onToggleActivity={() => undefined}
          onOpenAttachment={() => undefined}
          laneInset={() => chatLaneInset(area())}
          onRowLayout={(id, _top, width) => { if (id.endsWith("u1")) rowWidth.set(`row ${Math.round(width ?? 0)}`); }}
        />
        <View onLayout={(event) => composerBottom.set(`composer bottom ${Math.round(event.bounds.origin.y + event.bounds.size.height)}`)}>
          <ComposerLane area={area} onLaneWidth={(width) => composerWidth.set(`composer ${Math.round(width)}`)}>
            <Composer />
          </ComposerLane>
        </View>
        <Text>{rowWidth()}</Text>
        <Text>{composerWidth()}</Text>
        <Text>{composerBottom()}</Text>
        <View accessibilityLabel="Use wide" onPress={() => updateSetting("chatWidth", "wide")}><Text>Use wide</Text></View>
        <View accessibilityLabel="Use full" onPress={() => updateSetting("chatWidth", "full")}><Text>Use full</Text></View>
      </View>
    </View>
  );
}

mount(Fixture);
