// What is drawn over and around a floating browser preview (ThreadPreviewMiniPlayer.tsx MiniPlayerShell): the ring,
// the grip with its toolbar pill (Open in right panel, Pop into separate window, Close floating preview) and the
// eight resize handles. The page itself is the panel's own web view, laid out inside the card by RightPanel.tsx.
//
// Two forms, by host. Where web views sit under the app's surface (nativeOcclusion.ts `webViewsUnderSurface`) this is
// the reference's: everything is painted over the page, the pill fades in while the pointer is on the grip. Where a
// web view is a native view above the surface nothing can be painted over the page, so the toolbar has a strip of its
// own above the page (always shown, and the grip for dragging) and the resize handles lie outside the card's edge.
import { Overlay, signal, Text, token, View } from "nsh";
import type { MouseEvent as NshMouseEvent, PanEvent } from "nsh";
import { Tooltip } from "nsh/base";
import { tokenAlpha } from "../composer/tokenColor";
import { DIcon } from "../device/DeviceIcons";
import {
  clampMiniPlayerPosition, MINI_PLAYER_CORNER_RADIUS, resizeMiniPlayer as resizedFrame,
  type MiniPlayerFrame, type MiniPlayerPosition, type MiniPlayerSize, type ResizeDirection,
} from "./miniPlayerLayout";

/** The strip above the page on a host that draws web views above the app (the toolbar's own height, h-8). */
export const MINI_PLAYER_STRIP_HEIGHT = 32;
/** The card's own edge around the page on such a host: clears the page's square corners from the card's round ones. */
export const MINI_PLAYER_STRIP_INSET = 4;

type Cursor = "ns-resize" | "ew-resize" | "nwse-resize" | "nesw-resize";

/** RESIZE_HANDLES: 8pt strips centred on each edge and 16pt squares centred on each corner. */
const RESIZE_HANDLES: readonly { direction: ResizeDirection; cursor: Cursor; over: Record<string, number>; outside: Record<string, number> }[] = [
  { direction: "north", cursor: "ns-resize", over: { left: 0, right: 0, top: -4, height: 8 }, outside: { left: 0, right: 0, top: -6, height: 6 } },
  { direction: "south", cursor: "ns-resize", over: { left: 0, right: 0, bottom: -4, height: 8 }, outside: { left: 0, right: 0, bottom: -6, height: 6 } },
  { direction: "west", cursor: "ew-resize", over: { top: 0, bottom: 0, left: -4, width: 8 }, outside: { top: 0, bottom: 0, left: -6, width: 6 } },
  { direction: "east", cursor: "ew-resize", over: { top: 0, bottom: 0, right: -4, width: 8 }, outside: { top: 0, bottom: 0, right: -6, width: 6 } },
  { direction: "northwest", cursor: "nwse-resize", over: { left: -8, top: -8, width: 16, height: 16 }, outside: { left: -8, top: -8, width: 12, height: 12 } },
  { direction: "northeast", cursor: "nesw-resize", over: { right: -8, top: -8, width: 16, height: 16 }, outside: { right: -8, top: -8, width: 12, height: 12 } },
  { direction: "southwest", cursor: "nesw-resize", over: { left: -8, bottom: -8, width: 16, height: 16 }, outside: { left: -8, bottom: -8, width: 12, height: 12 } },
  { direction: "southeast", cursor: "nwse-resize", over: { right: -8, bottom: -8, width: 16, height: 16 }, outside: { right: -8, bottom: -8, width: 12, height: 12 } },
];

