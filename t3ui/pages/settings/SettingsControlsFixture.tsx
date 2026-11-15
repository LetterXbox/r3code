import { mount, signal, Text, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { observeServerConfigEvent, resetServerConfig } from "./settingsState";

const path = signal("/settings/labs");
const connected = signal(false);
const calls = signal<string[]>([]);
const failing = signal(false);
const pending: { resolve: (value: unknown) => void; reject: (cause: unknown) => void; field: string }[] = [];
let settings: Record<string, unknown> = { fastWorktreeCheckout: false, responseStreamingMode: "paragraph" };

configureSettingsSync({
  connected: () => connected(),
  request: (method, payload) => {
    const patch = (payload as { patch: Record<string, unknown> }).patch;
    calls.update((items) => [...items, `${method} ${JSON.stringify(patch)}`]);
    return new Promise((resolve, reject) => pending.push({ field: Object.keys(patch)[0], resolve: (v) => resolve(v), reject }));
  },
});

function settle() {
  for (const item of pending.splice(0)) {
    if (failing()) item.reject(new Error("Settings are managed by your organization"));
    else item.resolve(settings);
  }
}

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Connect fixture" onPress={() => { connected.set(true); resetServerConfig(); observeServerConfigEvent({ type: "snapshot", config: { settings, environment: { capabilities: { fastWorktreeCheckout: true } } } }); }}><Text>Connect fixture</Text></View>
    <View accessibilityLabel="Fail writes" onPress={() => failing.set(true)}><Text>Fail writes</Text></View>
    <View accessibilityLabel="Accept change" onPress={() => { settings = { ...settings, fastWorktreeCheckout: true }; settle(); }}><Text>Accept change</Text></View>
    <View accessibilityLabel="Settle requests" onPress={settle}><Text>Settle requests</Text></View>
    <View accessibilityLabel="Show worktrees" onPress={() => path.set("/settings/worktrees")}><Text>Show worktrees</Text></View>
    <Each of={calls()} key={(call) => call}>{(call) => <Text>{call()}</Text>}</Each>
    {path() ? <SettingsPanel path={path()} /> : null}
  </View>
));
