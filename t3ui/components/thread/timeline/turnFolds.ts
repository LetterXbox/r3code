// Completed-turn folding, ported from the web app's MessagesTimeline.logic.ts deriveTurnFolds: a finished turn
// collapses its work (tool groups and the intermediate replies before the final one) behind one
// "Worked for <duration>" row that expands in place; the live turn, a failed turn and an interrupted one stay open.
// Server run state owns completion; a failed command inside a successful run does not keep its whole turn open.
import type { TimelineRow, WorkItem } from "./workLog";
import { itemActive, itemFailed } from "./workLog";
import { isSteerIntent } from "./userMessagePresentation";

/** orchestrationTiming.ts formatDuration, verbatim. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${Math.round(durationMs / 100) / 10}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** deriveTurnFolds never folds a run that was interrupted (a run_interrupt_result item). */
const INTERRUPTED_LABEL = "Run interrupted";

export interface LatestRun { status: string; startedAt: number | null; completedAt: number | null }

export type FoldRow = { kind: "fold"; id: string; label: string; createdAt: number | null; expanded: boolean; /** A superseded-attempt fold (attemptFolds.ts), drawn as AttemptFoldRow. */ attempt?: true;
  /** MessagesTimeline.logic deferredWorkItemIds: work items whose collapsed history loads when the fold opens. */ deferredWorkItemIds?: string[] };

/** The ids of the work items in `rows` that carry a deferred-work cursor (acceptDeferredWork). */
export function deferredWorkItemIds(rows: readonly TimelineRow[]): string[] {
  return rows.flatMap((row) => row.kind === "work" ? row.items.flatMap((item) => {
    const raw = item.item as { deferredWork?: unknown } | undefined;
    return raw && typeof raw.deferredWork === "object" && raw.deferredWork !== null ? [item.id] : [];
  }) : []);
}
export type FoldedRow = TimelineRow | FoldRow;

const unordered = (order: number | undefined) => order === undefined || order <= 0 || order >= Number.MAX_SAFE_INTEGER / 2;

function rowOrder(row: TimelineRow): number | null {
  if (row.kind === "entry") return unordered(row.entry.order) ? null : row.entry.order;
  if (row.kind === "notice") return unordered(row.item.order) ? null : row.item.order ?? null;
  if (row.kind === "work" || row.kind === "subagents") {
    // A tool call ends when it completed, not when it started: the fold's duration runs to the turn's real end.
    const orders = row.items.map((item) => (row.kind === "work" ? item.completedAt ?? item.order : item.order)).filter((order): order is number => !unordered(order));
    return orders.length > 0 ? Math.max(...orders) : null;
  }
  return null;
}

/** The latest known timestamp of the rows of a turn, 0 when none carry one. */
function turnEnd(rows: readonly TimelineRow[]): number {
  let end = 0;
  for (const row of rows) {
    const order = row.kind === "entry" && row.entry.kind === "message" ? row.entry.message.updatedAt ?? rowOrder(row) : rowOrder(row);
    if (order !== null && order > end) end = order;
  }
  return end;
}

/** timelineEntryIsSteer: a user message sent into a running turn splits that turn, it does not start another. */
const isSteerRow = (row: TimelineRow) => row.kind === "entry" && row.entry.kind === "message" && row.entry.message.role === "user" && isSteerIntent(row.entry.message.inputIntent);
/** timelineEntryStartsResponse: a user message (not a steer) or a notification begins a response. */
const isUserRow = (row: TimelineRow) => row.kind === "notice" || (row.kind === "entry" && row.entry.kind === "message" && row.entry.message.role === "user" && !isSteerRow(row));
const isAssistantRow = (row: TimelineRow) => row.kind === "entry" && row.entry.kind === "message" && row.entry.message.role === "assistant";
const isStreaming = (row: TimelineRow) => row.kind === "entry" && row.entry.kind === "message" && row.entry.message.streaming === true;
const workFailed = (items: readonly WorkItem[]) => items.some(itemFailed);
const workActive = (items: readonly WorkItem[]) => items.some(itemActive);

/**
 * Folds every finished turn. `running` marks the last turn live (it stays expanded); `expanded` holds the fold ids
 * the reader opened.
 */
