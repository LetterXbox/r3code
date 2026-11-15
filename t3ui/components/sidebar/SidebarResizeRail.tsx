// SidebarRail: a 16pt drag edge on the sidebar's right side with a 2pt line that shows on hover
// (ui/sidebar.tsx). The width follows the pointer while it is down and is saved when it lifts.
// NSH reports a pan's travel only when it ends, so while a pan is on a window-sized overlay
// listens for the pointer and the width follows it; the pan's own travel settles the final width.
import { Overlay, signal, Text, View, windowSize } from "nsh";
import { Tooltip } from "nsh/base";
import type { MouseEvent as NshMouseEvent, PanEvent } from "nsh";
import {
  commitSidebarWidth,
  draggedSidebarWidth,
  resetSidebarWidth,
  setLiveSidebarWidth,
  sidebarWidth,
  sidebarWidthDragging,
} from "./sidebarWidth";

const hovered = signal(false);
let startWidth = 0;
let startPointer: number | null = null;
let lastPointer: number | null = null;

function follow(event: NshMouseEvent) {
  const pointer = event.pagePosition.x;
  if (!sidebarWidthDragging()) {
    lastPointer = pointer;
    return;
  }
  if (startPointer === null) {
    startPointer = pointer;
    return;
  }
  // The button came up somewhere the pan did not report: the drag is over.
  if (event.pressedButton === null) {
    endDrag(sidebarWidth());
    return;
  }
  setLiveSidebarWidth(draggedSidebarWidth(startWidth, pointer - startPointer, windowSize().width));
}

function endDrag(width: number) {
  if (!sidebarWidthDragging()) return;
  startPointer = null;
  // A press that did not move the edge is not a resize: the saved width is only what the user dragged.
  if (Math.abs(width - startWidth) < 1) {
    setLiveSidebarWidth(null);
    return;
  }
  commitSidebarWidth(width);
}

export function SidebarResizeRail() {
  return (
    <View
      accessibilityLabel="Resize Sidebar"
      role="button"
      focusable={false}
      class="absolute inset-y-0 right-0 w-4"
      style={{ cursor: "col-resize" }}
      tooltip={<Tooltip placement="right" class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">Drag to resize sidebar</Text></Tooltip>}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onMouseMove={follow}
      onPress={(event) => { if (event.clickCount >= 2) resetSidebarWidth(); }}
      onPanStart={() => {
        startWidth = sidebarWidth();
        startPointer = lastPointer;
        setLiveSidebarWidth(startWidth);
      }}
      onPanEnd={(event: PanEvent) => {
        if (!sidebarWidthDragging()) return;
        if (event.cancelled) {
          startPointer = null;
          setLiveSidebarWidth(null);
          return;
        }
        endDrag(draggedSidebarWidth(startWidth, event.translation.x, windowSize().width));
      }}
    >
      <View
        class={`absolute inset-y-0 right-0 w-[2px] ${hovered() || sidebarWidthDragging() ? "bg-sidebar-border" : "bg-transparent"}`}
      />
      <SidebarResizeOverlay />
    </View>
  );
}

/** Window-sized listener rendered while a drag is on, so the width follows the pointer past the edge. */
function SidebarResizeOverlay() {
  return <>{sidebarWidthDragging()
    ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing sidebar" style={{ cursor: "col-resize" }} onMouseMove={follow} />
    : null}</>;
}