function Tip(props: { text: string }) {
  return <Tooltip placement="top" class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

export function MiniPlayerChrome(props: {
  /** The card's frame on the chat canvas (what a gesture starts from). */
  frame: () => MiniPlayerFrame;
  /** The page size the card keeps the proportions of. */
  source: () => MiniPlayerSize;
  /** The chat canvas's size. */
  container: () => MiniPlayerSize;
  /** True on a host that draws web views above the app's surface: the strip form. */
  strip: boolean;
  onMove: (position: MiniPlayerPosition) => void;
  onResize: (frame: MiniPlayerFrame) => void;
  onOpenInPanel: () => void;
  onClose: () => void;
  /** DeviceMiniPlayer: a device stream has no "Pop into separate window" (the reference gives it no pill actions). */
  device?: boolean;
  /** ThreadPreviewMiniPlayer.tsx:556-576: the tab is being recorded (browserRecording): the grip's dot turns into the
   * pulsing destructive "Recording preview" status, and the pill shows the same dot first. */
  recording?: () => boolean;
}) {
  // The gesture in progress: the grip moves the card, a handle resizes it. NSH reports a pan's travel only when it ends, so
  // while one is on a window-sized overlay listens to the pointer and the card follows it (liveResize.tsx).
  const active = signal<ResizeDirection | "move" | null>(null);
  let gesture: { frame: MiniPlayerFrame; direction: ResizeDirection | null; start: { x: number; y: number } | null } | null = null;
  // Where the pointer last was over the grip or a handle, and when: a pan starts from there if it is recent (the pan
  // itself reports no position), else from the first position the overlay hears.
  let lastPointer: { x: number; y: number; at: number } | null = null;

  function apply(travel: { x: number; y: number }) {
    if (!gesture) return;
    const delta = { x: Math.round(travel.x), y: Math.round(travel.y) };
    if (gesture.direction === null) {
      props.onMove(clampMiniPlayerPosition({ x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y }, props.container(), gesture.frame));
      return;
    }
    props.onResize(resizedFrame({ start: gesture.frame, direction: gesture.direction, delta, source: props.source(), container: props.container() }));
  }
  function finish() { gesture = null; active.set(null); }
  function follow(event: NshMouseEvent) {
    const pointer = event.pagePosition;
    if (!gesture) { lastPointer = { x: pointer.x, y: pointer.y, at: Date.now() }; return; }
    if (gesture.start === null) { gesture.start = pointer; return; }
    // The button came up somewhere the pan did not report: the gesture is over.
    if (event.pressedButton === null) { finish(); return; }
    apply({ x: pointer.x - gesture.start.x, y: pointer.y - gesture.start.y });
  }
  const begin = (direction: ResizeDirection | null) => () => {
    gesture = { frame: props.frame(), direction, start: lastPointer !== null && Date.now() - lastPointer.at < 1000 ? { x: lastPointer.x, y: lastPointer.y } : null };
    active.set(direction ?? "move");
  };
  const end = (event: PanEvent) => {
    if (!gesture) return;
    if (!event.cancelled) apply(event.translation);
    finish();
  };
  const cursorOf = (which: ResizeDirection | "move") => (which === "move" ? "grabbing" : RESIZE_HANDLES.find((handle) => handle.direction === which)!.cursor);

  // The pill shows while the pointer is on the grip or on the pill, while the grip was pressed (the reference's touch tap,
  // which also serves a pointer that cannot hover) and during a drag.
  const overGrip = signal(false);
  const overPill = signal(false);
  const pillOpen = signal(false);
  const pillShown = () => props.strip || overGrip() || overPill() || pillOpen() || active() === "move";

  const button = (label: string, tip: string, icon: string, onPress: (() => void) | null) => (
    <View
      role="button"
      accessibilityLabel={label}
      disabled={onPress === null}
      tooltip={<Tip text={tip} />}
      onPress={() => { pillOpen.set(false); onPress?.(); }}
      class={`size-6 shrink-0 items-center justify-center rounded-md ${onPress === null ? "opacity-64" : "hover:bg-accent"}`}
    >
      <DIcon name={icon} size={14} />
    </View>
  );
  const pill = () => (
    <View
      testID="Floating preview toolbar"
      onMouseEnter={() => overPill.set(true)}
      onMouseLeave={() => { overPill.set(false); pillOpen.set(false); }}
      onMouseMove={follow}
      // A press on the pill itself (not on a button) puts it away again, as a second tap on the reference's grip does.
      onPress={() => pillOpen.set(false)}
      onPanStart={begin(null)}
      onPanEnd={end}
      class="h-8 flex-row items-center gap-0.5 rounded-lg border p-0.5 transition-opacity duration-150 ease-in-out"
      style={{
        cursor: active() === "move" ? "grabbing" : "grab",
        borderColor: tokenAlpha("border", 0.8),
        backgroundColor: tokenAlpha("popover", 0.92),
        boxShadow: "0 10px 15px -3px rgba(0,0,0,0.2), 0 4px 6px -4px rgba(0,0,0,0.2)",
        opacity: pillShown() ? 1 : 0,
        pointerEvents: pillShown() ? "auto" : "none",
      }}
    >
      {props.recording?.() ? <View class="size-6 shrink-0 items-center justify-center"><View class="size-2 animate-pulse rounded-full bg-destructive" /></View> : null}
      {button("Open preview in right panel", "Open in right panel", "panel-right", props.onOpenInPanel)}
      {/* The reference mirrors the page into a separate always-on-top window (apps/desktop preview Manager). This host has
          no second window to put a page in, so the control is there in its unavailable state. */}
      {props.device ? null : button("Pop preview into separate window", "Pop into separate window", "picture-in-picture-2", null)}
      {button("Close floating preview", "Close floating preview", "x", props.onClose)}
    </View>
  );

  return (
    <>
      {props.strip ? (
        // The strip is the grip: the toolbar at its right end, the rest of it drags the card.
        <View
          testID="Floating preview grip"
          role="button"
          accessibilityLabel="Move floating preview"
          onMouseMove={follow}
          onPress={() => {}}
          onPanStart={begin(null)}
          onPanEnd={end}
          class="absolute inset-x-0 top-0 flex-row items-center justify-end"
          style={{ height: MINI_PLAYER_STRIP_HEIGHT, cursor: active() === "move" ? "grabbing" : "grab" }}
        >
          {pill()}
        </View>
      ) : (
        <>
          <View class="absolute inset-0 border" style={{ borderRadius: MINI_PLAYER_CORNER_RADIUS, borderColor: tokenAlpha("border", 0.8), pointerEvents: "none" }} />
          {/* pillInset: max(8, round(radius * 0.55)) from the card's top right corner. */}
          <View
            testID="Floating preview grip"
            role="button"
            accessibilityLabel="Move floating preview"
            onMouseEnter={() => overGrip.set(true)}
            onMouseLeave={() => overGrip.set(false)}
            onMouseMove={follow}
            onPress={() => pillOpen.set(!pillOpen())}
            onPanStart={begin(null)}
            onPanEnd={end}
            class="absolute size-3 items-end"
            style={{ right: 8, top: 8, cursor: active() === "move" ? "grabbing" : "grab" }}
          >
            <View
              {...(props.recording?.() ? { accessibilityLabel: "Recording preview" } : {})}
              class={`size-2 rounded-full transition-opacity duration-150 ease-in-out ${props.recording?.() ? "animate-pulse" : ""}`}
              style={{ backgroundColor: props.recording?.() ? String(token("destructive")) : tokenAlpha("foreground", 0.25), opacity: pillShown() ? 0 : 1, borderWidth: 1, borderColor: tokenAlpha("background", 0.7) }}
            />
          </View>
          <View class="absolute" style={{ right: 8, top: 8, pointerEvents: "box-none" }}>{pill()}</View>
        </>
      )}
      {RESIZE_HANDLES.map((handle) => (
        <View
          testID={`Resize floating preview ${handle.direction}`}
          role="button"
          accessibilityLabel={`Resize floating preview ${handle.direction}`}
          focusable={false}
          onMouseMove={follow}
          onPress={() => {}}
          onPanStart={begin(handle.direction)}
          onPanEnd={end}
          class="absolute"
          style={{ ...(props.strip ? handle.outside : handle.over), cursor: handle.cursor }}
        />
      ))}
      {active() !== null
        ? <Overlay class="inset-0 z-50" accessibilityLabel="Moving floating preview" style={{ cursor: cursorOf(active()!) }} onMouseMove={follow} />
        : null}
    </>
  );
}
