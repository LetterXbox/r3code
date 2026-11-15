// Superseded-attempt folds, ported from the web app's session-logic.ts resolveAttempt and MessagesTimeline.logic.ts
// completeSupersededReplyEntryIds / deriveSupersededAttemptFolds: when a steer supersedes a run attempt, the
// attempt's output folds behind one "Superseded attempt" row ("Cut off by a steer") that expands in place.
// An attempt whose last output is a reply that completed before the steer stays open, and so does a run that is
// still active or failed (the reference's unfoldedRunIds).
import type { FoldedRow } from "./turnFolds";
import { deferredWorkItemIds } from "./turnFolds";
import type { TimelineRow } from "./workLog";

type Rec = Record<string, unknown>;

export interface AttemptSources {
  attempts: readonly Rec[];
  nodes: readonly Rec[];
  /** Message turn items by messageId (store.ts messageItemIndex). */
  messageItems: ReadonlyMap<unknown, Rec>;
  /** The thread's runs (status per id): active and failed runs never fold an attempt. */
  runs?: readonly Rec[];
}

export interface TimelineAttempt { id: string; runId: string; status: string; completedAt: string | null }

/** session-logic.ts resolveAttempt: walk the item's node up to the root whose attempt belongs to the item's run. */
export function resolveAttempt(item: Rec | undefined, sources: Pick<AttemptSources, "attempts" | "nodes">): TimelineAttempt | undefined {
  return createAttemptResolver(sources)(item);
}

function createAttemptResolver(sources: Pick<AttemptSources, "attempts" | "nodes">): (item: Rec | undefined) => TimelineAttempt | undefined {
  const byRoot = new Map<unknown, Rec>(sources.attempts.map((attempt) => [attempt.rootNodeId, attempt] as const));
  const nodes = new Map<unknown, Rec>(sources.nodes.map((node) => [node.id, node] as const));
  return (item) => {
    if (!item || typeof item.nodeId !== "string" || typeof item.runId !== "string") return undefined;
    const read = (attempt: Rec | undefined) => attempt && attempt.runId === item.runId && typeof attempt.id === "string"
      ? { id: attempt.id, runId: String(attempt.runId), status: String(attempt.status ?? ""), completedAt: typeof attempt.completedAt === "string" ? attempt.completedAt : null }
      : undefined;
    let nodeId: unknown = item.nodeId;
    const visited = new Set<unknown>();
    while (nodeId !== null && nodeId !== undefined && !visited.has(nodeId)) {
      visited.add(nodeId);
      const direct = read(byRoot.get(nodeId));
      if (direct) return direct;
      const node = nodes.get(nodeId);
      if (!node) return undefined;
      const root = read(byRoot.get(node.rootNodeId));
      if (root) return root;
      nodeId = node.parentNodeId;
    }
    return undefined;
  };
}

/** The turn item a timeline row draws, when it draws exactly one attempt's output. */
function rowItem(row: FoldedRow, messageItems: ReadonlyMap<unknown, Rec>): Rec | undefined {
  switch (row.kind) {
    case "entry":
      return row.entry.kind === "message" ? messageItems.get(row.entry.message.id) : undefined;
    case "work":
    case "subagents": {
      const items = row.items.map((entry) => entry.item as Rec | undefined);
      const first = items[0];
      return first && items.every((entry) => entry?.nodeId === first.nodeId && entry?.runId === first.runId) ? first : undefined;
    }
    case "plan":
    case "secret":
    case "notice":
    case "changed-files":
    case "link":
    case "failure":
      return row.item.item as Rec | undefined;
    default:
      return undefined;
  }
}

/** Rows a superseded fold never hides (deriveSupersededAttemptFolds' exclusions). */
function neverFolds(row: FoldedRow): boolean {
  if (row.kind === "entry") return row.entry.kind !== "message" || row.entry.message.role === "user";
  if (row.kind === "subagents") return row.active;
  if (row.kind === "work") return row.items.some((item) => item.type === "system_notice");
  return row.kind !== "plan" && row.kind !== "secret" && row.kind !== "notice" && row.kind !== "changed-files" && row.kind !== "link" && row.kind !== "failure";
}

