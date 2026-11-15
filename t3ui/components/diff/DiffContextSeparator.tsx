// Pierre's "line-info" hunk separator (createSeparator), styled as StyledDiffCodeView styles it: a 24px row one step
// off the code surface, the expand button(s) in their own cell, then "N unmodified lines" in the sans face at 11px and
// half-strength foreground; a long gap has up and down buttons and an "Expand all" cell. Hover brings them forward.
import { Image, Text, token, View } from "nsh";
import expandIcon from "./icons/expand.svg";
import expandFlippedIcon from "./icons/expand-up.svg";
import expandAllIcon from "./icons/expand-all.svg";
import { separatorButtons, separatorLabel } from "./diffContext";

export type SeparatorAction = "both" | "up" | "down" | "all";

/** `expandable` false: Pierre draws the count without buttons (no loader, or a file whose context cannot hydrate). */
export function DiffContextSeparator(props: { lines: number | null; first: boolean; last: boolean; expandable: boolean; onExpand: (action: SeparatorAction) => void }) {
  const buttons = () => (props.expandable ? separatorButtons(props.lines, props.first, props.last) : []);
  // [data-expand-down] [data-icon]{transform:scaleY(-1)}: the up button's chevron points down, the down button's up.
  const icon = (action: SeparatorAction) => (action === "both" ? expandAllIcon : action === "down" ? expandFlippedIcon : expandIcon);
  const label = (action: SeparatorAction) => (action === "up" ? "Expand up" : action === "down" ? "Expand down" : "Expand");
  return (
    <View class="h-6 w-full flex-row items-stretch bg-background" accessibilityLabel={separatorLabel(props.lines)}>
      <Each of={buttons().filter((action) => action !== "all")} key={(action: SeparatorAction) => action}>
        {(action) => (
          <View role="button" accessibilityLabel={label(action())} onPress={() => props.onExpand(action())} class="w-8 shrink-0 items-center justify-center hover:bg-accent-50">
            <Image src={icon(action())} style={{ width: 16, height: 16, tintColor: token("muted-foreground") }} />
          </View>
        )}
      </Each>
      <View class="min-w-0 flex-1 flex-row items-center px-2">
        <Text class="truncate text-muted-foreground" style={{ fontSize: 11 }}>{separatorLabel(props.lines)}</Text>
      </View>
      {buttons().includes("all") ? (
        <View role="button" accessibilityLabel="Expand all" onPress={() => props.onExpand("all")} class="shrink-0 flex-row items-center px-2 hover:bg-accent-50">
          <Text class="text-muted-foreground" style={{ fontSize: 11 }}>Expand all</Text>
        </View>
      ) : null}
    </View>
  );
}
