// ProviderAccentColorPicker.tsx (inline layout): a trigger showing the accent, opening a saturation and
// brightness plane, a hue slider and a hex field, with Add color / Clear color.
import { signal, Text, View } from "nsh";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { ColorArea, ColorField, ColorPicker, ColorSlider, Popover } from "nsh/base";
import { normalizeAccentColor } from "./logic";
import { UiIcon } from "./ui";

const FALLBACK_ACCENT_COLOR = "#2563eb";

export function AccentColorPicker(props: { name: string; value: string | undefined; disabled: boolean; onCommit: (value: string) => void }) {
  const open = signal(false);
  useOverlayOpen(() => open(), "accent colour picker");
  // A dragged colour shows at once; it is written when the pointer lifts.
  const preview = signal<string | null>(null);
  const current = () => preview() ?? props.value ?? FALLBACK_ACCENT_COLOR;
  const commit = (color: string) => { preview.set(null); props.onCommit(normalizeAccentColor(color) ?? ""); };
  return <Popover open={open()} onOpenChange={(event) => { open.set(event.open); if (!event.open) { const pending = preview(); if (pending !== null) commit(pending); } }}
    placement="bottom" align="start" offset={6} popupClass="w-56 overflow-hidden rounded-lg border border-border bg-popover-84"
    trigger={<View accessibilityLabel={`${props.value ? "Change" : "Add"} accent color for ${props.name}`} role="button" disabled={props.disabled}
      class={`size-8 items-center justify-center rounded-md hover:bg-accent-50 ${props.disabled ? "opacity-64" : ""}`}
      style={props.value ? { backgroundColor: props.value } : undefined}>{props.value ? null : <UiIcon name="plus" size={14} />}</View>}>
    <ColorPicker value={current()} onChange={(event) => preview.set(event.value)} onChangeEnd={(event) => commit(event.value)} disabled={props.disabled}>
      <ColorArea accessibilityLabel="Accent color" class="h-36 w-full" panelClass="h-36 w-full" thumbClass="size-3 rounded-full border-2 border-white" />
      <View class="gap-3 p-3">
        <ColorSlider channel="hue" accessibilityLabel="Accent color hue" class="h-4 w-full" trackClass="h-2.5 w-full rounded-full" thumbClass="size-4 rounded-full border-2 border-white" />
        <ColorField accessibilityLabel="Custom hex accent color" format="hex" class="h-7 w-full rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground" />
        {!props.value ? <View accessibilityLabel="Add color" role="button" onPress={() => { commit(current()); open.set(false); }} class="h-7 items-center justify-center rounded-md border border-input bg-background hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <Text class="text-sm text-foreground">Add color</Text></View> : null}
      </View>
    </ColorPicker>
    {props.value ? <View class="border-t border-border-60 p-1">
      <View accessibilityLabel="Clear color" role="button" onPress={() => { commit(""); open.set(false); }} class="h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent-50">
        <UiIcon name="x" size={14} /><Text class="text-sm text-muted-foreground">Clear color</Text></View>
    </View> : null}
  </Popover>;
}
