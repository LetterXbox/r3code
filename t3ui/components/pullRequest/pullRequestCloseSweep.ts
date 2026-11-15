// Close several pull requests by dragging across their rows (PullRequestsPage startCloseSweep, resolveSidebarSweepKeys,
// usePullRequestCloseBatch): the drag starts on a row's Close quick action; every open row of the same group between
// it and the row under the pointer is swept, and releasing closes them all, with one toast for the batch.
import { signal } from "nsh";
import type { ViewRef } from "nsh";
import { showToast } from "../toast";
import { readableFailure, actionFailureHints } from "./pullRequestActionCopy";
import { runQuickAction } from "./pullRequestSpeed.logic";
import { entryKey } from "./pullRequestList.logic";
import type { PullRequestEntry } from "../../pages/utility-data";

type Rpc = (method: string, payload: unknown) => Promise<unknown>;
interface Row { node: ViewRef; entry: PullRequestEntry; groupKey: string; canClose: () => boolean }

const rows = new Map<string, Row>();
const swept = signal<ReadonlySet<string>>(new Set());
const closing = signal<ReadonlySet<string>>(new Set());
export const sweptRows = () => swept();
export const closingRows = () => closing();
let sweep: { origin: string; groupKey: string; start: { x: number; y: number }; order: { key: string; top: number }[]; request: Rpc; onClosed: () => void; onEach?: (entry: PullRequestEntry, action: string) => void } | null = null;

/** resolveSidebarSweepKeys: the keys from the origin to the target, both ends included, that may be applied. */
export function resolveSweepKeys(orderedKeys: readonly string[], originKey: string, targetKey: string, canApply: (key: string) => boolean): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

/** The key of the last row whose top is at or above `y` (sidebarThreadKeyAtY). */
export function keyAtY(order: readonly { key: string; top: number }[], y: number): string | null {
  let key: string | null = null;
  for (const row of order) {
    if (key !== null && row.top > y) break;
    key = row.key;
  }
  return key;
}

export function registerSweepRow(key: string, row: Row): () => void {
  rows.set(key, row);
  return () => { if (rows.get(key) === row) rows.delete(key); };
}

export const sweeping = () => sweep !== null;

const canClose = (key: string, groupKey: string) => {
  const row = rows.get(key);
  return row !== undefined && row.groupKey === groupKey && row.entry.state === "open" && row.canClose() && !closing().has(key);
};

/** The start still measuring the rows: a release that comes first waits for it. */
let starting: Promise<void> | null = null;
export function startCloseSweep(originKey: string, start: { x: number; y: number }, request: Rpc, onClosed: () => void, onEach?: (entry: PullRequestEntry, action: string) => void): Promise<void> {
  starting = begin(originKey, start, request, onClosed, onEach).finally(() => { starting = null; });
  return starting;
}
async function begin(originKey: string, start: { x: number; y: number }, request: Rpc, onClosed: () => void, onEach?: (entry: PullRequestEntry, action: string) => void) {
  const origin = rows.get(originKey);
  if (!origin || closing().has(originKey)) return;
  const measured = await Promise.all([...rows.entries()].map(async ([key, row]) => {
    const at = await row.node.measure().catch(() => null);
    return at ? { key, top: at.pagePosition.y } : null;
  }));
  const order = measured.filter((entry): entry is { key: string; top: number } => entry !== null).sort((a, b) => a.top - b.top);
  sweep = { origin: originKey, groupKey: origin.groupKey, start, order, request, onClosed, ...(onEach ? { onEach } : {}) };
  swept.set(new Set(resolveSweepKeys(order.map((entry) => entry.key), originKey, originKey, (key) => canClose(key, origin.groupKey))));
}

export function moveCloseSweep(y: number) {
  const current = sweep;
  if (!current) return;
  const target = keyAtY(current.order, y);
  if (target !== null) swept.set(new Set(resolveSweepKeys(current.order.map((entry) => entry.key), current.origin, target, (key) => canClose(key, current.groupKey))));
}

export function cancelCloseSweep() { sweep = null; swept.set(new Set()); }

/** The drag ended `dy` below its start (a cancelled one closes nothing): every swept row is closed. */
export async function endCloseSweep(dy: number, cancelled: boolean) {
  if (starting) await starting;
  const current = sweep;
  if (!current) return;
  if (!cancelled) moveCloseSweep(current.start.y + dy);
  const keys = [...swept()].filter((key) => canClose(key, current.groupKey));
  cancelCloseSweep();
  if (cancelled || keys.length === 0) return;
  await closeBatch(keys.map((key) => rows.get(key)!.entry), current.request, current.onClosed, current.onEach);
}

/** usePullRequestCloseBatch: closes them together; one toast says how many closed, with the first failures. */
export async function closeBatch(entries: readonly PullRequestEntry[], request: Rpc, onClosed: () => void, onEach?: (entry: PullRequestEntry, action: string) => void) {
  const batch = entries.filter((entry) => entry.state === "open");
  if (batch.length === 0) return;
  const key = (entry: PullRequestEntry) => entryKey(entry);
  closing.update((all) => new Set([...all, ...batch.map(key)]));
  const failures: string[] = [];
  const outcomes = await Promise.all(batch.map(async (entry) => {
    try {
      await runQuickAction(request, entry, "close");
      onEach?.(entry, "close");
      return true;
    } catch (cause) {
      failures.push(`#${entry.number}: ${readableFailure(cause, actionFailureHints(entry.provider === "gitlab" ? "merge request" : "pull request").close)}`);
      return false;
    } finally {
      closing.update((all) => { const next = new Set(all); next.delete(key(entry)); return next; });
    }
  }));
  const closed = outcomes.filter(Boolean).length;
  showToast({
    type: failures.length > 0 ? "error" : "success",
    title: failures.length > 0 ? `Closed ${closed} of ${batch.length} pull requests` : `Closed ${closed} pull request${closed === 1 ? "" : "s"}`,
    ...(failures.length > 0 ? { description: failures.slice(0, 3).join("\n") } : {}),
  });
  if (closed > 0) onClosed();
}
