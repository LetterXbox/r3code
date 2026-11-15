// The real Composer opened on a thread whose draft is already there (a restored draft): a list, a heading, a code block,
// a task. Every send path is counted, so a test can prove nothing sends without a key or a press.
import { mount, signal, Text, View } from "nsh";
import { Composer } from "../../Composer";
import { applyConfigEventForTest, applyShellEventForTest, composerDraft, createThread, setBackendStatusForTest, setComposerDraft, setRequestBackendForTest } from "../../../store";
import { installKeybindings } from "../../../commands/registry";
import { setDictationFactoryForTest } from "../dictation";
import { forcedRecordingDictation } from "../forcedRecording";

const RESTORED = "# Plan\n- first\n- second\n- [ ] task\n```ts\nconst a = 1\n```\nlast line";
// Held in recording, as the forced-recording check does: finishing or cancelling never sends (nothing auto-submits).
setDictationFactoryForTest(() => forcedRecordingDictation());
applyConfigEventForTest({ type: "snapshot", config: { providers: [{
  instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", availability: "available",
  models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isCustom: false }], slashCommands: [], skills: [],
}] } });
applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] } });
createThread("project-1");
setComposerDraft(RESTORED);
installKeybindings();
export const restoredDraft = RESTORED;
const renders = signal(0);
// Every request is answered here and every send counted: the count is what the test reads.
const sends = signal(0);
setRequestBackendForTest(async (method, payload) => {
  const type = (payload as { type?: string } | null)?.type;
  if (method === "orchestration.launchThread" || (method === "orchestration.dispatchCommand" && type === "message.dispatch")) sends.update((count) => count + 1);
  return {};
});
setBackendStatusForTest("connected");

mount(() => (
  <View class="flex-1">
    <Composer />
    <Text>{`draft:${JSON.stringify(composerDraft())}`}</Text>
    <Text>{`sends:${sends()}`}</Text>
    <View accessibilityLabel="Remount" onPress={() => renders.update((count) => count + 1)}><Text>{`renders:${renders()}`}</Text></View>
  </View>
));
