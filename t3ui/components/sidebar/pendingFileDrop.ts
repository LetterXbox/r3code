// A file dropped on a sidebar row (queuePendingFileDrop in the web's composerDraftStore): the row opens its
// thread and the files wait here until that thread's composer is up to stage them. A drop that never reaches
// its thread is cleared, so a late composer never receives files meant for another.
import { signal } from "nsh";

export interface PendingFileDrop { id: number; threadId: string; uris: string[] }

// sidebarPendingFileDropStore.ts:21-54: drops queue per thread (several rows can be dropped on before a composer is up);
// the composer takes every waiting drop of its thread at once.
const pending = signal<PendingFileDrop[]>([]);
let counter = 0;

/** The drops the composer of `threadId` should stage next, merged into one (null when none waits). */
export const pendingFileDrop = (threadId: string): PendingFileDrop | null => {
  const drops = pending().filter((drop) => drop.threadId === threadId);
  if (drops.length === 0) return null;
  return { id: drops[drops.length - 1]!.id, threadId, uris: drops.flatMap((drop) => drop.uris) };
};

export function queuePendingFileDrop(threadId: string, uris: string[]): number {
  counter += 1;
  const id = counter;
  pending.update((all) => [...all, { id, threadId, uris }]);
  return id;
}

/** Hands the files over: the composer takes all of its thread's drops once, and they leave the queue. */
export function takePendingFileDrop(threadId: string): string[] {
  const drop = pendingFileDrop(threadId);
  if (drop === null) return [];
  pending.update((all) => all.filter((item) => item.threadId !== threadId));
  return drop.uris;
}

export function clearPendingFileDrop(id: number) {
  pending.update((all) => all.filter((item) => item.id !== id));
}

/** handleThreadFileDrop: queue the files, open the thread, and clear them again when the thread did not open. */
export async function dropFilesOnThread(threadId: string, uris: string[], open: () => Promise<boolean> | boolean): Promise<void> {
  if (uris.length === 0) return;
  const id = queuePendingFileDrop(threadId, uris);
  let landed = false;
  try {
    landed = (await open()) !== false;
  } catch {
    landed = false;
  }
  if (!landed) clearPendingFileDrop(id);
}
