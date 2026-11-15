// The "selection action" gesture of lib/selectionActions.ts (observeSelectionActions) without its DOM listeners: a menu with
// Add to chat / Copy opens once the user finishes selecting text with the mouse. The page feeds it the pointer and key events
// of its terminal and runs `onSelection` when the gesture ends with a selection (after the multi-click window for a double or
// triple click). Pure and scheduler-injected, so the timing is tested without a WebView. The page bundles this file: it must
// not import from "nsh" or from the app.

/** A double or triple click keeps selecting: wait for the next click before offering the menu. */
export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;

export type SelectionActionPoint = { x: number; y: number };

export interface SelectionActionScheduler {
  setTimeout(run: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  requestAnimationFrame(run: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
}

export function createSelectionActions(options: {
  scheduler: SelectionActionScheduler;
  onSelection: (pointer: SelectionActionPoint | null) => void;
  onDismiss: (reason: "interaction" | "cancel") => void;
}) {
  const { scheduler, onSelection, onDismiss } = options;
  let pointerDown = false;
  let gestureActive = false;
  let pointer: SelectionActionPoint | null = null;
  let timer: unknown = null;
  let frame: unknown = null;

  const cancelPending = () => {
    if (timer !== null) scheduler.clearTimeout(timer);
    if (frame !== null) scheduler.cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
  };
  const dismiss = () => {
    cancel();
    onDismiss("cancel");
  };
  const schedule = (delayMs: number) => {
    cancelPending();
    timer = scheduler.setTimeout(() => {
      timer = null;
      frame = scheduler.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delayMs);
  };

  return {
    /** Every primary pointer press, before it reaches the terminal (`inside`: the press is on the terminal). */
    pointerDown(event: { isPrimary: boolean; button: number; inside: boolean }) {
      if (!event.isPrimary) return;
      cancelPending();
      pointerDown = event.button === 0;
      gestureActive = false;
      pointer = null;
      if (event.inside) onDismiss("interaction");
    },
    /** A primary press on the terminal itself: a drag that follows is a selection gesture (not on a button, not already handled). */
    selectionStart(event: { isPrimary: boolean; button: number; defaultPrevented: boolean; onButton: boolean }) {
      if (!event.isPrimary || event.onButton) return;
      gestureActive = event.button === 0 && !event.defaultPrevented;
    },
    pointerUp(event: { isPrimary: boolean; button: number }) {
      if (event.isPrimary && event.button === 0) pointerDown = false;
    },
    mouseUp(event: { button: number; detail: number; x: number; y: number }) {
      if (event.button !== 0) return;
      pointerDown = false;
      if (!gestureActive) return;
      gestureActive = false;
      pointer = { x: event.x, y: event.y };
      schedule(event.detail >= 2 ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
    },
    keyDown(key: string) {
      if (key === "Escape") dismiss();
      else if (!pointerDown) {
        cancelPending();
        gestureActive = false;
        pointer = null;
      }
    },
    contextMenu() {
      cancel();
      onDismiss("interaction");
    },
    /** The window lost focus or resized. */
    dismiss,
    cancel,
    get pending() {
      return timer !== null || frame !== null;
    },
  };
}
