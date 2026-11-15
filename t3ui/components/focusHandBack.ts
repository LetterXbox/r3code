// Focus hand-back on collapse (ui/sidebar.tsx moveFocusOutOfCollapsingSidebar, PreviewPanelShell.tsx's layout effect):
// when the sidebar or the right panel collapses while the keyboard focus is inside it, the focus goes to its toggle
// outside it, instead of dropping to nothing. Whether the focus is inside a region comes from `onFocusWithinChange`
// (host patch 0013, the core's `focus-within:` state as an event); on a host without it the event never fires, the
// region never counts as focused, and nothing moves (the old behaviour). A focused web view (a browser tab, the
// terminal) is not a focus the core sees, so a collapse from inside one hands nothing back.
import type { ViewRef } from "nsh";

export interface FocusRegion {
  /** Spread on the region's root view: `{...region.listen}` (an event the stock TS types do not list). */
  listen: object;
  /** Whether the focus is inside the region now. */
  inside(): boolean;
  /** The region was made again (its old focus went with the views it removed). */
  reset(): void;
}

export function createFocusRegion(): FocusRegion {
  let inside = false;
  return {
    listen: { onFocusWithinChange: (event: { focused?: boolean }) => { inside = event?.focused === true; } },
    inside: () => inside,
    reset: () => { inside = false; },
  };
}

/** The toggle a collapsing region gives the focus to: its view, as the latest `ref` gave it. */
export interface FocusTrigger {
  ref: (node: ViewRef | null) => void;
  focus(): boolean;
}

export function createFocusTrigger(): FocusTrigger {
  let view: ViewRef | null = null;
  return {
    ref: (node) => { view = node ?? null; },
    focus: () => {
      if (!view) return false;
      view.focus();
      return true;
    },
  };
}

/**
 * Call when `region` goes from open to collapsed: with the focus inside, the trigger takes it once the views of this
 * change are in (the trigger may only now be mounting, as the header's sidebar toggle is), and the region forgets it.
 */
export function handFocusBack(region: FocusRegion, trigger: FocusTrigger, later: (run: () => void) => void = (run) => { setTimeout(run, 0); }): boolean {
  if (!region.inside()) return false;
  region.reset();
  later(() => { trigger.focus(); });
  return true;
}

/** The sidebar (ui/sidebar.tsx) and its trigger outside it: the thread header's "Toggle main sidebar". */
export const sidebarFocus = createFocusRegion();
export const sidebarTrigger = createFocusTrigger();
/** The right panel (PreviewPanelShell.tsx) and its toggle (`[data-right-panel-toggle]`): the header's "Toggle right panel". */
export const rightPanelFocus = createFocusRegion();
export const rightPanelTrigger = createFocusTrigger();
