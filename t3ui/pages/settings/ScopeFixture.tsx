import { mount, signal, Text, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest } from "../../store";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { savedEnvironments } from "./environments/savedEnvironments";
import { replaceServerSettings } from "./settingsState";
import { setSettingsWriteAccessForTest } from "./settingsWriteAccess";
import { ToastHost } from "../../components/toast";

const iso = new Date().toISOString();
const calls = signal<string[]>([]);
const settings: Record<string, unknown> = {
  newWorktreesStartFromOrigin: false,
  defaultAutoPull: false,
  storageCleanup: { worktreeKeepWhen: "uncommitted-changes", worktreeAfterDays: null, worktreeSettledAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: false, worktreeUnchanged: false },
  projectSettingsOverrides: { "project:1": { newWorktreesStartFromOrigin: true } },
};

applyConfigEventForTest({ type: "snapshot", config: { environment: { environmentId: "environment-live", label: "legion" }, settings, providers: [] } });
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
savedEnvironments.set([{ id: "s1", label: "Build box", url: "wss://build.example/ws", enabled: true, addedAt: 1 }]);

mount(() => (
  <View class="flex-1">
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <View accessibilityLabel="Deny writes" onPress={() => setSettingsWriteAccessForTest("denied")}><Text>Deny writes</Text></View>
    <SettingsPanel path="/settings/worktrees" />
    <ToastHost />
  </View>
));
