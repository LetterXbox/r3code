import { mount, signal, Text, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { observeServerConfigEvent, resetServerConfig } from "./settingsState";
import { setSettingsWriteAccessForTest } from "./settingsWriteAccess";
import { ToastHost } from "../../components/toast";

const failing = signal(false);

const connected = signal(false);
const calls = signal<string[]>([]);

configureSettingsSync({
  connected: () => connected(),
  request: (method, payload) => {
    calls.update((items) => [...items, `${method} ${JSON.stringify(payload)}`]);
    if (failing()) return Promise.reject(new Error(""));
    if (method === "server.removeKeybinding") return Promise.resolve({ keybindings: [], issues: [] });
    const input = payload as { command: string; key: string };
    const parts = input.key.split("+");
    const key = parts.pop()!;
    return Promise.resolve({
      keybindings: [{ command: input.command, shortcut: { key, modKey: parts.includes("mod"), metaKey: false, ctrlKey: parts.includes("ctrl"), altKey: parts.includes("alt"), shiftKey: parts.includes("shift") } }],
      issues: [],
    });
  },
});

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Connect fixture" onPress={() => { connected.set(true); resetServerConfig(); observeServerConfigEvent({ type: "snapshot", config: { keybindings: [] } }); }}><Text>Connect fixture</Text></View>
    <View accessibilityLabel="Fail fixture" onPress={() => failing.set(true)}><Text>Fail fixture</Text></View>
    <View accessibilityLabel="Deny fixture" onPress={() => setSettingsWriteAccessForTest("denied")}><Text>Deny fixture</Text></View>
    <Each of={calls()} key={(call) => call}>{(call) => <Text>{call()}</Text>}</Each>
    <SettingsPanel path="/settings/keybindings" />
    <ToastHost />
  </View>
));
