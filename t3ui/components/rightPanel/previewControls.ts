// What the browser tab in front offers to commands (preview.focusUrl, preview.zoomIn / zoomOut / reset): the
// PreviewSurface registers while it is the active tab, the commands call these. The command registry belongs
// to another module; these are the functions it binds.
import { nextZoom } from "./previewMore";
import { currentPanelKey } from "./panelState";
import { canOperatePreview } from "./previewScope";

export interface PreviewControls {
  focusUrl(): void;
  zoomBy(direction: "in" | "out" | "reset"): void;
  /** Whether the tab is the one in front (a background browser tab does not answer). Default true. */
  isActive?: () => boolean;
}

const stack: PreviewControls[] = [];

/** Registers a browser tab's controls; the most recently registered live one answers. Returns the release. */
export function registerPreviewControls(controls: PreviewControls): () => void {
  stack.push(controls);
  return () => {
    const index = stack.lastIndexOf(controls);
    if (index >= 0) stack.splice(index, 1);
  };
}

const active = () => {
  for (let index = stack.length - 1; index >= 0; index--) if (stack[index]!.isActive?.() ?? true) return stack[index]!;
  return null;
};

/**
 * previewCommand (chatRouteCommands.ts): the command claims its key on a thread, and only acts when the environment grants the
 * preview operate scope. True means the key was handled; false lets it fall through (no thread, or no browser tab to answer).
 */
function previewCommand(run: (controls: PreviewControls) => void): boolean {
  if (currentPanelKey() === null) return false;
  if (!canOperatePreview()) return true;
  const controls = active();
  if (controls) run(controls);
  return controls !== null;
}

/** Focuses the address field of the browser tab in front; false when no browser tab is open. */
export function focusPreviewUrl(): boolean { return previewCommand((controls) => controls.focusUrl()); }
export function previewZoomIn(): boolean { return previewCommand((controls) => controls.zoomBy("in")); }
export function previewZoomOut(): boolean { return previewCommand((controls) => controls.zoomBy("out")); }
export function previewResetZoom(): boolean { return previewCommand((controls) => controls.zoomBy("reset")); }

/** Applies a zoom command to a tab's own zoom factor. */
export function zoomedFactor(current: number, direction: "in" | "out" | "reset"): number { return nextZoom(current, direction); }
