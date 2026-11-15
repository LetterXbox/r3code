import { mount, Scroll, signal, Text, View } from "nsh";
import { SettingsPanel } from "../Panel";
import { observeServerConfigEvent } from "../settingsState";
import { configureSettingsSync } from "../settingsSync";

// A connected server whose ServerSettings the panels read, and the patches written to it.
const writes = signal<string[]>([]);
let current: Record<string, unknown> = { snoozePresets: [{ kind: "after", minutes: 60 }, { kind: "at", day: "tomorrow", time: "09:00" }] };
const connected = signal(true);
configureSettingsSync({
  connected: () => connected(),
  request: (method, payload) => {
    const patch = (payload as { patch: Record<string, unknown> }).patch;
    writes.update((all) => [...all, `${method} ${JSON.stringify(patch)}`]);
    current = { ...current, ...patch };
    return Promise.resolve(current);
  },
});
observeServerConfigEvent({ type: "snapshot", config: { settings: current, keybindings: [], environment: { environmentId: "env-1", label: "This Mac", serverVersion: "1" } } });

mount(() => (
  <View class="flex-1">
    <Each of={writes()} key={(write, index) => `${index}${write}`}>{(write) => <Text>{`write ${write()}`}</Text>}</Each>
    <Scroll class="flex-1"><SettingsPanel path="/settings/threads" /><SettingsPanel path="/settings/snap-shot" /></Scroll>
  </View>
));
