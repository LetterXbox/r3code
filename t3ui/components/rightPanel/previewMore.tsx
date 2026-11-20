// The browser's "more" menu and zoom pill (preview/PreviewMoreMenu.tsx, ZoomIndicator.tsx), as far as the NSH
// WebView allows: Hard reload, Zoom and the device toolbar (a sized frame) work. Appearance (colour scheme) and
// Clear cookies / cache are now wired for both server tabs (serverPreviewAdjust.ts's preview.adjust) and native
// tabs (nativePreviewAdjust.ts's capability-gated host calls, patches 0022/0024 -- UNVERIFIED, not built; every
// build today shows an error toast naming the missing patch instead of changing anything). The reference's "Open
// DevTools" row now has a native-tab equivalent, gated behind desktopHostCapabilities: patch 0025
// (third_party/nsh-host-patches/0025-gpui-webview-devtools.patch) adds webview.devtools.setInspectable (the
// public WKWebView.inspectable property, macOS 13.3+) and webview.devtools.open (the private, undocumented
// -[WKWebView _showInspector], best-effort). nativePreviewAdjust.ts's nativeDevToolsAvailable resolves once per
// host build; onOpenDevTools is only rendered when it is true, so a host without 0025 shows no row at all rather
// than a disabled placeholder claiming a capability check it cannot back. A separate preview window is likewise
// not portable (no multi-window WebView host call).
import { Accessor, effect, signal, Text, View } from "nsh";
import { Menu, MenuItem, Submenu } from "nsh/base";
import { HIcon } from "../header/HeaderIcons";
import { DIcon } from "../device/DeviceIcons";
import { useOverlayOpen } from "./nativeOcclusion";
import { Presence, presenceStyle } from "../motion/Motion";
import { zoomPillIn, zoomPillOut } from "../motion/motionTokens";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS, MENU_SEPARATOR_CLASS, MENU_SUBPOPUP_CLASS } from "../menuStyles";

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next preset zoom factor (PREVIEW zoom steps). */
export function nextZoom(current: number, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return 1;
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0]!;
}

export const zoomLabel = (factor: number) => `${Math.round(factor * 100)}%`;

export const zoomScript = (factor: number) => `document.documentElement.style.zoom = ${JSON.stringify(String(factor))}; true;`;

export type PreviewColorScheme = "system" | "light" | "dark";
/** PreviewMoreMenu.tsx COLOR_SCHEME_OPTIONS. */
const COLOR_SCHEME_OPTIONS: { value: PreviewColorScheme; label: string }[] = [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];

