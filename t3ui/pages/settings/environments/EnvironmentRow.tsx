// EnvironmentRow.tsx: the machine mark, the name over its status line, and the row's controls,
// laid out as the web's grid (`grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 px-3 py-2.5 sm:px-4`).
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { SettingsIcon } from "../SettingsIcon";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../../../components/menuStyles";

export type MachineKind = "desktop" | "server";

export function EnvironmentRow(props: {
  kind: MachineKind;
  label: string;
  subtitle: string;
  subtitleTone?: "muted" | "error";
  /** The status tip over the subtitle (SavedEnvironmentRows' statusTooltip). */
  subtitleTooltip?: string;
  below?: any;
  dimmed?: boolean;
  children?: any;
  testID?: string;
}) {
  return (
    <View class="flex-row items-center gap-3 px-4 py-2.5" testID={props.testID} accessibilityLabel={props.label}>
      <View class={props.dimmed ? "opacity-60" : ""}><SettingsIcon name={props.kind === "desktop" ? "monitor" : "server"} size={16} /></View>
      <View class={`min-w-0 flex-1 ${props.dimmed ? "opacity-60" : ""}`}>
        <Text class="truncate text-sm font-medium text-foreground">{props.label}</Text>
        <Text tooltip={props.subtitleTooltip} class={`truncate text-xs ${props.subtitleTone === "error" && !props.dimmed ? "text-destructive-foreground" : "text-muted-foreground"}`}>{props.subtitle}</Text>
        {props.below ?? null}
      </View>
      <View class="flex-row items-center gap-1">{props.children}</View>
    </View>
  );
}

const MENU_CLASS = MENU_POPUP_CLASS;
const ITEM_CLASS = MENU_ITEM_ROW_CLASS;

export interface RowMenuItem { label: string; onSelect: () => void; destructive?: boolean; separatorBefore?: boolean }

/** The "More actions for ..." ellipsis menu (`Button variant="ghost-muted" size="icon-xs"` over a `Menu`). */
export function RowMenu(props: { label: string; items: RowMenuItem[]; disabled?: boolean }) {
  return (
    <Menu
      popupClass={MENU_CLASS}
      trigger={
        <View
          role="button"
          accessibilityLabel={`More actions for ${props.label}`}
          disabled={props.disabled}
          class="size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        >
          <SettingsIcon name="ellipsis" size={14} />
        </View>
      }
    >
      {props.items.map((item) => (
        <>
          {item.separatorBefore ? <MenuSeparator /> : null}
          <MenuItem accessibilityLabel={item.label} class={ITEM_CLASS} onSelect={item.onSelect}>
            <Text class={`min-w-0 flex-1 truncate text-sm ${item.destructive ? "text-destructive-foreground" : "text-popover-foreground"}`}>{item.label}</Text>
          </MenuItem>
        </>
      ))}
    </Menu>
  );
}
