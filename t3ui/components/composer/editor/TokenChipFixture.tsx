// Visual fixture: the prompt editor with a skill token and a file token (window check of the chip icons).
import { mount, View } from "nsh";
import { PromptEditor } from "./PromptEditor";
import { promptTextStyle } from "../../../typography";

const context = { skills: new Map([["agent-browser", "agent-browser"]]) };

function Fixture() {
  return (
    <View class="flex-1 bg-background p-6">
      <View class="rounded-2xl bg-surface-raised p-4">
        <PromptEditor
          value={() => "Use $agent-browser on [package.json](/work/package.json) and [App.tsx](/work/src/App.tsx) now"}
          onChange={() => {}}
          onCaret={() => {}}
          forcedCaret={() => undefined}
          onForcedCaretApplied={() => {}}
          context={() => context}
          placeholder={() => "Ask"}
          editable={() => true}
          keys={{ captureEnter: () => false, captureArrows: () => false, captureTab: () => false, captureEscape: () => false, onKey: () => {} }}
          textStyle={() => promptTextStyle()}
          minHeight={40}
          maxHeight={200}
          onFocus={() => {}}
          onBlur={() => {}}
          onPasteFiles={() => {}}
        />
      </View>
    </View>
  );
}
mount(Fixture);
