import { mount, signal, Text, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { observeServerConfigEvent } from "./settingsState";

const calls = signal<string[]>([]);
const none = { _tag: "None" };
const some = (value: string) => ({ _tag: "Some", value });
let settings: Record<string, unknown> = { sourceControlHosts: { github: { hosts: {}, tokens: {} } } };
observeServerConfigEvent({ type: "snapshot", config: { settings } });

configureSettingsSync({
  connected: () => true,
  request: (method, payload) => {
    if (method === "server.discoverSourceControl") {
      return Promise.resolve({
        versionControlSystems: [],
        sourceControlProviders: [{
          kind: "github", label: "GitHub", status: "available", version: some("2.60.1"), installHint: "Install gh.", detail: none, executable: "gh",
          auth: { status: "authenticated", account: some("ada"), host: some("github.com"), detail: none, accounts: [
            { host: "github.com", account: "ada", active: true, authenticated: true },
            { host: "github.com", account: "bob", active: false, authenticated: true },
          ] },
        }],
      });
    }
    if (method === "server.updateSettings") {
      const patch = (payload as { patch: Record<string, unknown> }).patch;
      calls.update((items) => [...items, `update ${JSON.stringify(patch)}`]);
      settings = { ...settings, ...patch };
      return Promise.resolve(settings);
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  },
});

mount(() => (
  <View class="flex-1">
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{call()}</Text>}</Each>
    <SettingsPanel path="/settings/source-control" />
  </View>
));