export function PreviewMoreMenu(props: {
  move?: { label: string; onMove: () => void } | undefined; enabled: boolean; zoom: Accessor<number>; deviceToolbar?: boolean; onToggleDeviceToolbar?: () => void; onHardReload: () => void; onZoom: (direction: "in" | "out" | "reset") => void;
  /** Server tabs (preview.adjust): the Appearance submenu and the Clear cookies / Clear cache group. */
  colorScheme?: Accessor<PreviewColorScheme>; onColorScheme?: (scheme: PreviewColorScheme) => void; onClearCookies?: () => void; onClearCache?: () => void;
  /** Native tabs only (nativePreviewAdjust.ts's nativeDevToolsAvailable): rendered only when the host build
   * carries patch 0025, so a host without it shows no row rather than one that can never do anything. */
  devToolsAvailable?: Accessor<boolean>; onOpenDevTools?: () => void;
}) {
  const open = signal(false);
  useOverlayOpen(() => open(), "browser menu");
  const item = MENU_ITEM_ROW_CLASS;
  const step = (label: string, icon: string, direction: "in" | "out") => (
    <View role="button" accessibilityLabel={label} disabled={!props.enabled} onPress={() => props.onZoom(direction)} class="size-6 items-center justify-center rounded-md border border-input hover:bg-accent"><DIcon name={icon} size={14} /></View>
  );
  return (
    <Menu
      open={open()}
      onOpenChange={(event) => open.set(event.open)}
      popupClass={MENU_POPUP_CLASS}
      trigger={<View role="button" accessibilityLabel="Preview menu" class="size-6 items-center justify-center rounded-md hover:bg-accent"><HIcon name="ellipsis-vertical" size={14} /></View>}
    >
      <MenuItem accessibilityLabel="Hard reload" disabled={!props.enabled} class={item} onSelect={props.onHardReload}><Text class="text-sm text-popover-foreground">Hard reload</Text></MenuItem>
      {/* PreviewMoreMenu.tsx:101: Move tab, before the device toolbar row. */}
      {props.move ? <MenuItem accessibilityLabel={props.move.label} class={item} onSelect={props.move.onMove}><Text class="text-sm text-popover-foreground">{props.move.label}</Text></MenuItem> : null}
      {/* The device toolbar drives the Electron preview session (previewBridge); the WebView API cannot emulate a device, so the row stays, disabled, as in the reference's non-desktop shell. */}
      <MenuItem accessibilityLabel={props.deviceToolbar ? "Hide device toolbar" : "Show device toolbar"} disabled={!props.enabled} class={item} onSelect={() => props.onToggleDeviceToolbar?.()}><Text class="text-sm text-popover-foreground">{props.deviceToolbar ? "Hide device toolbar" : "Show device toolbar"}</Text></MenuItem>
      {/* PreviewMoreMenu.tsx:105-118: Appearance submenu (radio System / Light / Dark). */}
      {props.onColorScheme ? (
        <Submenu trigger={<View class={`${item} justify-between`} accessibilityLabel="Appearance"><Text class="text-sm text-popover-foreground">Appearance</Text><HIcon name="chevron-right" size={14} /></View>}>
          <View class={MENU_SUBPOPUP_CLASS}>
            {COLOR_SCHEME_OPTIONS.map((option) => (
              <MenuItem accessibilityLabel={option.label} disabled={!props.enabled} class={item} onSelect={() => props.onColorScheme?.(option.value)}>
                <Text class="min-w-0 flex-1 text-sm text-popover-foreground">{option.label}</Text>
                {props.colorScheme?.() === option.value ? <HIcon name="check" size={14} /> : null}
              </MenuItem>
            ))}
          </View>
        </Submenu>
      ) : null}
      {/* PreviewMoreMenu.tsx's "Open DevTools" row: native tabs only, and only once nativeDevToolsAvailable
          resolves true (patch 0025) -- see the file header for why an unavailable host gets no row at all. */}
      {props.onOpenDevTools && props.devToolsAvailable?.() ? (
        <MenuItem accessibilityLabel="Open DevTools" disabled={!props.enabled} class={item} onSelect={props.onOpenDevTools}><Text class="text-sm text-popover-foreground">Open DevTools</Text></MenuItem>
      ) : null}
      <View class={MENU_SEPARATOR_CLASS} />
      {/* The reference renders this as a MenuItem (`justify-between`), so it keeps the item row's own metrics
          (min-h-7, px-2, py-1, rounded-sm) rather than a bespoke h-8/px-3 row. */}
      <View class={`${MENU_ITEM_ROW_CLASS} justify-between`} accessibilityLabel="Zoom">
        <Text class="text-sm text-popover-foreground">Zoom</Text>
        <View class="flex-row items-center gap-1">
          {step("Zoom out", "minus", "out")}
          <View class="min-w-12 items-center"><Text class="text-xs text-muted-foreground">{zoomLabel(props.zoom())}</Text></View>
          {step("Zoom in", "plus", "in")}
          {/* PreviewMoreMenu.tsx:151-160: a ghost Reset zoom button with RotateCcw after Zoom in. */}
          <View role="button" accessibilityLabel="Reset zoom" disabled={!props.enabled} onPress={() => props.onZoom("reset")} class="size-6 items-center justify-center rounded-md hover:bg-accent"><DIcon name="rotate-ccw" size={14} /></View>
        </View>
      </View>
      {/* PreviewMoreMenu.tsx:165-173: Clear cookies / Clear cache after a separator. */}
      {props.onClearCookies || props.onClearCache ? <View class={MENU_SEPARATOR_CLASS} /> : null}
      {props.onClearCookies ? <MenuItem accessibilityLabel="Clear cookies" class={item} onSelect={props.onClearCookies}><Text class="text-sm text-popover-foreground">Clear cookies</Text></MenuItem> : null}
      {props.onClearCache ? <MenuItem accessibilityLabel="Clear cache" class={item} onSelect={props.onClearCache}><Text class="text-sm text-popover-foreground">Clear cache</Text></MenuItem> : null}
    </Menu>
  );
}

const HIDE_AFTER_MS = 1500;

/** The pill that shows the zoom for a moment after it changes. */
export function ZoomIndicator(props: { zoom: Accessor<number> }) {
  const visible = signal(false);
  let last = props.zoom();
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const factor = props.zoom();
    if (Math.abs(last - factor) < 0.001) return;
    last = factor;
    visible.set(true);
    clearTimeout(timer);
    timer = setTimeout(() => visible.set(false), HIDE_AFTER_MS);
  });
  // ZoomIndicator.tsx:41: in and out with opacity and -translate-y-1 (4pt), transition-all 200ms ease-out.
  return (
    <Presence when={visible} ms={200}>{(closing) => (
      <View accessibilityLabel={`Zoom ${zoomLabel(props.zoom())}`} class="absolute right-3 top-12 z-20 rounded-full border border-border bg-popover px-2.5 py-1" style={[{ pointerEvents: "none" }, presenceStyle(zoomPillIn, zoomPillOut, () => !closing())]}>
        <Text class="text-xs font-medium text-foreground">{zoomLabel(props.zoom())}</Text>
      </View>
    )}</Presence>
  );
}
