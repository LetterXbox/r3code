// The Working shelf's ordering, from client-runtime/src/state/threadInbox.ts: Working rows newest
// send first (sortWorkingThreadsBySend), the rest of the active list by when each thread last came
// back (sortInboxThreadsByReturn). Pure, so the sections and the tests share it.
import type { Thread } from "../../store";
import { isThreadWorking } from "./threadStatus";
import { compareThreadIdentity } from "./threadOrder";

const stamp = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function newestFirst(threads: readonly Thread[], at: (thread: Thread) => number): Thread[] {
  const stamps = new Map(threads.map((thread) => [thread, at(thread)] as const));
  return [...threads].sort((a, b) => stamps.get(b)! - stamps.get(a)! || compareThreadIdentity(a, b));
}

/** The user's latest send, else the run's request time, else creation. */
export function sortWorkingBySend(threads: readonly Thread[]): Thread[] {
  return newestFirst(threads, (thread) =>
    Math.max(stamp(thread.createdAt), stamp(thread.meta?.latestUserAuthoredMessageAt === undefined ? thread.meta?.latestRunRequestedAt : thread.meta.latestUserAuthoredMessageAt)));
}

/** Creation, unsettle, the latest run's request and completion: whichever is newest. */
export function sortByReturn(threads: readonly Thread[], returnedAt?: (thread: Thread) => number | undefined): Thread[] {
  return newestFirst(threads, (thread) =>
    Math.max(stamp(thread.createdAt), stamp(thread.meta?.unsettledAt), stamp(thread.meta?.latestRunRequestedAt), stamp(thread.meta?.latestRunCompletedAt), stamp(returnedAt?.(thread))));
}

/**
 * partitionSidebarThreads' active split: with the shelf on, threads holding a run leave the active
 * list for Working (newest send first) and the rest sort by return; with it off, nothing moves.
 */
export function partitionActive(
  active: readonly Thread[],
  shelfEnabled: boolean,
  holdsPlace: (thread: Thread) => boolean = isThreadWorking,
  returnedAt?: (thread: Thread) => number | undefined,
): { working: Thread[]; rest: Thread[] } {
  if (!shelfEnabled) return { working: [], rest: sortByReturn(active) };
  const working = active.filter(holdsPlace);
  return { working: sortWorkingBySend(working), rest: sortByReturn(active.filter((thread) => !working.includes(thread)), returnedAt) };
}
