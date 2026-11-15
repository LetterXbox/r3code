// Prompt editors across the layout paths that used to take a focused one out (ThreadView's draft-to-thread switch, a
// thread switch, the right panel closed by its toggle with a side chat's composer focused, the chat maximised away).
// It counts mounts, unmounts and unmounts while the editor reported focus (the runtime leak, PromptEditor.tsx).
import { cleanup, mount, signal, Text, View } from "nsh";
import { PromptEditor, settledLayout } from "./PromptEditor";

const stats = signal({ mounts: 0, unmounts: 0, focusedUnmounts: 0, focused: 0 });
const bump = (key: "mounts" | "unmounts" | "focusedUnmounts" | "focused", by = 1) => stats.update((s) => ({ ...s, [key]: s[key] + by }));

function Editor(props: { name: string; threadId: () => string }) {
  let focused = false;
  bump("mounts");
  cleanup(() => { bump("unmounts"); if (focused) bump("focusedUnmounts"); });
  let handle: { focus: () => void } | null = null;
  return (
    <View>
      <Text>{`${props.name}:${props.threadId()}`}</Text>
      <View role="button" accessibilityLabel={`Focus ${props.name}`} onPress={() => handle?.focus()}><Text>focus</Text></View>
      <PromptEditor
        ref={(h) => { handle = h; }}
        value={() => ""}
        onChange={() => {}}
        onCaret={() => {}}
        forcedCaret={() => undefined}
        onForcedCaretApplied={() => {}}
        context={() => ({ skills: new Map() })}
        placeholder={() => "Ask"}
        editable={() => true}
        keys={{ captureEnter: () => false, captureArrows: () => false, captureTab: () => false, captureEscape: () => false, onKey: () => {} }}
        textStyle={() => ({})}
        minHeight={40}
        maxHeight={200}
        onFocus={() => { if (!focused) bump("focused"); focused = true; }}
        onBlur={() => { if (focused) bump("focused", -1); focused = false; }}
        onPasteFiles={() => {}}
      />
    </View>
  );
}

function Fixture() {
  // ThreadView: the open thread is a draft until the first send turns it into a server thread.
  const thread = signal({ id: "draft:1", draft: true });
  const draftLayout = settledLayout(() => thread().draft);
  // RightPanel: the docked panel (here holding a side chat's composer) as a settled boolean.
  const panelOpen = signal(true);
  const docked = settledLayout(() => panelOpen());
  const maximized = signal(false);
  const s = () => stats();
  return (
    <View class="flex-1">
      <Text>{`mounts=${s().mounts} unmounts=${s().unmounts} focusedUnmounts=${s().focusedUnmounts} focused=${s().focused}`}</Text>
      <View role="button" accessibilityLabel="Send first" onPress={() => thread.set({ id: "thread:1", draft: false })}><Text>send</Text></View>
      <View role="button" accessibilityLabel="Switch thread" onPress={() => thread.set({ id: "thread:2", draft: false })}><Text>switch</Text></View>
      <View role="button" accessibilityLabel="Toggle panel" onPress={() => panelOpen.set(!panelOpen())}><Text>panel</Text></View>
      <View role="button" accessibilityLabel="Toggle maximise" onPress={() => maximized.set(!maximized())}><Text>max</Text></View>
    <View class="flex-1 flex-row">
      <View class={maximized() ? "hidden" : "flex-1"}>
        <View class={draftLayout() ? "flex-1 justify-center" : "flex-1"}>
          {draftLayout() ? <Text>hero</Text> : <Text>{`timeline:${thread().id}`}</Text>}
          <Editor name="main" threadId={() => thread().id} />
        </View>
      </View>
      {docked() ? <View class="w-[300px]"><Editor name="side" threadId={() => "side:1"} /></View> : <Text>panel closed</Text>}
    </View>
    </View>
  );
}
mount(Fixture);
