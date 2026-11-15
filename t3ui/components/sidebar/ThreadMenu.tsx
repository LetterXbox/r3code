// Renders ThreadMenuItem[] as nsh menu items. Icons use the web's lucide names.
import { Text, token, View } from "nsh";
import { MenuItem, MenuSeparator, Submenu } from "nsh/base";
import { Icon } from "../Icons";
import { Glyph } from "./SidebarGlyph";
import type { GlyphName } from "./SidebarGlyph";
import type { ThreadMenuId, ThreadMenuItem } from "./threadActions";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS, MENU_SEPARATOR_CLASS, MENU_SUBPOPUP_CLASS } from "../menuStyles";

export { MENU_POPUP_CLASS };
const ITEM_CLASS = MENU_ITEM_ROW_CLASS;

// The shared Icon registry carries these; everything else comes from SidebarGlyph.
const SHARED_ICONS = new Set(["archive", "folder", "git-branch", "settings", "message-square", "folder-plus", "folder-tree"]);
const GLYPH_ALIASES: Record<string, GlyphName> = { trash: "trash-2" };

function MenuIcon(props: { name?: string; destructive?: boolean }) {
  if (!props.name) return <View class="size-4" />;
  const tint = props.destructive ? token("destructive-foreground") : token("muted-foreground");
  if (SHARED_ICONS.has(props.name)) return <Icon name={props.name} size={16} tint={tint} />;
  const name = (GLYPH_ALIASES[props.name] ?? props.name) as GlyphName;
  return <Glyph name={name} size={16} tint={tint} />;
}

function ItemBody(props: { item: ThreadMenuItem }) {
  return (
    <>
      {props.item.checked === undefined ? <MenuIcon name={props.item.icon} destructive={props.item.destructive} /> : null}
      <Text class={`flex-1 truncate text-sm ${props.item.destructive ? "text-destructive-foreground" : "text-popover-foreground"}`}>
        {props.item.label}
      </Text>
      {props.item.checked === true ? <Glyph name="check" size={16} tint={token("popover-foreground")} /> : null}
    </>
  );
}

/** One level of a menu: separators, plain items and submenus (the web's `children`). */
export function ThreadMenuItems(props: { items: ThreadMenuItem[]; onSelect: (id: ThreadMenuId) => void }) {
  return (
    <>
      {props.items.map((item) => (
        <>
          {item.separatorBefore ? <MenuSeparator class={MENU_SEPARATOR_CLASS} /> : null}
          {item.children ? (
            <Submenu
              disabled={item.disabled}
              trigger={
                <MenuItem
                  accessibilityLabel={item.label}
                  disabled={item.disabled}
                  closeOnSelect={false}
                  class={ITEM_CLASS}
                >
                  <ItemBody item={item} />
                  <Icon name="chevron-right" size={16} tint={token("muted-foreground")} />
                </MenuItem>
              }
            >
              <View class={MENU_SUBPOPUP_CLASS}>
                <ThreadMenuItems items={item.children} onSelect={props.onSelect} />
              </View>
            </Submenu>
          ) : (
            <MenuItem
              accessibilityLabel={item.label}
              disabled={item.disabled}
              class={ITEM_CLASS}
              onSelect={() => props.onSelect(item.id)}
            >
              <ItemBody item={item} />
            </MenuItem>
          )}
        </>
      ))}
    </>
  );
}
