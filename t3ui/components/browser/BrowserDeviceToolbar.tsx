// BrowserDeviceToolbar.tsx: device preset, width and height, aspect lock, rotate and close.
import { signal, Text, View } from "nsh";
import { Input, Menu, MenuItem, Tooltip } from "nsh/base";
import { DIcon } from "../device/DeviceIcons";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { codeTextStyle } from "../../typography";
import { toolbarCustomSize, toolbarTypedSize, presetLabel, rotateViewport, selectViewport, type ToolbarDraft, VIEWPORT_PRESETS, type ViewportSetting } from "./viewportLogic";

type Sized = Exclude<ViewportSetting, { kind: "fill" }>;

export function BrowserDeviceToolbar(props: { setting: () => Sized; ratio: () => number | null; width?: () => number; onChange: (setting: ViewportSetting, ratio: number | null) => void; onClose: () => void }) {
  const draft = signal<ToolbarDraft | null>(null);
  const menuOpen = signal(false);
  useOverlayOpen(() => menuOpen(), "browser device menu");
  const width = () => props.width?.() ?? 1000;
  const shown = (): ToolbarDraft => draft() ?? { width: String(props.setting().width), height: String(props.setting().height) };
  const custom = () => toolbarCustomSize(shown(), props.ratio());
  // applyCustomSize: commits the typed size, a no-op when it is invalid or unchanged.
  const commit = () => {
    const d = draft();
    draft.set(null);
    if (!d) return;
    const size = toolbarCustomSize(d, props.ratio());
    if (size.valid && (size.width !== props.setting().width || size.height !== props.setting().height)) props.onChange({ kind: "freeform", width: size.width, height: size.height }, props.ratio());
  };
  // The reference commits when the focus leaves the whole toolbar (its onBlur checks relatedTarget), so tabbing from width
  // to height keeps editing. NSH reports focus per field: a blur commits unless the other field takes the focus right after.
  let focused = 0;
  const onFocus = () => { focused += 1; };
  const onBlur = () => { focused -= 1; setTimeout(() => { if (focused <= 0) commit(); }, 0); };
  const type = (axis: "width" | "height", value: string) => draft.set(toolbarTypedSize(axis, value, draft(), props.setting(), props.ratio()));
  const valid = () => custom().valid;
  const button = (label: string, icon: string, onPress: () => void, pressed?: boolean, disabled?: boolean, tooltip?: string) => (
    <View role="button" accessibilityLabel={label} accessibilityState={pressed === undefined ? {} : { pressed }} disabled={disabled} onPress={onPress} class={`size-6 shrink-0 items-center justify-center rounded-md ${pressed ? "bg-secondary" : "hover:bg-accent"} ${disabled ? "opacity-40" : ""}`}
      {...(tooltip ? { tooltip: <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{tooltip}</Text></Tooltip> } : {})}><DIcon name={icon} size={14} /></View>
  );
  // Input size="compact" font="mono", aria-invalid: border-destructive when the typed size is out of range.
  const field = () => `h-6 ${width() >= 360 ? "w-14" : "w-13"} rounded-md border ${valid() ? "border-input" : "border-destructive"} bg-background px-1 text-xs text-foreground`;
  const sizeInput = (axis: "width" | "height") => (
    <Input accessibilityLabel={axis === "width" ? "Viewport width" : "Viewport height"} keyboardType="number-pad" maxLength={4} value={shown()[axis]} style={codeTextStyle()}
      onFocus={() => { onFocus(); if (!draft()) draft.set(shown()); }} onBlur={onBlur} onChange={(e) => type(axis, e.value)} onSubmit={commit} class={field()} />
  );
  // rotate: a typed-but-uncommitted valid size rotates instead of the committed one.
  const rotate = () => {
    const size = custom();
    const typed = draft() !== null && size.valid && (size.width !== props.setting().width || size.height !== props.setting().height);
    const source: Sized = typed ? { kind: "freeform", width: size.width, height: size.height } : props.setting();
    draft.set(null);
    const next = rotateViewport(source, props.ratio());
    props.onChange(next.setting, next.ratio);
  };
  return (
    <View class="h-[38px] shrink-0 flex-row items-center gap-0.5 border-b border-border-70 bg-background px-1.5" accessibilityLabel="Browser device toolbar">
      {width() >= 560 ? <Text class="mr-0.5 shrink-0 text-2xs font-medium text-muted-foreground">Dimensions</Text> : null}
      <Menu
        open={menuOpen()}
        onOpenChange={trackOpenChange(menuOpen)}
        popupClass="max-h-80 min-w-[260px] rounded-lg border border-border bg-popover-84 p-1"
        trigger={<View role="button" accessibilityLabel="Browser device preset" class={`h-6 ${width() >= 440 ? "w-36" : "w-24"} shrink-0 flex-row items-center justify-between gap-1 rounded-md px-2 hover:bg-accent`}><Text class="truncate text-xs text-foreground">{presetLabel(props.setting())}</Text><DIcon name="chevron-down" size={12} /></View>}
      >
        <MenuItem accessibilityLabel="Responsive" class="min-h-7 flex-row items-center rounded-sm px-2 hover:bg-accent" onSelect={() => { const next = selectViewport("responsive", props.setting()); if (next) props.onChange(next.setting, props.ratio()); }}><Text class="text-sm text-popover-foreground">Responsive</Text></MenuItem>
        <Text class="px-2 py-1 text-xs text-muted-foreground">Standard</Text>
        {VIEWPORT_PRESET_ITEMS(props)}
      </Menu>
      {sizeInput("width")}
      <Text class="text-xs text-muted-foreground">×</Text>
      {sizeInput("height")}
      {button(props.ratio() === null ? "Lock viewport aspect ratio" : "Unlock viewport aspect ratio", props.ratio() === null ? "unlink-2" : "link-2", () => props.onChange(props.setting(), props.ratio() === null ? custom().width / custom().height : null), props.ratio() !== null, !valid(), props.ratio() === null ? "Lock aspect ratio" : "Unlock aspect ratio")}
      {button("Rotate viewport", "screen-rotation", rotate)}
      <View class="flex-1" />
      {button("Close device toolbar", "x", props.onClose)}
    </View>
  );
}

function VIEWPORT_PRESET_ITEMS(props: { setting: () => Sized; ratio: () => number | null; onChange: (setting: ViewportSetting, ratio: number | null) => void }) {
  return VIEWPORT_PRESETS.map((preset) => (
    <MenuItem accessibilityLabel={preset.label} class="min-h-7 flex-row items-center justify-between gap-5 rounded-sm px-2 hover:bg-accent" onSelect={() => { const next = selectViewport(preset.id, props.setting()); if (next && typeof next.aspect === "number") props.onChange(next.setting, props.ratio() === null ? null : next.aspect); }}>
      <Text class="text-sm text-popover-foreground">{preset.label}</Text><Text class="text-xs text-muted-foreground">{preset.detail}</Text>
    </MenuItem>
  ));
}
