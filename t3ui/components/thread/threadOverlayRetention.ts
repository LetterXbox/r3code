// threadOverlayRetention.ts + appInit.tsx startThreadOverlayRetention: chat overlays (media previews, dialogs) are opened
// for one thread and must not outlive it. Overlay modules register here when they load; when the open thread changes
// (the port's equivalent of a resolved route) every overlay opened for another thread is dropped.
import { effect, untracked } from "nsh";

const retainers: Array<(threadKey: string | null) => void> = [];
let currentKey: () => string | null = () => null;

export function registerThreadOverlay(retain: (threadKey: string | null) => void): void {
  retainers.push(retain);
}

/** Drops every overlay opened for a thread other than `threadKey`. */
export function retainThreadOverlaysForThread(threadKey: string | null): void {
  for (const retain of retainers) retain(threadKey);
}

/** The thread an overlay opened now belongs to. */
export const overlayThreadKey = (): string | null => untracked(currentKey);

/** Follows the open thread: each change drops the overlays of the thread that was left. */
export function startThreadOverlayRetention(read: () => string | null): void {
  currentKey = read;
  effect(() => {
    const key = read();
    untracked(() => retainThreadOverlaysForThread(key));
  });
}
