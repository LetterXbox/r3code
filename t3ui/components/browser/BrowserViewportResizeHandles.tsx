// BrowserViewportResizeHandles.tsx + useBrowserViewportResize.ts: five rails around a sized browser page (west, east,
// south, southwest, southeast), each a 10 pt button with a grip, its resize cursor and the label "Resize browser
// viewport from <edge>. Use arrow keys to resize.". Dragging one resizes the page live and shows a floating "W × H"
// readout; the size commits as a freeform viewport on release, a cancelled drag (or a release where it started) changes
// nothing. On a focused rail the arrows on its axes resize by 10 pt (Shift: 50 pt), committed 150 ms after the last key.
//
// NSH reports a pan's travel only when it ends, so while a drag is on a window-sized Overlay follows the pointer
// (SidebarResizeRail.tsx does the same). The drag registers with the occlusion registry: a host that draws WebViews
// under the app surface (webview.underSurface) keeps the page live under the overlay; the stock host hides the page
// while the drag is on, so the overlay can hear the pointer.
import { cleanup, keymap, Overlay, signal, Text, untracked, View } from "nsh";
import type { MouseEvent as NshMouseEvent, PanEvent } from "nsh";
import { registerOverlay } from "../rightPanel/nativeOcclusion";
import { resizeFreeformViewport, resizeViewportFromRail, VIEWPORT_RESIZE_RAIL_SIZE, type ViewportResizeDirection, type ViewportSetting } from "./viewportLogic";

type Size = { width: number; height: number };
export type ViewportFrame = { x: number; y: number; width: number; height: number };
type Handle = { direction: ViewportResizeDirection; label: string; kind: "vertical" | "horizontal" | "corner"; cursor: "ew-resize" | "ns-resize" | "nesw-resize" | "nwse-resize"; mirror?: boolean };

export const KEYBOARD_RESIZE_COMMIT_DELAY_MS = 150;

export const VIEWPORT_RESIZE_HANDLES: readonly Handle[] = [
  { direction: "west", label: "Resize browser viewport from left edge", kind: "vertical", cursor: "ew-resize" },
  { direction: "east", label: "Resize browser viewport from right edge", kind: "vertical", cursor: "ew-resize" },
  { direction: "south", label: "Resize browser viewport from bottom edge", kind: "horizontal", cursor: "ns-resize" },
  { direction: "southwest", label: "Resize browser viewport from bottom-left corner", kind: "corner", cursor: "nesw-resize", mirror: true },
  { direction: "southeast", label: "Resize browser viewport from bottom-right corner", kind: "corner", cursor: "nwse-resize" },
];

/** The handle's box around the page frame (BrowserViewportResizeHandles.tsx styles). */
export function handleBox(direction: ViewportResizeDirection, frame: ViewportFrame): ViewportFrame {
  const rail = VIEWPORT_RESIZE_RAIL_SIZE;
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  switch (direction) {
    case "west": return { x: frame.x - rail, y: frame.y, width: rail, height: frame.height };
    case "east": return { x: right, y: frame.y, width: rail, height: frame.height };
    case "south": return { x: frame.x, y: bottom, width: frame.width, height: rail };
    case "southwest": return { x: frame.x - rail, y: bottom, width: rail, height: rail };
    default: return { x: right, y: bottom, width: rail, height: rail };
  }
}

/** handleResizeKeyDown: the delta an arrow key gives a rail, or null when the key is not on that rail's axes. */
export function keyboardResizeDelta(direction: ViewportResizeDirection, key: "left" | "right" | "up" | "down", shift: boolean, zoomFactor = 1): { x: number; y: number } | null {
  const controlsWidth = direction.includes("east") || direction.includes("west");
  const controlsHeight = direction.includes("north") || direction.includes("south");
  const step = (shift ? 50 : 10) * (Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1);
  if (key === "left" && controlsWidth) return { x: -step, y: 0 };
  if (key === "right" && controlsWidth) return { x: step, y: 0 };
  if (key === "up" && controlsHeight) return { x: 0, y: -step };
  if (key === "down" && controlsHeight) return { x: 0, y: step };
  return null;
}

