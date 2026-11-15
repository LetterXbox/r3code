import { mount, signal, Text, View } from "nsh";
import { promptTextStyle } from "../../typography";
import { PromptEditor } from "./editor/PromptEditor";
import { SuggestedPrompt } from "./SuggestedPrompt";

const draft = signal("");
const enabled = signal(true);
const suggestion = "Continue with the remaining checks";
const offered = () => enabled() && draft() === "" ? suggestion : null;
mount(() => <View class="flex-1 p-6">
  <View role="button" accessibilityLabel="Toggle suggestion" onPress={() => enabled.set(!enabled())}><Text>Toggle suggestion</Text></View>
  <Text>{`draft:${draft()}`}</Text>
  <View class="relative w-full min-h-[46px]">
    <PromptEditor value={draft} onChange={(value) => draft.set(value)} onCaret={() => {}} forcedCaret={() => undefined} onForcedCaretApplied={() => {}}
      context={() => ({ skills: new Map() })} placeholder={() => offered() ? "" : "Ask"} editable={() => true} textStyle={promptTextStyle} minHeight={46} maxHeight={200}
      onFocus={() => {}} onBlur={() => {}} onPasteFiles={() => {}}
      keys={{ captureEnter: () => false, captureArrows: () => false, captureTab: () => offered() !== null, captureEscape: () => false, onKey: (key) => { if (key === "Tab" && offered()) draft.set(suggestion); } }} />
    <SuggestedPrompt text={offered} />
  </View>
</View>);
