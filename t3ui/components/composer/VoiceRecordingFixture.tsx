// The real Composer with dictation forced into its recording phase and a live transcript ("Hello"), so the recording
// footer can be compared with the reference on screen without a microphone (workspace/visual/voicepill).
import { mount, View } from "nsh";
import { Composer } from "../Composer";
import { applyConfigEventForTest, applyShellEventForTest, createThread } from "../../store";
import { installKeybindings } from "../../commands/registry";
import { setDictationFactoryForTest } from "./dictation";
import { forcedRecordingDictation } from "./forcedRecording";

setDictationFactoryForTest(() => forcedRecordingDictation());

applyConfigEventForTest({ type: "snapshot", config: { providers: [{
  instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, installed: true, status: "ready", availability: "available",
  models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false }], slashCommands: [], skills: [],
}] } });
applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] },
});
createThread("project-1");
installKeybindings();

mount(() => <View class="flex-1 justify-end bg-background p-6"><View class="w-[704px] self-center"><Composer /></View></View>);
