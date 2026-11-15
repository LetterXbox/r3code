// A row of a hand-built panel that a settings search result can scroll to and highlight, as the
// generated panels' rows do (Panel.tsx).
import type { ViewRef } from "nsh";
import { reduceMotion, View } from "nsh";
import { registerSettingsRow, rowTargetId, settingsTarget } from "./settingsSearchNav";
import { SearchTargetPulse } from "../../components/motion/Motion";

export function TargetRow(props: { path: string; id: string | null; title: string; first?: boolean; children: any }) {
  const id = rowTargetId(props.path, props.id, props.title);
  const hit = () => settingsTarget()?.path === props.path && settingsTarget()?.id === id;
  return (
    <View
      ref={(node: ViewRef) => registerSettingsRow(props.path, id, node)}
      testID={`Settings row ${id} (${hit() ? "target" : "idle"})`}
      class={hit() ? "bg-accent-50" : undefined}
    >
      {hit() && !reduceMotion() ? <SearchTargetPulse /> : null}
      {props.first ? null : <View class="h-px bg-border-50" />}
      {props.children}
    </View>
  );
}
