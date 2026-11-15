// The `sidebarThreadSortOrder` setting ("updated_at" or "created_at") and what reads it, from
// packages/client-runtime/src/state/threadSort.ts (getThreadSortTimestamp, sortThreads, getLatestThreadForProject)
// and getFallbackThreadIdAfterDelete in Sidebar.logic.ts. The web reads it in two places: the palette's "open the
// latest thread of this project" and the thread that opens after the open one is deleted.
import { settingValue } from "../../store";
import type { Thread } from "../../store";
import { isListedThread } from "./subagentRequests";
import { isSnoozed } from "./threadStatus";

export type ThreadSortOrder = "updated_at" | "created_at";

/** The saved order; anything else is the default (updated_at). */
export function threadSortOrder(): ThreadSortOrder {
  return settingValue("sidebarThreadSortOrder") === "created_at" ? "created_at" : "updated_at";
}

interface SortableThread { id: string; createdAt?: number; updatedAt: number; latestUserMessageAt?: number }

const first = (...values: Array<number | undefined>): number | null => {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return null;
};

/** getThreadSortTimestamp: the creation time for created_at, else the latest user message (then updated, then created). */
export function threadSortTimestamp(thread: SortableThread, order: ThreadSortOrder): number {
  if (order === "created_at") return first(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY;
  return first(thread.latestUserMessageAt, thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

/** sortThreads: newest first, ties by id descending. */
export function sortThreadsBy<T extends SortableThread>(threads: readonly T[], order: ThreadSortOrder): T[] {
  if (threads.length < 2) return [...threads];
  return threads
    .map((thread) => ({ thread, timestamp: threadSortTimestamp(thread, order) }))
    .sort((left, right) => right.timestamp - left.timestamp || (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0))
    .map(({ thread }) => thread);
}

/** getLatestThreadForProject: the first of the project's threads in the order, or null. */
export function latestThreadOf<T extends SortableThread>(threads: readonly T[], order: ThreadSortOrder = threadSortOrder()): T | null {
  return sortThreadsBy(threads, order)[0] ?? null;
}

/**
 * getFallbackThreadIdAfterDelete: the thread to open once `deletedId` is gone: the project's first listed thread in the
 * order that is not settled, not snoozed and not being deleted too.
 */
export function fallbackThreadIdAfterDelete(input: {
  threads: readonly Thread[];
  deletedId: string;
  deletedIds?: ReadonlySet<string>;
  order?: ThreadSortOrder;
  now?: number;
}): string | null {
  const deleted = input.threads.find((thread) => thread.id === input.deletedId);
  if (!deleted) return null;
  const now = input.now ?? Date.now();
  const candidates = input.threads.filter((thread) =>
    thread.projectId === deleted.projectId
    && thread.id !== input.deletedId
    && !input.deletedIds?.has(thread.id)
    && thread.meta?.settled !== true
    && !isSnoozed(thread, now)
    && isListedThread(thread));
  return sortThreadsBy(candidates, input.order ?? threadSortOrder())[0]?.id ?? null;
}
