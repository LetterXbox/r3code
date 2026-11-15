// Live drag-resize for the right panel and the terminal drawer, built the way the sidebar's
// resize rail is (sidebar/SidebarResizeRail.tsx). NSH reports a pan's travel only when it ends,
// so while a pan is on, a window-sized overlay listens to the pointer and the size follows it;
// the pan's own travel settles the final size. The web writes the size on every pointer move
// (usePreviewPanelInlineSize.ts, ThreadTerminalDrawer.tsx handleResizePointerMove) and commits on release.
import { effect, lifecycle, Overlay, signal, untracked } from "nsh";
import type { Accessor, MouseEvent as NshMouseEvent, PanEvent } from "nsh";

/** The size a drag gives: `start` moved by the pointer's travel, signed by `direction`, clamped. */
export function resizedSize(input: { start: number; startPointer: number; pointer: number; direction: 1 | -1; clamp: (size: number) => number }): number {
  return input.clamp(input.start + input.direction * (input.pointer - input.startPointer));
}

export interface LiveResizeOptions {
  axis: "x" | "y";
  /** -1 when dragging toward the origin grows the size (a right panel's left edge, a bottom drawer's top edge). */
  direction: 1 | -1;
  size: () => number;
  clamp: (size: number) => number;
  /** Called once, when the drag ends. */
  commit: (size: number) => void;
}

export interface LiveResize {
  /** The size while a drag is in progress, else null. */
  live: Accessor<number | null>;
  /** The edge's handlers (RightPanel.tsx writes them out on the edge itself, as the sidebar's rail does). */
  handle: {
    style: { cursor: "col-resize" | "row-resize" };
    onMouseMove: (event: NshMouseEvent) => void;
    onPress: () => void;
    onPanStart: (event: PanEvent) => void;
    onPanEnd: (event: PanEvent) => void;
  };
  /** Render beside the edge: the window-sized listener that exists only while a drag is on. */
  overlay: () => ReturnType<typeof Overlay> | null;
  /** The pointer listener, the same function the overlay and the edge's onMouseMove call. */
  follow: (event: NshMouseEvent) => void;
  /** Ends a drag at once, restoring the size it started from. */
  cancel: () => void;
}

/** useResizeDrag.ts: a drag counts as a resize once the pointer has travelled more than 2 px from where it went down. */
export const RESIZE_MOVE_THRESHOLD = 2;
export const resizeMoved = (travel: number): boolean => Math.abs(travel) > RESIZE_MOVE_THRESHOLD;

export function createLiveResize(options: LiveResizeOptions): LiveResize {
  const live = signal<number | null>(null);
  const cursor = options.axis === "x" ? ("col-resize" as const) : ("row-resize" as const);
  let startSize = 0;
  let startPointer: number | null = null;
  let lastPointer: number | null = null;
  let moved = false;
  const coordinate = (point: { x: number; y: number }) => (options.axis === "x" ? point.x : point.y);
  const sizeFor = (travel: number) => options.clamp(startSize + options.direction * travel);

  function finish(size: number, cancelled: boolean) {
    if (live() === null) return;
    startPointer = null;
    live.set(null);
    // A press that never travelled past the threshold is not a resize (useResizeDrag.ts `moved`).
    if (!cancelled && moved && size !== startSize) options.commit(size);
  }

  function cancel() { finish(startSize, true); }

  // useResizeDrag.ts: leaving the window mid-drag (window blur) commits where the pointer was. The host reports the
  // window losing the focus as lifecycle() "inactive" (or "background").
  effect(() => {
    if (lifecycle() === "active") return;
    untracked(() => { const size = live(); if (size !== null) { moved = moved || size !== startSize; finish(size, false); } });
  });

  // Exactly SidebarResizeRail's follow().
  function follow(event: NshMouseEvent) {
    const pointer = coordinate(event.pagePosition);
    if (live() === null) { lastPointer = pointer; return; }
    if (startPointer === null) { startPointer = pointer; return; }
    // The button came up somewhere the pan did not report: the drag is over.
    if (event.pressedButton === null) { finish(live() ?? startSize, false); return; }
    if (resizeMoved(pointer - startPointer)) moved = true;
    live.set(resizedSize({ start: startSize, startPointer, pointer, direction: options.direction, clamp: options.clamp }));
  }

  const onPanStart = () => {
    startSize = options.size();
    startPointer = lastPointer;
    moved = false;
    live.set(startSize);
  };
  const onPanEnd = (event: PanEvent) => {
    if (live() === null) return;
    if (event.cancelled) { startPointer = null; live.set(null); return; }
    if (resizeMoved(coordinate(event.translation))) moved = true;
    finish(sizeFor(coordinate(event.translation)), false);
  };

  return {
    live,
    follow,
    handle: {
      style: { cursor },
      onMouseMove: follow,
      // A press handler makes the edge a press target (the sidebar's rail has one, and resizes).
      onPress: () => {},
      onPanStart,
      onPanEnd,
    },
    cancel,
    overlay: () => (live() !== null ? <Overlay class="inset-0 z-50" accessibilityLabel={`Resizing ${options.axis === "x" ? "panel" : "drawer"}`} style={{ cursor }} onMouseMove={follow} /> : null),
  };
}
