// A search target for a card, section or whole page the generated rows do not cover: the settings
// search scrolls to it (Settings.tsx registers the scroll area), as it does for a generated row.
import type { ViewRef } from "nsh";
import { View } from "nsh";
import { registerSettingsRow } from "./settingsSearchNav";

export function SearchAnchor(props: { path: string; id: string; class?: string; children: any }) {
  return <View class={props.class} ref={(node: ViewRef) => registerSettingsRow(props.path, props.id, node)}>{props.children}</View>;
}
