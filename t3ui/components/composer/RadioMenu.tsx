// The web's Menu with a labelled MenuRadioGroup (ui/menu.tsx: MenuGroupLabel, MenuRadioItem): a
// popover with a muted `text-xs font-medium` group label and `min-h-7 px-2 py-1 text-sm` rows. The
// checked row is tinted, the highlighted one is `bg-accent`; neither draws a check mark.
import { signal, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import { Popup } from "./Popover";
import type { Content } from "./Popover";

export interface RadioMenuItem {
  value: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  content: Content;
}

export function RadioMenu(props: {
  anchor: () => ViewRef | null;
  onClose: () => void;
  group: string;
  items: () => RadioMenuItem[];
  placement?: "top" | "bottom";
  align?: "start" | "end";
  class?: string;
}) {
  const highlight = signal<string | null>(null);
  return (
    <Popup anchor={props.anchor} onClose={props.onClose} placement={props.placement ?? "top"} align={props.align ?? "start"} {...(props.class ? { class: props.class } : {})}>
      <View class="p-1" accessibilityLabel={props.group} role="menu">
        <Text class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{props.group}</Text>
        <Each of={props.items()} key={(item) => item.value}>
          {(item) => (
            <View
              class={`min-h-7 flex-row items-center rounded-sm px-2 py-1 ${item().disabled ? "opacity-64" : ""} ${highlight() === item().value ? "bg-accent" : item().checked ? "bg-accent-50" : ""}`}
              disabled={item().disabled === true}
              onPress={() => { if (!item().disabled) { item().onSelect(); props.onClose(); } }}
              onMouseEnter={() => highlight.set(item().value)}
              onMouseLeave={() => { if (highlight() === item().value) highlight.set(null); }}
              accessibilityLabel={item().label}
              role="menuitemradio"
            >
              <View class="min-w-0 flex-1">{item().content}</View>
            </View>
          )}
        </Each>
      </View>
    </Popup>
  );
}
