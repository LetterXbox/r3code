// The per-row checks popover's data (PullRequestChecksPopover.tsx). Checks are fetched only when
// a popover opens, never per row: LazyChecksBody reads the pull request detail on open.
import { signal } from "nsh";
import type { PullRequestEntry } from "../../pages/utility-data";
import { parseDetail, type DetailCheck } from "./pullRequestDetail.logic";
import { entryKey } from "./pullRequestList.logic";

export interface ChecksView { status: "loading" | "loaded" | "error"; checks: DetailCheck[]; error: string }

const open = signal<string | null>(null);
const views = signal<Record<string, ChecksView>>({});
const showAll = signal<Record<string, boolean>>({});

export const openChecksKey = () => open();
export const checksView = (key: string): ChecksView | undefined => views()[key];
export const checksShowAll = (key: string) => showAll()[key] === true;
export const toggleChecksShowAll = (key: string) => showAll.update((all) => ({ ...all, [key]: !all[key] }));
export const closeChecks = () => open.set(null);

export async function toggleChecks(entry: PullRequestEntry, request: (method: string, payload: unknown) => Promise<unknown>) {
  const key = entryKey(entry);
  if (open() === key) { open.set(null); return; }
  open.set(key);
  if (views()[key]?.status === "loaded") return;
  views.update((all) => ({ ...all, [key]: { status: "loading", checks: [], error: "" } }));
  try {
    const detail = parseDetail(await request("pullRequests.detail", {
      projectId: entry.projectId, ...(entry.host ? { host: entry.host } : {}), repository: entry.repository, number: entry.number,
    }));
    views.update((all) => ({ ...all, [key]: { status: "loaded", checks: detail.checks, error: "" } }));
  } catch (cause) {
    views.update((all) => ({ ...all, [key]: { status: "error", checks: [], error: cause instanceof Error ? cause.message : String(cause) } }));
  }
}
