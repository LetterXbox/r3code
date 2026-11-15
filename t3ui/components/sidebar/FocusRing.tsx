// The keyboard focus ring of a sidebar row: focus-visible:ring-2 ring-inset ring-ring, drawn as an inset border
// over the row so the row's own size never moves.
import { View } from "nsh";
import { showsFocusRing } from "./sidebarTree";

export function FocusRing(props: { id: string; rounded?: string }) {
  return showsFocusRing(props.id) ? (
    <View
      accessibilityLabel="Focus ring"
      class={`absolute inset-0 border-2 border-ring ${props.rounded ?? "rounded-md"}`}
      style={{ pointerEvents: "none" }}
    />
  ) : null;
}
