import { Clipboard, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { bindTypeToFocus } from "./composerFocusRedirect";
import { pasteIntoComposer } from "./usePasteToFocusComposer";

const draft = signal("");
const other = signal("");
const enabled = signal(true);
const attached = signal<string[]>([]);

function Fixture() {
  bindTypeToFocus({
    enabled,
    onText: (text) => draft.set(draft() + text),
    onPaste: () => { void pasteIntoComposer({ insertText: (text) => draft.set(draft() + text), attachPaths: (uris) => attached.set(uris), attachFiles: (files) => attached.set(files.map((file) => file.name)) }, { files: async () => [], text: () => Clipboard.readText() }); },
  });
  return (
    <View>
      <Input accessibilityLabel="Other field" value={other()} onChange={(event) => other.set(event.value)} />
      <View accessibilityLabel="Elsewhere" onPress={() => {}}><Text>elsewhere</Text></View>
      <View accessibilityLabel="Copy text" onPress={() => void Clipboard.writeText("pasted text")}><Text>copy</Text></View>
      <View accessibilityLabel="Disable redirect" onPress={() => enabled.set(false)}><Text>disable</Text></View>
      <Text>{`draft:${draft()}`}</Text>
      <Text>{`other:${other()}`}</Text>
      <Text>{`attached:${attached().length}`}</Text>
    </View>
  );
}
mount(Fixture);
