// A focused prompt editor disabled the way the composer does it (settledLayout, so the keyboard is released first),
// next to a plain field whose Backspace must keep working (the leaked key table: workspace/nsh-runtime-bugs.md).
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { PromptEditor, settledLayout } from "./PromptEditor";

const wanted = signal(false);
const focused = signal(false);
const field = signal("abc");

function Fixture() {
  const disabled = settledLayout(() => wanted());
  let handle: { focus: () => void } | null = null;
  return (
    <View class="flex-1">
      <Text>{`focused=${focused()} disabled=${disabled()} field=${field()}`}</Text>
      <View role="button" accessibilityLabel="Focus editor" onPress={() => handle?.focus()}><Text>focus</Text></View>
      <View role="button" accessibilityLabel="Disable editor" onPress={() => wanted.set(true)}><Text>disable</Text></View>
      <Input accessibilityLabel="Plain field" value={field()} onChange={(event) => field.set(event.value)} />
      <PromptEditor
        ref={(h) => { handle = h; }}
        value={() => ""}
        onChange={() => {}}
        onCaret={() => {}}
        forcedCaret={() => undefined}
        onForcedCaretApplied={() => {}}
        context={() => ({ skills: new Map() })}
        placeholder={() => "Ask"}
        editable={() => !disabled()}
        keys={{ captureEnter: () => false, captureArrows: () => false, captureTab: () => false, captureEscape: () => false, onKey: () => {} }}
        textStyle={() => ({})}
        minHeight={40}
        maxHeight={200}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        onPasteFiles={() => {}}
      />
    </View>
  );
}
mount(Fixture);
