import { Overlay, signal, View } from "nsh";
import type { ViewRef } from "nsh";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { glassOutline, glassPopover } from "./tokenColor";
import { presenceStyle } from "../motion/Motion";
import { popoverEnter, popoverExit } from "../motion/motionTokens";

/** What a component renders. */
export type Content = ReturnType<typeof View>;

/** A trigger's anchor: pass `ref` to the trigger View and `anchor()` to <Popup>. */
export function createAnchor() {
  const node = signal<ViewRef | null>(null);
  return { ref: (view: ViewRef) => { node.set(view); }, anchor: () => node() };
}

/**
 * The web app's PopoverPopup: a `rounded-lg border bg-popover shadow` panel
 * that floats over the app beside its trigger. Closing is the caller's: a press
 * outside or Escape calls `onClose`.
 */
export function Popup(props: {
  anchor: () => ViewRef | null;
  onClose: () => void;
  placement?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  class?: string;
  /** Plays PopoverPopup's enter (scale .98 and opacity, 150ms). Base UI Menu and Combobox popups have none, so off by default. */
  animated?: boolean;
  /** Set by `<Presence>` while the popup plays its exit (ui/popover.tsx:95 data-ending-style, 150ms): it no longer takes
   * input, presses outside or Escape, and stops occluding WebViews once gone. */
  closing?: () => boolean;
  children?: Content;
}) {
  // A native WebView draws above every popup, so it steps aside while this one is open.
  useOverlayOpen(true, "popup");
  const closing = () => props.closing?.() ?? false;
  const enter = props.animated ? presenceStyle(popoverEnter, popoverExit, () => !closing()) : undefined;
  return (
    <Overlay
      anchor={props.anchor()}
      placement={props.placement ?? "top"}
      align={props.align ?? "start"}
      offset={4}
      margin={8}
      onPressOutside={() => { if (!closing()) props.onClose(); }}
      onCancel={() => { if (!closing()) props.onClose(); }}
    >
      <View class={`overflow-hidden rounded-lg border shadow-lg ${props.class ?? ""}`} style={[{ backgroundColor: glassPopover(), borderColor: glassOutline() }, closing() ? { pointerEvents: "none" } : null, enter]}>
        {props.children}
      </View>
    </Overlay>
  );
}

/**
 * PopoverTrigger `openOnHover` (ui/popover.tsx users, Base UI defaults delay 300 ms, closeDelay 0): spread `hover` on the
 * trigger and on the popup's content. The popover opens `delay` ms after the pointer enters the trigger and closes
 * `closeDelay` ms after it has left; with a closeDelay above 0, moving from the trigger into the popup within it keeps the
 * popover open (with 0 it closes on leaving the trigger). A press still toggles.
 */
export function hoverOpen(setOpen: (open: boolean) => void, options: { delay?: number; closeDelay?: number } = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const later = (open: boolean, ms: number) => {
    clear();
    if (ms <= 0) { setOpen(open); return; }
    timer = setTimeout(() => { timer = null; setOpen(open); }, ms);
  };
  const hover = {
    onMouseEnter: () => later(true, options.delay ?? 300),
    onMouseLeave: () => later(false, options.closeDelay ?? 0),
  };
  return { hover, cancel: clear };
}
