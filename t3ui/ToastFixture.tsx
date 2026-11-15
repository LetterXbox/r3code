// The shell's shared toast stack and confirmation dialog on their own, with buttons that raise them and a log of the answers.
import { mount, signal, Text, View } from "nsh";
import { confirm, showToast } from "./components/toast";
import { ShellOverlays } from "./shell/ShellOverlays";
import { openOverlayLabels } from "./components/rightPanel/nativeOcclusion";

const log = signal<string[]>([]);
const note = (line: string) => log.update((all) => [...all, line]);

function Button(props: { label: string; onPress: () => void }) {
  return <View role="button" accessibilityLabel={props.label} onPress={props.onPress}><Text>{props.label}</Text></View>;
}

mount(() => (
  <View class="flex-1">
    <Button label="Info" onPress={() => { showToast({ type: "info", title: "Heads up", description: "Something to know", timeoutMs: 0 }); }} />
    <Button label="Error" onPress={() => { showToast({ type: "error", title: "Clone failed", description: "Permission denied", timeoutMs: 0 }); }} />
    <Button label="Action" onPress={() => { showToast({ id: "update", type: "info", title: "Update ready", timeoutMs: 0, actions: [{ label: "Restart", run: () => note("restart") }] }); }} />
    <Button label="Action again" onPress={() => { showToast({ id: "update", type: "success", title: "Update installed", timeoutMs: 0 }); }} />
    <Button label="Quick" onPress={() => { showToast({ type: "success", title: "Copied", timeoutMs: 1500 }); }} />
    <Button label="Ask" onPress={() => { void confirm("Delete this thread?\nIt cannot be undone.", { variant: "destructive" }).then((ok) => note(`confirmed ${ok}`)); }} />
    <Button label="Ask twice" onPress={() => {
      void confirm("First?").then((ok) => note(`first ${ok}`));
      void confirm("Second?").then((ok) => note(`second ${ok}`));
    }} />
    <Text>{`overlays ${openOverlayLabels().length}`}</Text>
    <Each of={log()} key={(line, index) => `${index}${line}`}>{(line) => <Text>{`log ${line()}`}</Text>}</Each>
    <ShellOverlays />
  </View>
));
