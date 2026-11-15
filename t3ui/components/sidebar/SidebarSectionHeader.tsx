// ui/collapsible-section-header.tsx: h-8, gap-2, px-2, text-xs font-medium muted, the label, a
// trailing count (font-normal tabular-nums) and a size-3 chevron that turns -90deg when closed.
import { Text, token, View } from "nsh";
import { mixColors } from "./mix";
import { SidebarIcon as Icon } from "../SidebarIcon";
import { releaseFocusRing, shelfRowId, treeRowProps } from "./sidebarTree";
import { FocusRing } from "./FocusRing";
import { ChevronTurn } from "../motion/Motion";

export function SidebarSectionHeader(props: { label: string; count: number; expanded: boolean; onToggle: () => void; shelf?: "working" | "snoozed" | "settled"; dropTarget?: boolean; dragging?: boolean }) {
  // tone: accent while a dragged row is over it, emphasized while any row is dragged, else muted.
  const labelColor = () => props.dropTarget
    ? token("primary")
    : props.dragging ? mixColors(token("sidebar-foreground"), token("sidebar"), 0.8) : token("sidebar-muted-foreground");
  const tree = props.shelf ? treeRowProps(shelfRowId(props.shelf), props.onToggle) : null;
  return (
    <View
      role="button"
      ref={tree?.ref}
      onFocus={tree?.onFocus}
      onBlur={tree?.onBlur}
      accessibilityLabel={`${props.label} threads, ${props.count}`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={() => { releaseFocusRing(); props.onToggle(); }}
      class="mx-0.5 h-8 flex-row items-center gap-2 rounded-md bg-transparent px-2"
      style={props.dropTarget ? { backgroundColor: mixColors(token("primary"), token("sidebar"), 0.1) } : undefined}
    >
      {props.shelf ? <FocusRing id={shelfRowId(props.shelf)} /> : null}
      <Text class="min-w-0 truncate text-xs font-medium" style={{ color: labelColor() }}>{props.label}</Text>
      <View class="h-px min-w-2 flex-1" />
      <Text class="text-xs font-normal" style={{ color: labelColor() }}>{props.count}</Text>
      {/* The web turns a down chevron -90deg when closed; a transform is not reliably drawn, so the right chevron stands in. */}
      <ChevronTurn open={() => props.expanded}><Icon name="chevron-right" size={12} /></ChevronTurn>
    </View>
  );
}

/** The "Show N more" row under an open Settled shelf. */
export function SidebarShowMore(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class="h-9 flex-row items-center gap-2.5 rounded-md bg-transparent px-2.5 hover:bg-sidebar-row-hover"
    >
      <Icon name="chevron-down" size={16} />
      <Text class="text-sm text-sidebar-muted-foreground">{props.label}</Text>
    </View>
  );
}
