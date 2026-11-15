import { cleanup, signal, Text, View } from "nsh";
import { ColorArea, ColorField, ColorPicker, ColorSlider, Popover } from "nsh/base";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { DialogInput } from "../../components/DialogInput";
import { themeColorToHex } from "./themePalette";

/** Keep a theme color's alpha when editing its RGB channels, as T3's picker does. */
export function themePickerColor(value: string, source: string): string {
  const color = (themeColorToHex(value) ?? "#000000").slice(0, 7);
  const original = themeColorToHex(source) ?? "";
  const alpha = original.length === 9 ? original.slice(7) : "";
  return color + (alpha === "ff" ? "" : alpha);
}

export function themePickerRgb(value: string): string {
  const hex = (themeColorToHex(value) ?? "#000000").slice(1, 7);
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(", ");
}

export function themePickerRgbToHex(value: string): string | null {
  const channels = value.trim().replace(/^rgb\(\s*/i, "").replace(/\s*\)$/, "").split(/[,\s]+/).filter(Boolean).map(Number);
  return channels.length === 3 && channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
    ? `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}` : null;
}

export function ThemeColorPicker(props: { label: string; value: () => string; onChange: (value: string) => void; onEditStart?: () => void; onEditCancel?: () => void; onOpenChange?: (open: boolean) => void }) {
  const open = signal(false);
  const preview = signal<string | null>(null);
  const rgbDraft = signal<string | null>(null);
  let original = "";
  let cancelled = false;
  let pending: string | null = null;
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const value = pending;
    pending = null;
    if (value !== null && !cancelled) props.onChange(value);
  };
  cleanup(() => { if (frame !== null) cancelAnimationFrame(frame); pending = null; });
  useOverlayOpen(() => open(), "theme color picker");
  const current = () => preview() ?? props.value();
  const change = (value: string) => {
    if (cancelled) return;
    const next = themePickerColor(value, original);
    preview.set(next);
    pending = next;
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; flush(); });
  };
  return (
    <Popover open={open()} onOpenChange={(event) => {
      if (event.open) { original = props.value(); cancelled = false; preview.set(null); rgbDraft.set(null); props.onEditStart?.(); }
      else {
        cancelled = event.reason === "cancel";
        flush();
        if (cancelled) { if (props.onEditCancel) props.onEditCancel(); else props.onChange(original); }
        preview.set(null); rgbDraft.set(null);
      }
      open.set(event.open);
      props.onOpenChange?.(event.open);
    }} placement="bottom" align="end" offset={10} popupClass="w-72 overflow-hidden rounded-lg border border-border bg-popover-84"
      trigger={<View role="button" accessibilityLabel={`Choose ${props.label} color`} class="size-6 shrink-0 rounded-full border border-border-70" style={{ backgroundColor: themeColorToHex(props.value()) ?? "#00000000" }} />}>
      <ColorPicker value={(themeColorToHex(current()) ?? "#000000").slice(0, 7)} onChange={(event) => change(event.value)} onChangeEnd={(event) => { change(event.value); flush(); }}>
        <View class="flex-row items-center justify-between border-b border-border-70 px-4 py-3">
          <View class="min-w-0 flex-1"><Text class="truncate text-xs font-semibold text-foreground">{props.label}</Text><Text class="text-2xs text-muted-foreground">Choose a color</Text></View>
          <View class="size-7 shrink-0 rounded-full" style={{ backgroundColor: themeColorToHex(current()) ?? "#000000" }} />
        </View>
        <View class="gap-3 p-3">
          <ColorArea accessibilityLabel={`${props.label} color`} class="h-36 w-full" panelClass="h-36 w-full" thumbClass="size-3 rounded-full border-2 border-white" />
          <ColorSlider channel="hue" accessibilityLabel={`${props.label} hue`} class="h-4 w-full" trackClass="h-2.5 w-full rounded-full" thumbClass="size-4 rounded-full border-2 border-white" />
          <View class="flex-row gap-2">
            <View class="min-w-0 flex-1 gap-1"><Text class="px-1 text-3xs font-semibold text-muted-foreground">HEX</Text><ColorField accessibilityLabel={`${props.label} picker hex value`} format="hex" class="h-8 w-full rounded-lg border border-input bg-background px-2 font-mono text-xs text-foreground" /></View>
            <View class="min-w-0 flex-1 gap-1"><Text class="px-1 text-3xs font-semibold text-muted-foreground">RGB</Text><DialogInput accessibilityLabel={`${props.label} picker RGB value`} value={rgbDraft() ?? themePickerRgb(current())} onChange={(event) => { rgbDraft.set(event.value); const value = themePickerRgbToHex(event.value); if (value !== null) change(value); }} onBlur={() => rgbDraft.set(null)} onSubmit={() => rgbDraft.set(null)} class="h-8 w-full rounded-lg border border-input bg-background px-2 font-mono text-xs text-foreground" /></View>
          </View>
        </View>
      </ColorPicker>
    </Popover>
  );
}
