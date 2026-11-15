import { mount, signal, Text, View } from "nsh";
import { PromptEditor } from "./PromptEditor";
import { promptTextStyle } from "../../../typography";

const result = signal("waiting");
mount(() => <View>
  <PromptEditor value={() => ""} onChange={() => {}} onCaret={() => {}} forcedCaret={() => undefined} onForcedCaretApplied={() => {}} context={() => ({ skills: new Map() })} placeholder={() => "Ask"} editable={() => true} keys={{ captureEnter: () => false, captureArrows: () => false, captureTab: () => false, captureEscape: () => false, onKey: () => {} }} textStyle={() => promptTextStyle()} minHeight={40} maxHeight={200} onFocus={() => {}} onBlur={() => {}} onPasteFiles={(files) => {
    const file = files[0];
    if (file) void file.arrayBuffer().then((buffer) => result.set(`${file.type}:${Array.from(new Uint8Array(buffer).slice(0, 4)).join(",")}`));
  }} />
  <Text>{result()}</Text>
</View>);
