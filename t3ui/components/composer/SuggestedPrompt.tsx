import { Text, View } from "nsh";
import { promptTextStyle } from "../../typography";

/** Visual placeholder only; pointer events stay with the editor underneath it. */
export function SuggestedPrompt(props: { text: () => string | null }) {
  return <>{props.text() === null ? null : <View class="absolute inset-0 flex-row flex-wrap items-start" style={{ pointerEvents: "none" }}>
    <Text class="shrink text-placeholder leading-relaxed" style={promptTextStyle()}>{props.text()}</Text>
    <View class="ml-2 mt-0.5 rounded border border-border px-1"><Text class="text-2xs text-muted-foreground">⇥ Tab</Text></View>
  </View>}</>;
}
