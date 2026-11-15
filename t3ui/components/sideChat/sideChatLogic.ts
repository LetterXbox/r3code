// SideChatPane.tsx's Bring back rules (client-runtime state/threadWorkflows.ts resolveLatestMergeBackRun) and the
// thread.merge_back command it dispatches (client-runtime operations/commands.ts mergeThreadBack).
type Run = Record<string, unknown>;

const MERGE_BACK_RUN_STATUSES = new Set(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set(["preparing", "starting", "running"]);
const ordinalOf = (run: Run) => (typeof run.ordinal === "number" ? run.ordinal : 0);

/** The latest run whose reply finished, unless a newer run is still active. */
export function latestMergeBackRun(runs: readonly Run[]): Run | null {
  let latest: Run | null = null;
  for (const run of runs) {
    if (typeof run.id === "string" && MERGE_BACK_RUN_STATUSES.has(String(run.status)) && (latest === null || ordinalOf(run) > ordinalOf(latest))) latest = run;
  }
  if (latest === null) return null;
  const finished = latest;
  return runs.some((run) => ordinalOf(run) > ordinalOf(finished) && MERGE_BACK_BLOCKING_RUN_STATUSES.has(String(run.status))) ? null : finished;
}

/** Why Bring back is unavailable, or null when it can run (the reference's bringBackBlockedReason). */
export function bringBackBlockedReason(input: { canOperate: boolean; parentActive: boolean; mergeRun: Run | null }): string | null {
  if (!input.canOperate) return "This connection cannot change threads.";
  if (input.parentActive) return "Available when the main thread is idle.";
  if (input.mergeRun === null) return "Available after a finished reply.";
  return null;
}

export const BRING_BACK_TOOLTIP = "Adds this side chat to the main thread's next message.";

export function mergeBackCommand(sourceThreadId: string, targetThreadId: string, runId: string) {
  return {
    type: "thread.merge_back", commandId: `command:${crypto.randomUUID()}`, createdBy: "user", creationSource: "web",
    sourceThreadId, targetThreadId, sourcePoint: { type: "run", runId },
  };
}
