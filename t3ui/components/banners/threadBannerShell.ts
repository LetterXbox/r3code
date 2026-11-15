// What the banners read off a shell thread (OrchestrationV2ThreadShell in packages/contracts): the last failure's
// class and code, the usage-limit reset and recovery, the goal, the pending background tasks and the stop flag.
// Pure, so it is tested with contract-shaped payloads.

export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
export interface ProviderGoal {
  objective: string;
  status: GoalStatus;
  tokensUsed?: number;
  tokenBudget?: number | null;
  timeUsedSeconds?: number;
  checks?: number;
  lastCheck?: string;
}
export type BackgroundKind = "subagent" | "command" | "monitor" | "background_task";
export interface BackgroundTask {
  taskId: string;
  kind: BackgroundKind;
  description?: string;
  childThreadId?: string;
  awaited?: boolean;
}
export interface LimitRecovery { runId: string; resetAt: string; autoResume: boolean; snooze?: boolean }

export interface ThreadBannerShell {
  providerInstanceId: string | null;
  lastErrorClass: string | null;
  lastErrorCode: string | null;
  usageLimitResetAt: string | null;
  limitRecovery: LimitRecovery | null;
  snoozedUntil: string | null;
  settledAt: string | null;
  latestRunStopRequested: boolean;
  activeRunId: string | null;
  goal: ProviderGoal | null;
  pendingBackgroundTasks: BackgroundTask[];
  /** The latest run's id and the time it ended, for the usage-limit recovery card. */
  latestRunId: string | null;
  latestRunStoppedAt: string | null;
  /** The shell's own status ("failed" after a run ended in an error). */
  status: string | null;
  settledOverride: string | null;
  hasPendingUserInput: boolean;
  /** `pendingRuntimeRequest.kind`; null when the thread waits on nothing. */
  pendingRequestKind: string | null;
  /** `worktreePath` and `branch`, for the local-checkout branch mismatch. */
  branch: string | null;
  worktreePath: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

const GOAL_STATUSES = new Set(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]);
const TASK_KINDS = new Set(["subagent", "command", "monitor", "background_task"]);

export function readGoal(value: unknown): ProviderGoal | null {
  const goal = record(value);
  const objective = text(goal?.objective);
  if (!goal || !objective || typeof goal.status !== "string" || !GOAL_STATUSES.has(goal.status)) return null;
  const budget = goal.tokenBudget === null ? null : count(goal.tokenBudget);
  return {
    objective, status: goal.status as GoalStatus,
    ...(count(goal.tokensUsed) !== undefined ? { tokensUsed: count(goal.tokensUsed) } : {}),
    ...(budget !== undefined ? { tokenBudget: budget } : {}),
    ...(count(goal.timeUsedSeconds) !== undefined ? { timeUsedSeconds: count(goal.timeUsedSeconds) } : {}),
    ...(count(goal.checks) !== undefined ? { checks: count(goal.checks) } : {}),
    ...(text(goal.lastCheck) ? { lastCheck: text(goal.lastCheck)! } : {}),
  };
}

/** An unknown kind decodes as a plain background task, as the contract's `kindUnionWithFallback` does. */
export function readBackgroundTasks(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: BackgroundTask[] = [];
  for (const entry of value) {
    const task = record(entry);
    const taskId = text(task?.taskId);
    if (!task || !taskId) continue;
    const kind = typeof task.kind === "string" && TASK_KINDS.has(task.kind) ? (task.kind as BackgroundKind) : "background_task";
    tasks.push({
      taskId, kind,
      ...(text(task.description) ? { description: text(task.description)! } : {}),
      ...(kind === "subagent" && text(task.childThreadId) ? { childThreadId: text(task.childThreadId)! } : {}),
      ...(task.awaited === true ? { awaited: true } : {}),
    });
  }
  return tasks;
}

export function readLimitRecovery(value: unknown): LimitRecovery | null {
  const recovery = record(value);
  const runId = text(recovery?.runId);
  const resetAt = text(recovery?.resetAt);
  if (!recovery || !runId || !resetAt) return null;
  return { runId, resetAt, autoResume: recovery.autoResume === true, ...(typeof recovery.snooze === "boolean" ? { snooze: recovery.snooze } : {}) };
}

/** Reads one raw shell record. Undefined when the thread has nothing a banner would show. */
export function threadBannerFromShell(value: Record<string, unknown>): ThreadBannerShell | undefined {
  const selection = record(value.modelSelection);
  const request = record(value.pendingRuntimeRequest);
  const banner: ThreadBannerShell = {
    providerInstanceId: text(selection?.instanceId) ?? text(value.providerInstanceId),
    lastErrorClass: text(value.lastErrorClass),
    lastErrorCode: text(value.lastErrorCode),
    usageLimitResetAt: text(value.usageLimitResetAt),
    limitRecovery: readLimitRecovery(value.limitRecovery),
    snoozedUntil: text(value.snoozedUntil),
    settledAt: text(value.settledAt),
    latestRunStopRequested: value.latestRunStopRequested === true,
    activeRunId: text(value.activeRunId),
    goal: readGoal(value.goal),
    pendingBackgroundTasks: readBackgroundTasks(value.pendingBackgroundTasks),
    latestRunId: text(value.latestRunId),
    latestRunStoppedAt: text(value.latestRunCompletedAt) ?? text(value.updatedAt),
    status: text(value.status),
    settledOverride: text(value.settledOverride),
    hasPendingUserInput: request?.kind === "user_input",
    pendingRequestKind: text(request?.kind),
    branch: text(value.branch),
    worktreePath: text(value.worktreePath),
  };
  const quiet = !banner.lastErrorClass && !banner.lastErrorCode && !banner.usageLimitResetAt && !banner.limitRecovery && !banner.latestRunStopRequested
    && !banner.goal && banner.pendingBackgroundTasks.length === 0 && !banner.branch && !banner.pendingRequestKind && banner.status !== "failed";
  return quiet ? undefined : banner;
}
