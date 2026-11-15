// composerCommandKey navigatePromptHistory's visual-edge rule: the editor tells the app, per arrow key, whether the
// caret sits on the first (Up) or last (Down) visual line. The fixture shows the latest answers as text.
import { mount, signal, Text, View } from "nsh";
import { PromptEditor } from "./PromptEditor";

const value = signal("first line\nsecond line\nthird line");
const forced = signal<number | undefined>(undefined);
const edges = signal({ up: false, down: false });

function Fixture() {
  let handle: { focus: () => void } | null = null;
  const report = (key: "ArrowUp" | "ArrowDown", onEdge: boolean) => {
    const next = { ...edges(), [key === "ArrowUp" ? "up" : "down"]: onEdge };
    if (next.up !== edges().up || next.down !== edges().down) edges.set(next);
    return false;
  };
  return (
    <View class="w-96">
      <Text>{`up:${edges().up} down:${edges().down}`}</Text>
      <View role="button" accessibilityLabel="Caret start" onPress={() => { handle?.focus(); forced.set(0); }}><Text>start</Text></View>
      <View role="button" accessibilityLabel="Caret middle" onPress={() => { handle?.focus(); forced.set(14); }}><Text>middle</Text></View>
      <View role="button" accessibilityLabel="Caret end" onPress={() => { handle?.focus(); forced.set(value().length); }}><Text>end</Text></View>
      <PromptEditor
        ref={(h) => { handle = h; }}
        value={value}
        onChange={(text) => value.set(text)}
        onCaret={() => {}}
        forcedCaret={forced}
        onForcedCaretApplied={() => forced.set(undefined)}
        context={() => ({ skills: new Map() })}
        placeholder={() => "Ask"}
        editable={() => true}
        keys={{ captureEnter: () => false, captureArrows: report, captureTab: () => false, captureEscape: () => false, onKey: () => {} }}
        textStyle={() => ({})}
        minHeight={40}
        maxHeight={200}
        onFocus={() => {}}
        onBlur={() => {}}
        onPasteFiles={() => {}}
      />
    </View>
  );
}

mount(() => <Fixture />);
