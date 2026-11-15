// Which composer holds the keyboard: the main (open thread's) composer, or a side chat's composer by its thread id.
// Opening a side chat (/side, /btw, the palette, the right panel) hands the keyboard to the child composer;
// closing the pane hands it back to the parent composer.
import { signal } from "nsh";

export const composerOwner = signal<string | null>(null);

/** The side chat composer for `threadId` takes the keyboard. */
export function focusSideComposer(threadId: string) {
  composerOwner.set(threadId);
}

/** The main composer takes the keyboard back (a side chat pane closed, or the main composer was clicked). */
export function focusMainComposer() {
  composerOwner.set(null);
}
