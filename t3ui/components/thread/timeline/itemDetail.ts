// The item inspector's detail fetch (V2ItemInspector.tsx useFetchedTurnItem, client-runtime work-log/item-detail.ts):
// a command or tool call whose output the environment withheld is fetched with `orchestration.getTurnItem` when its row
// opens, keyed by item and revision, and the fetched item's text replaces the row's detail.
import { signal, untracked } from "nsh";
import { requestBackend } from "../../../store";
import { activityFromTurnItem } from "./ingestActivity";
import type { WorkItem } from "./workLog";
import { turnItemNeedsDetailFetch, type TurnItem } from "./turnItemDetail";

export type ItemDetailState = { state: "pending" } | { state: "ready"; detail: string; item?: TurnItem } | { state: "unavailable" } | { state: "error"; message: string };
type Request = (method: string, payload: unknown) => Promise<unknown>;

let request: Request = requestBackend;
/** Replaces the transport (tests). */
export function setItemDetailRequest(next: Request | null) {
  request = next ?? requestBackend;
  cache.set({});
}

const cache = signal<Record<string, ItemDetailState>>({});
const key = (item: WorkItem) => `${item.threadId}:${item.id}:${item.revision}`;

export const needsItemDetail = (item: WorkItem) =>
  typeof item.threadId === "string" && item.threadId.length > 0 &&
  (item.outputOmitted === true || (item.item !== undefined && turnItemNeedsDetailFetch(item.item)));

/** The fetched state of an item (undefined before the fetch started). Reading it in a view subscribes to the result. */
export function itemDetailOf(item: WorkItem): ItemDetailState | undefined {
  return cache()[key(item)];
}

/** Starts the fetch once per item revision. */
export function loadItemDetail(item: WorkItem): void {
  if (!needsItemDetail(item)) return;
  const id = key(item);
  if (untracked(() => cache())[id] !== undefined) return;
  cache.update((all) => ({ ...all, [id]: { state: "pending" } }));
  void request("orchestration.getTurnItem", { threadId: item.threadId, itemId: item.id, ...(item.revision ? { revision: item.revision } : {}) })
    .then((result) => {
      const fetched = (result !== null && typeof result === "object" ? (result as Record<string, unknown>).item : null) as Record<string, unknown> | null;
      const activity = fetched ? activityFromTurnItem(fetched, 0) : null;
      cache.update((all) => ({ ...all, [id]: activity && fetched?.type === item.type ? { state: "ready", detail: activity.detail, ...(activity.item ? { item: activity.item } : {}) } : { state: "unavailable" } }));
    })
    .catch((cause) => cache.update((all) => ({ ...all, [id]: { state: "error", message: cause instanceof Error ? cause.message : "Could not load the output." } })));
}
