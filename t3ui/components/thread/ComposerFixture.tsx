import { mount, Text, View } from "nsh";
import { Composer, composerCardSize } from "../Composer";
import { applyShellEventForTest, composerDraft, createThread, openThread, updateSetting } from "../../store";
import { queuePendingFileDrop } from "../sidebar/pendingFileDrop";
import { installKeybindings } from "../../commands/registry";

applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] },
});
createThread("project-1");
installKeybindings();

function Fixture() {
  return (
    <View class="flex-1">
      <Composer />
      <Text>{`height:${composerCardSize().height}`}</Text>
      <Text>{`draft:${JSON.stringify(composerDraft())}`}</Text>
      <View accessibilityLabel="Drop files on thread" onPress={() => queuePendingFileDrop(openThread()?.id ?? "", ["file:///tmp/dropped.txt"])}>
        <Text>Drop files on thread</Text>
      </View>
      <View accessibilityLabel="Use Enter" onPress={() => updateSetting("sendShortcut", "enter")}>
        <Text>Use Enter</Text>
      </View>
      <View accessibilityLabel="Use modified Enter" onPress={() => updateSetting("sendShortcut", "mod-enter")}>
        <Text>Use modified Enter</Text>
      </View>
      <View accessibilityLabel="Use modified Enter for multiline" onPress={() => updateSetting("sendShortcut", "mod-enter-multiline")}>
        <Text>Use modified Enter for multiline</Text>
      </View>
    </View>
  );
}

mount(Fixture);
