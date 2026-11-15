import { mount, signal, Text, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest, setRequestBackendForTest } from "../../store";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { replaceServerSettings } from "./settingsState";

const iso = new Date().toISOString();
const calls = signal<string[]>([]);
const settings: Record<string, unknown> = {
  defaultRuntimeMode: "full-access",
  defaultModelSelection: null,
  fallbackModelSelection: null,
  projectSettingsOverrides: { "project:1": { defaultRuntimeMode: "approval-required" } },
};

applyConfigEventForTest({ type: "snapshot", config: { environment: { environmentId: "environment-live", label: "legion", capabilities: { projectOrganization: true } }, settings, providers: [
  { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", availability: "available", auth: { status: "authenticated" }, models: [{ slug: "gpt-6-sol", name: "GPT-6 Sol", isCustom: false, capabilities: { optionDescriptors: [] } }], slashCommands: [], skills: [] },
] } });
applyShellEventForTest({ kind: "snapshot", snapshot: {
  projects: [
    { id: "project:1", title: "legion", workspaceRoot: "/work/legion", pinnedAt: null, createdAt: iso, updatedAt: iso },
    { id: "project:2", title: "other", workspaceRoot: "/work/other", pinnedAt: null, createdAt: iso, updatedAt: iso },
  ],
  threads: [],
} });
setBackendStatusForTest("connected");
configureSettingsSync({
  connected: () => true,
  request: (method, payload) => {
    calls.update((items) => [...items, `${method} ${JSON.stringify(payload)}`]);
    if (method === "server.updateSettings") {
      const patch = (payload as { patch: Record<string, unknown> }).patch;
      const overrides = { ...(settings.projectSettingsOverrides as Record<string, unknown>) };
      for (const [id, entry] of Object.entries((patch.projectSettingsOverrides ?? {}) as Record<string, unknown>)) { if (entry === null) delete overrides[id]; else overrides[id] = entry; }
      Object.assign(settings, patch, { projectSettingsOverrides: overrides });
      return Promise.resolve({ ...settings });
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  },
});
replaceServerSettings(settings);
import { setSettingsWriteAccessForTest } from "./settingsWriteAccess";
setRequestBackendForTest((method, payload) => { calls.update((items) => [...items, `${method} ${JSON.stringify(payload).replace(/"commandId":"[^"]*",/, "")}`]); return Promise.resolve({}); });

mount(() => (
  <View class="flex-1">
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <View accessibilityLabel="Deny writes" onPress={() => setSettingsWriteAccessForTest("denied")}><Text>Deny writes</Text></View>
    <SettingsPanel path="/settings/projects" />
  </View>
));