export function foldCompletedTurns(
  rows: readonly TimelineRow[],
  options: { running: boolean; expanded: Readonly<Record<string, boolean>>; /** The thread's latest run: when it was interrupted, its turn's fold reads "You stopped after <duration>". */ latestRun?: LatestRun | null; runStates?: ReadonlyMap<string, LatestRun> },
): FoldedRow[] {
  const starts: number[] = [];
  rows.forEach((row, index) => { if (isUserRow(row)) starts.push(index); });
  if (starts.length === 0) return [...rows];
  const result: FoldedRow[] = rows.slice(0, starts[0]);
  starts.forEach((start, turn) => {
    const end = starts[turn + 1] ?? rows.length;
    const prompt = rows[start];
    const body = rows.slice(start + 1, end);
    const runId = prompt.kind === "entry" && prompt.entry.kind === "message" ? prompt.entry.message.runId : undefined;
    const run = runId ? options.runStates?.get(runId) : undefined;
    const runLive = run !== undefined && ["preparing", "starting", "running", "waiting"].includes(run.status);
    const live = run ? runLive : options.running && turn === starts.length - 1;
    const working = body.filter((row) => row.kind === "working");
    const content = body.filter((row) => row.kind !== "working");
    result.push(prompt);
    const unfold = live
      || (run ? run.status === "failed" || run.status === "interrupted" : content.some(isStreaming)
        || content.some((row) => row.kind === "work" && (workFailed(row.items) || workActive(row.items))))
      || content.some((row) => row.kind === "divider" && (row.tone === "danger" || row.label === INTERRUPTED_LABEL));
    if (unfold) {
      // The working indicator sits under the prompt, ahead of the live turn's activity.
      result.push(...working, ...content);
      return;
    }
    let terminal = -1;
    content.forEach((row, index) => { if (isAssistantRow(row)) terminal = index; });
    const hidden = new Set<number>();
    content.forEach((row, index) => {
      if (index === terminal) return;
      // Plans and notices are cards a fold never hides.
      // Subagent cards fold with their turn once every child has settled (liveSubagentCardEntryIds).
      if (row.kind === "work" || (row.kind === "subagents" && !row.active)) hidden.add(index);
      else if (row.kind === "entry" && isAssistantRow(row) && (terminal < 0 || index < terminal)) hidden.add(index);
    });
    if (![...hidden].some((index) => content[index].kind === "work" || content[index].kind === "subagents")) {
      result.push(...content, ...working);
      return;
    }
    const startOrder = rowOrder(prompt);
    const endOrder = turnEnd(content);
    const latest = run ?? (options.latestRun && turn === starts.length - 1 ? options.latestRun : null);
    const stopped = latest?.status === "interrupted";
    // The run's own start and end time the turn when the server reported both; otherwise the rows' timestamps do.
    const elapsed = latest && latest.startedAt && latest.completedAt ? Math.max(0, latest.completedAt - latest.startedAt)
      : startOrder !== null && endOrder > 0 ? Math.max(0, endOrder - startOrder) : null;
    const duration = elapsed !== null ? formatDuration(elapsed) : null;
    // The top row keeps the whole turn's time, steers included; work after a steer folds under its own row below that steer.
    const label = stopped ? (duration ? `You stopped after ${duration}` : "You stopped this response") : duration ? `Worked for ${duration}` : "Worked";
    const steers: number[] = [];
    content.forEach((row, index) => { if (isSteerRow(row)) steers.push(index); });
    let from = 0;
    [...steers, content.length].forEach((boundary, segment) => {
      const members = content.slice(from, boundary).map((row, offset) => from + offset);
      const hidesWork = members.some((index) => hidden.has(index) && (content[index].kind === "work" || content[index].kind === "subagents"));
      if (!hidesWork) members.forEach((index) => result.push(content[index]));
      else {
        const steer = segment === 0 ? null : content[steers[segment - 1]];
        const id = steer ? `turn-fold:${steer.id}` : `turn-fold:${prompt.id}`;
        const open = options.expanded[id] === true;
        let segmentLabel = label;
        if (steer) {
          const steerOrder = rowOrder(steer);
          const segmentEnd = turnEnd(members.map((index) => content[index]));
          segmentLabel = steerOrder !== null && segmentEnd > 0 ? `Continued for ${formatDuration(Math.max(0, segmentEnd - steerOrder))}` : "Continued";
        }
        const deferred = deferredWorkItemIds(members.map((index) => content[index]));
        result.push({ kind: "fold", id, label: segmentLabel, createdAt: steer ? rowOrder(steer) : startOrder, expanded: open, ...(deferred.length > 0 ? { deferredWorkItemIds: deferred } : {}) });
        members.forEach((index) => { if (!hidden.has(index) || open) result.push(content[index]); });
      }
      if (boundary < content.length) result.push(content[boundary]);
      from = boundary + 1;
    });
    result.push(...working);
  });
  return result;
}

/**
 * The fold that hides row `rowId` while collapsed, or null when the row is visible or not in a fold. Thread find and
 * search results open it so the match can be scrolled to.
 */
export function foldHiding(rows: readonly TimelineRow[], rowId: string, running: boolean, runStates?: ReadonlyMap<string, LatestRun>): string | null {
  const open = new Proxy({} as Record<string, boolean>, { get: () => true });
  const unfolded = foldCompletedTurns(rows, { running, expanded: open, runStates });
  const at = unfolded.findIndex((row) => row.id === rowId);
  if (at < 0) return null;
  const closed = foldCompletedTurns(rows, { running, expanded: {}, runStates });
  if (closed.some((row) => row.id === rowId)) return null;
  for (let index = at - 1; index >= 0; index -= 1) if (unfolded[index].kind === "fold") return unfolded[index].id;
  return null;
}
