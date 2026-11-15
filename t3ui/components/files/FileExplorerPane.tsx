// A resizable file-tree column (files/FileExplorerPane.tsx): a left edge to drag ("Resize file explorer"), the width remembered,
// 160 to 560 wide and never so wide the file beside it drops under 256. Without `resizable` it fills the row (a folder tab).
// The edge is a keyboard stop as the web's separator is (tabIndex 0, aria-valuenow/min/max): while it has the focus
// Left/Right move it by 16 and Home/End go to the minimum and maximum. NSH has no separator role: `adjustable` with
// the value is the nearest.
import { cleanup, keymap, Overlay, signal, View } from "nsh";
import type { ViewProps } from "nsh";
import { createLiveResize } from "../rightPanel/liveResize";
import { clampExplorerWidth, EXPLORER_KEYS, EXPLORER_MIN_WIDTH, explorerKeyWidth, explorerMaxWidth, explorerWidth, setExplorerWidth } from "./explorerState";

export function FileExplorerPane(props: { resizable: boolean; rowWidth: () => number; children?: ViewProps["children"] }) {
  const max = () => explorerMaxWidth(props.rowWidth());
  const resize = createLiveResize({
    axis: "x",
    direction: -1,
    size: () => clampExplorerWidth(explorerWidth(), max()),
    clamp: (value) => clampExplorerWidth(value, max()),
    commit: (value) => setExplorerWidth(value),
  });
  const width = () => resize.live() ?? clampExplorerWidth(explorerWidth(), max());
  // The keys are bound only while the edge has the focus; `notEditing` keeps a missed blur from taking arrows from a field.
  let unbindKeys: (() => void) | null = null;
  const focused = signal(false);
  const releaseKeys = () => { unbindKeys?.(); unbindKeys = null; focused.set(false); };
  const bindKeys = () => {
    releaseKeys();
    focused.set(true);
    unbindKeys = keymap.bind(Object.fromEntries(EXPLORER_KEYS.map((key) => [key, () => setExplorerWidth(explorerKeyWidth(key, width(), max()))])), { when: "notEditing", repeat: true });
  };
  cleanup(releaseKeys);
  return (
    <View
      accessibilityLabel="File explorer"
      accessibilityValue={props.resizable ? { now: width(), text: String(width()) } : undefined}
      class={`relative min-h-0 min-w-0 flex-row bg-background ${props.resizable ? "shrink-0 border-l border-border-60" : "flex-1"}`}
      style={props.resizable ? { width: width() } : undefined}
    >
      {props.resizable ? (
        <View
          accessibilityLabel="Resize file explorer"
          role="adjustable"
          accessibilityValue={{ now: width(), min: EXPLORER_MIN_WIDTH, max: max() }}
          focusable
          onFocus={bindKeys}
          onBlur={releaseKeys}
          class="absolute inset-y-0 left-0 z-10 w-[6px]"
          style={{ cursor: "col-resize" }}
          onMouseMove={resize.follow}
          onPress={() => {}}
          onPanStart={resize.handle.onPanStart}
          onPanEnd={resize.handle.onPanEnd}
        >
          <View class={`absolute inset-y-0 left-0 w-px transition-colors duration-150 ease-in-out ${resize.live() !== null || focused() ? "bg-primary" : ""}`} />
          {resize.live() !== null ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing file explorer" style={{ cursor: "col-resize" }} onMouseMove={resize.follow} /> : null}
        </View>
      ) : null}
      <View class="min-h-0 min-w-0 flex-1">{props.children}</View>
    </View>
  );
}
