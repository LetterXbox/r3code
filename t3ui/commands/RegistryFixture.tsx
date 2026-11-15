import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { observeServerConfigEvent, resetServerConfig } from "../pages/settings/settingsState";
import { focusProps, installFocusContexts } from "./focusContext";
import { defineContext, installKeybindings, registerCommand, registerCommands } from "./registry";
import { registerFocusArea } from "./workspaceFocus";

const log = signal<string[]>([]);
const terminalFocus = signal(false);
const note = (text: string) => () => { log.update((all) => [...all, text]); };

registerCommands({
  "sidebar.toggle": note("sidebar"),
  "chat.new": note("chat.new"),
  "terminal.new": note("terminal.new"),
  "thread.next": note("thread.next"),
});
registerCommand("thread.jump.2", note("old jump"));
registerCommand("thread.jump.2", () => { log.update((all) => [...all, "declined jump"]); return false; });
defineContext("terminalFocus", () => terminalFocus());
registerCommand("thread.undo", note("undo"));
installFocusContexts();
registerFocusArea({ id: "sidebar", focus: () => { log.update((all) => [...all, "focus sidebar"]); } });
registerFocusArea({ id: "thread", focus: () => { log.update((all) => [...all, "focus thread"]); } });
installKeybindings();

const override = (command: string, shortcut: Record<string, unknown>) => observeServerConfigEvent({ type: "keybindingsUpdated", payload: { keybindings: [{ command, shortcut }] } });

mount(() => (
  <View class="flex-1">
    <Text>{`ran: ${log().join(",")}`}</Text>
    <Input accessibilityLabel="Text field" value="" onChange={() => {}} {...focusProps("editable")} />
    <View accessibilityLabel="Focus terminal" onPress={() => terminalFocus.set(true)}><Text>Focus terminal</Text></View>
    <View accessibilityLabel="Rebind sidebar" onPress={() => override("sidebar.toggle", { key: "e", modKey: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })}><Text>Rebind sidebar</Text></View>
    <View accessibilityLabel="Reset config" onPress={() => resetServerConfig()}><Text>Reset config</Text></View>
  </View>
));
