// The real Composer on a provider that offers the `council` skill (a contract-shaped config snapshot).
import { mount, Text, View } from "nsh";
import { Composer } from "../../Composer";
import { applyConfigEventForTest, applyShellEventForTest, composerDraft, createThread } from "../../../store";
import { installKeybindings, registerCommands } from "../../../commands/registry";
import { observeServerConfigEvent } from "../../../pages/settings/settingsState";
import { signal } from "nsh";

const ran = signal<string[]>([]);
registerCommands({ "sidebar.toggle": () => { ran.update((all) => [...all, "sidebar"]); } });

applyConfigEventForTest({ type: "snapshot", config: { providers: [{
  instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", availability: "available",
  models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isCustom: false }], slashCommands: [],
  skills: [{ name: "council", path: "/skills/council/SKILL.md", description: "Ask the council", enabled: true }],
}] } });
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
      <Text>{`draft:${JSON.stringify(composerDraft())}`}</Text>
      <Text>{`ran:${ran().join(",")}`}</Text>
      <View accessibilityLabel="Rebind sidebar" onPress={() => observeServerConfigEvent({ type: "keybindingsUpdated", payload: { keybindings: [{ command: "sidebar.toggle", shortcut: { key: "e", modKey: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: true } }] } })}><Text>Rebind sidebar</Text></View>
    </View>
  );
}
mount(Fixture);