const ACTIVE_RUN = new Set(["queued", "preparing", "running", "waiting", "pending"]);

export function foldSupersededAttempts(rows: readonly FoldedRow[], sources: AttemptSources | null, expanded: Readonly<Record<string, boolean>>): FoldedRow[] {
  if (!sources || sources.attempts.length === 0) return [...rows];
  const unfoldedRuns = new Set((sources.runs ?? []).filter((run) => ACTIVE_RUN.has(String(run.status)) || run.status === "failed").map((run) => run.id));
  const resolve = createAttemptResolver(sources);
  const attempts = rows.map((row) => {
    const item = rowItem(row, sources.messageItems);
    const attempt = resolve(item);
    return attempt?.status === "superseded" ? { attempt, item } : undefined;
  });
  // completeSupersededReplyEntryIds: only the attempt's last output proves it finished before the steer.
  const lastOutput = new Map<string, { row: FoldedRow; item: Rec | undefined; attempt: TimelineAttempt }>();
  const membersByAttempt = new Map<string, TimelineRow[]>();
  rows.forEach((row, index) => {
    const found = attempts[index];
    if (!found) return;
    if (!neverFolds(row) && row.kind !== "fold") {
      const members = membersByAttempt.get(found.attempt.id) ?? [];
      members.push(row);
      membersByAttempt.set(found.attempt.id, members);
    }
    if (row.kind === "entry" ? row.entry.kind !== "message" || row.entry.message.role === "user" : row.kind !== "work") return;
    lastOutput.set(found.attempt.id, { row, item: found.item, attempt: found.attempt });
  });
  const complete = new Set<string>();
  for (const [attemptId, { row, item, attempt }] of lastOutput) {
    const supersededAt = attempt?.completedAt ? Date.parse(attempt.completedAt) : NaN;
    const completedAt = typeof item?.completedAt === "string" ? Date.parse(item.completedAt) : NaN;
    if (row.kind === "entry" && row.entry.kind === "message" && !row.entry.message.streaming && item?.type === "assistant_message"
      && item.status === "completed" && Number.isFinite(completedAt) && Number.isFinite(supersededAt) && completedAt < supersededAt) complete.add(attemptId);
  }
  const result: FoldedRow[] = [];
  const anchored = new Set<string>();
  rows.forEach((row, index) => {
    const found = attempts[index];
    if (!found || complete.has(found.attempt.id) || unfoldedRuns.has(found.attempt.runId) || neverFolds(row)) {
      result.push(row);
      return;
    }
    const id = `attempt-fold:${found.attempt.id}`;
    if (!anchored.has(id)) {
      anchored.add(id);
      const createdAt = typeof found.item?.startedAt === "string" ? Date.parse(found.item.startedAt) : typeof found.item?.createdAt === "string" ? Date.parse(found.item.createdAt) : NaN;
      const members = membersByAttempt.get(found.attempt.id) ?? [];
      const deferred = deferredWorkItemIds(members);
      result.push({ kind: "fold", id, label: "Superseded attempt", createdAt: Number.isFinite(createdAt) ? createdAt : null, expanded: expanded[id] === true, attempt: true, ...(deferred.length > 0 ? { deferredWorkItemIds: deferred } : {}) });
    }
    if (expanded[id] === true) result.push(row);
  });
  return result;
}

/** The superseded-attempt fold hiding row `rowId` while collapsed, or null: thread find and citations open it (MessagesTimeline's expandedFindAttemptId). */
export function attemptFoldHiding(rows: readonly FoldedRow[], sources: AttemptSources | null, rowId: string): string | null {
  const open = new Proxy({} as Record<string, boolean>, { get: () => true });
  const unfolded = foldSupersededAttempts(rows, sources, open);
  const at = unfolded.findIndex((row) => row.id === rowId);
  if (at < 0) return null;
  if (foldSupersededAttempts(rows, sources, {}).some((row) => row.id === rowId)) return null;
  for (let index = at - 1; index >= 0; index -= 1) {
    const row = unfolded[index];
    if (row.kind === "fold" && row.attempt) return row.id;
  }
  return null;
}
