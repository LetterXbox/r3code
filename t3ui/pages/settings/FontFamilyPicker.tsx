// FontFamilyPicker.tsx: a searchable list of the installed families (the default first, "default" beside it), each
// drawn in its own face, with a check on the chosen one; "No fonts found." when the search matches none. Picking a
// family that is not fixed-width for code or the terminal keeps the current font and says why.
import { signal, Text, token, View, Scroll } from "nsh";
import { Input, Popover } from "nsh/base";
import { Icon } from "../../components/Icons";
import { errorToast } from "../../components/toast";
import { trackOpenChange, useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { fontEnumeration, isMonospaceFamily } from "../../desktop/fonts";

const DEFAULT_FONT_VALUE = "__default__";

export function fontPickerItems(families: readonly string[], query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  return [...(trimmed.length === 0 ? [DEFAULT_FONT_VALUE] : []), ...families.filter((family) => trimmed.length === 0 || family.toLowerCase().includes(trimmed))];
}

export function FontFamilyPicker(props: { ariaLabel: string; defaultFamily: string; selectedFamily: string; requireMonospace?: boolean; onSelect: (family: string) => void }) {
  const open = signal(false);
  const query = signal("");
  useOverlayOpen(() => open(), "font family picker");
  const families = () => { const state = fontEnumeration(); return state.status === "granted" ? state.families : []; };
  const items = () => fontPickerItems(families(), query());
  const selectedValue = () => (props.selectedFamily.length === 0 ? DEFAULT_FONT_VALUE : props.selectedFamily);
  const pick = (value: string) => {
    open.set(false);
    if (value !== DEFAULT_FONT_VALUE && props.requireMonospace && !isMonospaceFamily(value)) {
      errorToast(`"${value}" isn't monospace`, "Code and terminal need a fixed-width font, so the current font was kept.");
      return;
    }
    props.onSelect(value === DEFAULT_FONT_VALUE ? "" : value);
  };
  return (
    <Popover
      open={open()}
      onOpenChange={(event: { open: boolean }) => { trackOpenChange(open)(event); if (event.open) query.set(""); }}
      placement="bottom"
      align="end"
      offset={4}
      popupClass="w-72 rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
      trigger={
        <View accessibilityLabel={props.ariaLabel} testID={`${props.ariaLabel} = ${props.selectedFamily}`}
          class="h-7 w-44 flex-row items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-[9px] dark:bg-input-32">
          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{props.selectedFamily.length === 0 ? props.defaultFamily : props.selectedFamily}</Text>
          <View class="-mr-1 opacity-70"><Icon name="chevron-down" size={14} tint={token("icon-muted")} /></View>
        </View>
      }
    >
      <View class="gap-1">
        <Input accessibilityLabel="Search fonts" value={query()} placeholder="Search fonts…" autoFocus autoCapitalize="none" autoCorrect={false}
          onChange={(event) => query.set(event.value)} onSubmit={() => { const first = items()[0]; if (first) pick(first); }}
          class="h-8 w-full rounded-md border-b border-border bg-transparent px-2 text-sm text-foreground" />
        {items().length === 0 ? <Text class="px-2 py-4 text-center text-sm text-muted-foreground">No fonts found.</Text> : (
          <Scroll class="max-h-72">
            <Each of={items()} key={(item) => item}>
              {(item) => {
                const isDefault = item() === DEFAULT_FONT_VALUE;
                const family = isDefault ? props.defaultFamily : item();
                return (
                  <View role="button" accessibilityLabel={family} onPress={() => pick(item())} class="min-h-7 flex-row items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-accent">
                    <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground" style={isDefault ? undefined : { fontFamily: family }}>{family}</Text>
                    <View class="flex-row items-center gap-1.5">
                      {isDefault ? <Text class="text-3xs text-muted-foreground">default</Text> : null}
                      {item() === selectedValue() ? <Icon name="check" size={14} tint={token("muted-foreground")} /> : null}
                    </View>
                  </View>
                );
              }}
            </Each>
          </Scroll>
        )}
      </View>
    </Popover>
  );
}
