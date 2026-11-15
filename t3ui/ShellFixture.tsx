// The shell's overlays with a quit shortcut button and the keybindings toast: what App.tsx wires, without the app.
import { mount, signal, Text, View } from "nsh";
import { ShellOverlays } from "./shell/ShellOverlays";
import { createKeybindingsToastController, showKeybindingsToast } from "./shell/keybindingsToast";
import { pressQuitShortcut, setQuitAction } from "./shell/quitHold";

const quits = signal(0);
setQuitAction(() => quits.update((count) => count + 1));
const decide = createKeybindingsToastController();
const opened = signal(0);

const event = (issues: { kind: string; message: string }[]) => ({ type: "keybindingsUpdated", payload: { keybindings: [], issues } });

mount(() => (
  <View class="flex-1">
    <View role="button" accessibilityLabel="Quit shortcut" onPress={pressQuitShortcut}><Text>Quit shortcut</Text></View>
    <View role="button" accessibilityLabel="Reload ok" onPress={() => { const decision = decide(event([])); if (decision) showKeybindingsToast(decision, true, () => opened.update((n) => n + 1)); }}><Text>Reload ok</Text></View>
    <View role="button" accessibilityLabel="Reload bad" onPress={() => { const decision = decide(event([{ kind: "keybindings.invalid-entry", message: "Unknown command" }])); if (decision) showKeybindingsToast(decision, true, () => opened.update((n) => n + 1)); }}><Text>Reload bad</Text></View>
    <View role="button" accessibilityLabel="Reload bad no editor" onPress={() => { const decision = decide(event([{ kind: "keybindings.other", message: "No editor case" }])); if (decision) showKeybindingsToast(decision, false); }}><Text>Reload bad no editor</Text></View>
    <Text>{`quits ${quits()}`}</Text>
    <Text>{`opened ${opened()}`}</Text>
    <ShellOverlays />
  </View>
));