/**
 * The resize state of one browser tab: `effective()` is the setting the page is laid out at (the live drag size while
 * one is on), `handles(frame)` the rails and readout around the page's frame.
 */
export function createViewportResize(options: {
  setting: () => ViewportSetting;
  ratio: () => number | null;
  /** The room the page can take (inside the rails, under the device toolbar). */
  available: () => Size;
  onCommit: (size: Size) => void;
}) {
  const live = signal<(Size & { direction: ViewportResizeDirection }) | null>(null);
  const dragging = signal(false);
  let start: Size | null = null;
  let direction: ViewportResizeDirection = "southeast";
  let startPointer: { x: number; y: number } | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  let releaseOverlay: (() => void) | null = null;
  let keyTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseKeys: (() => void) | null = null;

  const current = (): Size | null => {
    const setting = untracked(options.setting);
    return setting.kind === "fill" ? null : { width: setting.width, height: setting.height };
  };
  const effective = (): ViewportSetting => {
    const drag = live();
    return drag ? { kind: "freeform", width: drag.width, height: drag.height } : options.setting();
  };
  const clearKeyTimer = () => { if (keyTimer !== null) clearTimeout(keyTimer); keyTimer = null; };
  const endOverlay = () => { releaseOverlay?.(); releaseOverlay = null; dragging.set(false); startPointer = null; };

  function finish(size: Size | null) {
    const from = start;
    endOverlay();
    start = null;
    live.set(null);
    if (!size || !from || (size.width === from.width && size.height === from.height)) return;
    options.onCommit(size);
  }
  function railSize(delta: { x: number; y: number }): Size | null {
    if (!start) return null;
    return resizeViewportFromRail(start, delta, untracked(options.available), 1, direction, untracked(options.ratio));
  }
  function follow(event: NshMouseEvent) {
    const pointer = event.pagePosition;
    if (!dragging()) { lastPointer = pointer; return; }
    if (startPointer === null) { startPointer = pointer; return; }
    // The button came up somewhere the pan did not report: the drag is over at the size it shows.
    if (event.pressedButton === null) { const drag = untracked(live); finish(drag ? { width: drag.width, height: drag.height } : null); return; }
    const next = railSize({ x: pointer.x - startPointer.x, y: pointer.y - startPointer.y });
    if (next) live.set({ ...next, direction });
  }
  /** A button release the pan did not report (it lands on the overlay that appeared under the pointer): end at the shown size. */
  function settle() {
    if (!untracked(dragging)) return;
    const drag = untracked(live);
    finish(drag ? { width: drag.width, height: drag.height } : null);
  }
  function begin(next: ViewportResizeDirection) {
    const size = current();
    if (!size) return;
    clearKeyTimer();
    direction = next;
    start = size;
    startPointer = lastPointer;
    live.set({ ...size, direction });
    dragging.set(true);
    releaseOverlay?.();
    releaseOverlay = registerOverlay("browser viewport resize");
  }
  function end(event: PanEvent) {
    if (!untracked(dragging)) return;
    if (event.cancelled) { endOverlay(); start = null; live.set(null); return; }
    finish(railSize(event.translation));
  }
  function keyResize(handle: ViewportResizeDirection, key: "left" | "right" | "up" | "down", shift: boolean) {
    const drag = untracked(live);
    const base = drag ?? current();
    if (!base || untracked(dragging)) return;
    const delta = keyboardResizeDelta(handle, key, shift);
    if (!delta) return;
    const next = resizeFreeformViewport(base, delta, 1, handle, untracked(options.ratio));
    if (next.width === base.width && next.height === base.height) return;
    live.set({ ...next, direction: handle });
    clearKeyTimer();
    keyTimer = setTimeout(() => {
      keyTimer = null;
      const latest = untracked(live);
      live.set(null);
      if (latest) options.onCommit({ width: latest.width, height: latest.height });
    }, KEYBOARD_RESIZE_COMMIT_DELAY_MS);
  }
  function focusKeys(handle: ViewportResizeDirection) {
    releaseKeys?.();
    const bind: Record<string, () => void> = {};
    for (const key of ["left", "right", "up", "down"] as const) {
      bind[key] = () => keyResize(handle, key, false);
      bind[`shift+${key}`] = () => keyResize(handle, key, true);
    }
    releaseKeys = keymap.bind(bind, { repeat: true });
  }
  const blurKeys = () => { releaseKeys?.(); releaseKeys = null; };
  cleanup(() => { clearKeyTimer(); blurKeys(); endOverlay(); });

  function Grip(props: { kind: Handle["kind"]; mirror?: boolean; active: boolean; hovered: boolean }) {
    const tone = props.active || props.hovered ? "bg-foreground" : "bg-muted-foreground-70";
    if (props.kind === "vertical") return <View class="flex-row gap-px"><View class={`h-6 w-px rounded-full ${tone}`} /><View class={`h-6 w-px rounded-full ${tone}`} /></View>;
    if (props.kind === "horizontal") return <View class="gap-px"><View class={`h-px w-6 rounded-full ${tone}`} /><View class={`h-px w-6 rounded-full ${tone}`} /></View>;
    return (
      <View class="relative size-3" style={props.mirror ? { transform: [{ scaleX: -1 }] } : undefined}>
        <View class={`absolute left-0 h-px w-3 rounded-full ${tone}`} style={{ bottom: 3, transform: [{ rotate: "-45deg" }] }} />
        <View class={`absolute h-px w-2 rounded-full ${tone}`} style={{ bottom: 0, left: 5, transform: [{ rotate: "-45deg" }] }} />
      </View>
    );
  }

  function Rail(props: { handle: Handle; frame: () => ViewportFrame }) {
    const hovered = signal(false);
    const box = () => handleBox(props.handle.direction, props.frame());
    return (
      <View
        role="button"
        accessibilityLabel={`${props.handle.label}. Use arrow keys to resize.`}
        class={`absolute items-center justify-center ${props.handle.kind === "corner" ? "z-30" : "z-20"}`}
        style={{ left: box().x, top: box().y, width: box().width, height: box().height, cursor: props.handle.cursor }}
        desktop={{ windowDrag: false }}
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
        onMouseMove={follow}
        onFocus={() => focusKeys(props.handle.direction)}
        onBlur={blurKeys}
        onPanStart={() => begin(props.handle.direction)}
        onPanEnd={end}
      >
        <Grip kind={props.handle.kind} mirror={props.handle.mirror} active={live()?.direction === props.handle.direction} hovered={hovered()} />
      </View>
    );
  }

  /** The rails, the readout while a resize is on, and the pointer-following overlay while a drag is on. */
  function Handles(props: { frame: () => ViewportFrame }) {
    return (
      <>
        {VIEWPORT_RESIZE_HANDLES.map((handle) => <Rail handle={handle} frame={props.frame} />)}
        {live() ? (
          <View class="absolute z-40 items-center" style={{ left: props.frame().x, top: props.frame().y + 10, width: props.frame().width, pointerEvents: "none" }} accessibilityElementsHidden>
            <View class="rounded-md border border-border-70 bg-background px-2 py-1 shadow-md">
              <Text class="text-2xs font-medium tabular-nums text-foreground">{`${live()!.width} × ${live()!.height}`}</Text>
            </View>
          </View>
        ) : null}
        {dragging() ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing browser viewport" style={{ cursor: VIEWPORT_RESIZE_HANDLES.find((handle) => handle.direction === direction)?.cursor ?? "nwse-resize" }} onMouseMove={follow} onPressUp={settle} onPress={settle} /> : null}
      </>
    );
  }

  /** `resizeByKey` is what a focused rail's arrow does (exposed for tests). */
  return { effective, live, dragging, Handles, resizeByKey: keyResize };
}
