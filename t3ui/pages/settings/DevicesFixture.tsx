import { mount, signal, Text, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest } from "../../store";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { replaceServerSettings } from "./settingsState";

const iso = new Date().toISOString();
const calls = signal<string[]>([]);
const settings: Record<string, unknown> = {
  enableDeviceSupport: true,
  enableAgentDeviceAccess: false,
  deviceHosts: [{ kind: "ssh", id: "h1", label: "Build Mac", target: "dev@mac.local" }],
  easDeviceHosts: [],
  simlockDeviceHostsEnabled: false,
  simlockDeviceHosts: [],
  defaultRuntimeMode: "full-access",
  defaultModelSelection: null,
  fallbackModelSelection: null,
  projectSettingsOverrides: {},
};

applyConfigEventForTest({ type: "snapshot", config: { environment: { environmentId: "environment-live", label: "legion" }, settings, providers: [
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
    if (method === "device.list") return Promise.resolve({ hosts: [{ id: "local", kind: "local", platforms: [{ platform: "ios", available: true }, { platform: "android", available: false, reason: "No emulator" }] }, { id: "h1", kind: "ssh", platforms: [{ platform: "ios", available: true }] }], hostStatuses: { h1: { status: "failed", detail: "connection refused" } } });
    if (method === "device.easAccount") return Promise.resolve({ signedInAs: "octo", credentialSource: "eas-login", apps: [{ id: "app-1", fullName: "@octo/shop" }] });
    if (method === "device.simlockIdentity") return Promise.resolve({ gatewayUrl: "https://g.example:4700", signedInAs: "lab", tokenSource: "entered" });
    if (method === "device.testHost") return Promise.resolve({ kind: "ssh" });
    if (method === "device.configure") return Promise.resolve({});
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

mount(() => (
  <View class="flex-1">
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <SettingsPanel path="/settings/devices" />
  </View>
));
