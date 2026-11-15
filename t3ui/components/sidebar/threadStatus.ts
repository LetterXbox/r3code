// Thread status for the sidebar, ported from Sidebar.logic.ts
// (resolveSidebarThreadStatus, hasUnseenCompletion, shouldRecedeSidebarThread,
// resolveSidebarFolderDot, resolveSidebarThreadSection) and the topStatus table in
// sidebar/SidebarThreadRow.tsx.
import type { Thread } from "../../store";

export type SidebarThreadStatus =
  | "approval" | "input" | "request" | "preparing" | "working"
  | "waiting" | "failed" | "limited" | "ready";

export type TopStatusIcon =
  | "working" | "waiting" | "input" | "request" | "approval" | "failed" | "done" | "woke";

export interface TopStatus {
  label: string;
  icon: TopStatusIcon;
  /** Tailwind text color class, from the web's topStatus table. */
  className: string;
}

/** resolveSidebarThreadStatus, reading the shell meta when the thread has it. */
export function resolveThreadStatus(thread: Thread): SidebarThreadStatus {
  const meta = thread.meta;
  if (!meta) {
    if (thread.status === "awaiting") return "approval";
    if (thread.status === "running") return "working";
    if (thread.status === "stopped" && thread.error) return "failed";
    return "ready";
  }
  if (meta.pendingRequestKind !== null && meta.pendingRequestKind !== "user_input") return "approval";
  if (meta.pendingRequestKind === "user_input") return "input";
  if (meta.pendingGuestMessageCount > 0) return "request";
  // Fixtures without the shell's runtime keep reading the run status; a live shell carries runtimeStatus.
  const runtime = meta.runtimeStatus !== undefined ? meta.runtimeStatus : (meta.activityRunStatus ?? meta.runStatus);
  if (runtime === "running" && meta.blockedOnThreadWait) return "waiting";
  if (runtime === "preparing") return "preparing";
  if (runtime !== null && ["queued", "starting", "running", "waiting"].includes(runtime)) return "working";
  // A finished run parked by background work reads Waiting; only a live shell sets runtimeStatus.
  if (runtime === "idle" && meta.runtimeStatus !== undefined) return "waiting";
  if (runtime === "failed") return meta.lastErrorClass === "usage_limit" ? "limited" : "failed";
  return "ready";
}

const ACTIVE_RUNTIME = ["preparing", "queued", "starting", "running", "waiting"];

/**
 * isThreadWorking (client-runtime threadInbox.ts): the thread holds a Working shelf place. Pending
 * requests leave it; a runtime that is neither active nor idle (completed, failed, none) is not
 * working; a plan the user has yet to act on, after its run settled, is not working either.
 */
export function isThreadWorking(thread: Thread): boolean {
  const meta = thread.meta;
  if (!meta) return thread.status === "running";
  if (meta.pendingRequestKind !== null || meta.pendingSubagentRequest === true) return false;
  const runtime = meta.runtimeStatus !== undefined ? meta.runtimeStatus : (meta.activityRunStatus ?? meta.runStatus);
  const active = runtime !== null && ACTIVE_RUNTIME.includes(runtime);
  if (!active && runtime !== "idle") return false;
  if (meta.runtimeStatus === undefined && runtime === "idle") return false;
  const hasRun = meta.latestRunId != null;
  const runSettled = hasRun && !ACTIVE_RUNTIME.includes(meta.runStatus) && meta.activeRunId !== meta.latestRunId;
  return !(meta.interactionMode === "plan" && meta.hasActionableProposedPlan && runSettled);
}

/**
 * resolveThreadWorkingStartedAt: the work start of the run holding the activity, never the last
 * activity. A thread with no live shell fields counts from its last update.
 */
export function workingStartedAt(thread: Thread): number | null {
  const meta = thread.meta;
  if (!meta) return thread.updatedAt || null;
  if (meta.activityStartedAt !== undefined) return meta.activityStartedAt;
  if (meta.activeRunId != null && meta.activeRunId === meta.latestRunId && meta.latestRunCompletedAt === null) {
    return meta.latestRunStartedAt ?? meta.latestRunRequestedAt ?? null;
  }
  return null;
}

/** Where a Waiting row counts from: when the latest run completed. */
export function waitingStartedAt(thread: Thread): number | null {
  return thread.meta?.latestRunCompletedAt ?? (thread.meta ? thread.updatedAt : null) ?? null;
}

/** formatWorkingDurationLabel: "42s", "6m", "1h 5m". */
export function formatWorkingDuration(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The duration a Working, Setting up or Waiting status shows beside its label; null when the start is unknown. */
export function statusDurationLabel(thread: Thread, now: number): string | null {
  const status = resolveThreadStatus(thread);
  const started = status === "working" || status === "preparing" ? workingStartedAt(thread)
    : status === "waiting" ? waitingStartedAt(thread) : null;
  return started === null || started === undefined ? null : formatWorkingDuration(now - started);
}

/** resolveThreadActivityTimestamp (threadSort.ts): the latest of the last message and the latest run's requested, started and completed times, else the update time. */
export function threadActivityAt(thread: Thread): number {
  const meta = thread.meta;
  const latest = [thread.latestUserMessageAt, meta?.latestRunRequestedAt, meta?.latestRunStartedAt, meta?.latestRunCompletedAt]
    .filter((at): at is number => typeof at === "number" && Number.isFinite(at));
  return latest.length > 0 ? Math.max(...latest) : thread.updatedAt;
}

/** resolveSettledThreadTimestamp: a settled row counts from when it was settled. */
export function threadSettledAt(thread: Thread): number {
  const settledAt = thread.meta?.settledAt;
  return typeof settledAt === "number" && Number.isFinite(settledAt) ? settledAt : threadActivityAt(thread);
}

/** hasUnseenCompletion: the latest run finished after the last visit. No watermark, no unread. */
export function hasUnseenCompletion(thread: Thread): boolean {
  const meta = thread.meta;
  if (!meta || meta.latestRunCompletedAt === null || meta.lastVisitedAt === null) return false;
  return meta.latestRunCompletedAt > meta.lastVisitedAt;
}

/**
 * threadRaisedHandWhileSnoozed (threadSettled.ts): only a request for the user or a fresh failure ends a snooze
 * early. A question already open when the thread was snoozed means "ask me later"; completed runs never wake it.
 */
export function raisedHandWhileSnoozed(thread: Thread): boolean {
  const meta = thread.meta;
  if (!meta) return false;
  if (meta.pendingRequestKind !== null && meta.pendingRequestKind !== "user_input") return true;
  const snoozedAt = meta.snoozedAt ?? null;
  if (meta.pendingRequestKind === "user_input") {
    const asked = meta.pendingRequestAt ?? null;
    if (snoozedAt === null || asked === null || !(asked <= snoozedAt)) return true;
  }
  if (meta.pendingSubagentRequest === true || meta.pendingGuestMessageCount > 0) return true;
  const failed = failureEdgeAt(thread);
  return failed !== undefined && (snoozedAt === null || (failed !== null && failed > snoozedAt));
}

/** failureEdgeAt: when the run failed; undefined while it has not. */
function failureEdgeAt(thread: Thread): number | null | undefined {
  const status = resolveThreadStatus(thread);
  if (status !== "failed" && status !== "limited") return undefined;
  return thread.meta?.latestRunCompletedAt ?? thread.updatedAt ?? null;
}

/**
 * threadWokeAt (threadSettled.ts): when a snooze ran out, or when a request or failure ended it early. A thread
 * whose wake time has passed is "woke" until it is visited after that moment or settled.
 */
export function threadWokeAt(thread: Thread, now: number): number | null {
  const until = thread.meta?.snoozedUntil;
  if (until == null) return null;
  if (raisedHandWhileSnoozed(thread)) {
    const meta = thread.meta!;
    const snoozedAt = meta.snoozedAt ?? null;
    const failedAt = failureEdgeAt(thread);
    const askedAt = meta.pendingRequestKind === "user_input" ? (meta.pendingRequestAt ?? null) : null;
    const freshFailure = failedAt != null && (snoozedAt === null || failedAt > snoozedAt);
    const freshQuestion = askedAt !== null && snoozedAt !== null && askedAt > snoozedAt;
    if (freshFailure && (!freshQuestion || failedAt! >= askedAt!)) return failedAt!;
    if (freshQuestion) return askedAt;
    return thread.updatedAt ?? snoozedAt;
  }
  return until <= now ? until : null;
}

export function isWoke(thread: Thread, now: number): boolean {
  const wokeAt = threadWokeAt(thread, now);
  if (wokeAt === null || thread.meta?.settled) return false;
  const visited = thread.meta?.lastVisitedAt ?? null;
  return visited === null || visited < wokeAt;
}

/** The trailing status that replaces the relative time on a folder row. */
export function resolveTopStatus(thread: Thread, now: number = Date.now()): TopStatus | null {
  const status = resolveThreadStatus(thread);
  if (status === "preparing" || status === "working") {
    const label = status === "preparing" ? "Setting up" : thread.meta?.goalActive ? "Goal" : "Working";
    return { label, icon: "working", className: "text-info-foreground" };
  }
  if (status === "waiting") return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
  if (status === "approval") return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
  if (status === "input") return { label: "Input", icon: "input", className: "text-[#4f46e5] dark:text-[#a5b4fc]" };
  if (status === "request") return { label: "Request", icon: "request", className: "text-guest-foreground" };
  if (status === "limited") return { label: "Limited", icon: "failed", className: "text-warning-foreground" };
  if (status === "failed") return { label: "Failed", icon: "failed", className: "text-error-foreground" };
  if (isWoke(thread, now)) return { label: "Woke", icon: "woke", className: "text-warning-foreground" };
  if (hasUnseenCompletion(thread)) return { label: "Done", icon: "done", className: "text-success-foreground" };
  return null;
}

/** shouldRecedeSidebarThread: quiet rows dim until hovered. */
export function shouldRecede(input: { thread: Thread; active: boolean; selected?: boolean; now?: number }): boolean {
  const status = resolveThreadStatus(input.thread);
  if (input.active || input.selected || status === "input" || status === "request") return false;
  if (status === "preparing" || status === "working" || status === "waiting") return true;
  if (status === "ready" || status === "approval") return !hasUnseenCompletion(input.thread) && !isWoke(input.thread, input.now ?? Date.now());
  return false;
}

/** The dot on a closed folder: the most urgent state among its hidden threads. */
export function resolveFolderDot(threads: readonly Thread[]): "attention" | "failed" | "unread" | "working" | null {
  const statuses = new Set(threads.map(resolveThreadStatus));
  // resolveSidebarFolderDot: a usage limit asks for you like an approval does; Failed is its own dot.
  if (statuses.has("approval") || statuses.has("input") || statuses.has("request") || statuses.has("limited")) return "attention";
  if (statuses.has("failed")) return "failed";
  // Rows show Done only for ready threads, so the dot follows the same rule.
  if (threads.some((thread) => resolveThreadStatus(thread) === "ready" && hasUnseenCompletion(thread))) return "unread";
  if (statuses.has("preparing") || statuses.has("working")) return "working";
  return null;
}

export const FOLDER_DOT_CLASS = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

export type SidebarSection = "pinned" | "active" | "snoozed" | "settled";

/**
 * Failed starts and stale shells can leave a user message unadopted; bound the pending window so such a thread
 * can still be snoozed (QUEUED_TURN_START_GRACE_MS in threadSettled.ts).
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/** hasQueuedTurnStart: a message was sent and no run has picked it up yet. */
export function hasQueuedTurnStart(thread: Thread, now: number): boolean {
  const meta = thread.meta;
  if (!meta) return false;
  const runtime = meta.runtimeStatus !== undefined ? meta.runtimeStatus : (meta.activityRunStatus ?? meta.runStatus);
  if (runtime === "preparing" || runtime === "queued" || runtime === "starting") return true;
  const messageAt = thread.latestUserMessageAt;
  if (messageAt == null) return false;
  if (thread.status === "stopped" && thread.error) return false;
  if (Math.abs(now - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  if (meta.latestRunId == null) return true;
  return [meta.latestRunRequestedAt, meta.latestRunStartedAt, meta.latestRunCompletedAt].every(
    (at) => at == null || at < messageAt,
  );
}

/** canSnooze (threadSettled.ts): not while a request waits on the user, a guest message is pending, or a turn is about to start. */
export function canSnooze(thread: Thread, now: number): boolean {
  const meta = thread.meta;
  if (!meta) return true;
  if (meta.pendingRequestKind !== null && meta.pendingRequestKind !== "user_input") return false;
  if (meta.pendingSubagentRequest === true) return false;
  if (meta.pendingGuestMessageCount > 0) return false;
  return !hasQueuedTurnStart(thread, now);
}

/** Whether a snooze is still in force. */
export function isSnoozed(thread: Thread, now: number): boolean {
  const until = thread.meta?.snoozedUntil;
  return until != null && until > now && !raisedHandWhileSnoozed(thread);
}

/**
 * resolveSidebarThreadSection: snoozed beats settled beats pinned. Snoozed and settled only count once the
 * server config is loaded, as the web gates them (`configLoaded && ...`).
 */
export function resolveSection(thread: Thread, now: number, configLoaded = true): SidebarSection {
  if (configLoaded && isSnoozed(thread, now)) return "snoozed";
  if (configLoaded && thread.meta?.settled) return "settled";
  if (thread.pinned) return "pinned";
  return "active";
}

/** snoozeWakeLabel: "45m", "3h", "2d" until the wake time. */
export function snoozeWakeLabel(until: number, now: number): string {
  const remaining = until - now;
  if (remaining <= 0) return "now";
  if (remaining < 3_600_000) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`;
  if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)}h`;
  return `${Math.ceil(remaining / 86_400_000)}d`;
}

/** resolveAdjacentThreadId: the neighbour in display order; null at the ends. */
export function adjacentThreadId(ids: readonly string[], current: string | null, direction: "previous" | "next"): string | null {
  if (ids.length === 0) return null;
  if (current === null) return direction === "previous" ? ids[ids.length - 1] : ids[0];
  const index = ids.indexOf(current);
  if (index === -1) return null;
  const next = direction === "previous" ? index - 1 : index + 1;
  return next >= 0 && next < ids.length ? ids[next] : null;
}

/**
 * resolveThreadStatusPill (Sidebar.logic.ts:1091): the leading status of a command palette thread row
 * (ThreadRowLeadingStatus, ThreadStatusIndicators.tsx:606-657): a 6 pt dot and its label; Working and Connecting pulse.
 */
export interface ThreadStatusPill {
  label: string;
  /** Text colour class of the label and dot colour class. */
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

export function resolveThreadStatusPill(thread: Thread): ThreadStatusPill | null {
  const status = resolveThreadStatus(thread);
  if (status === "approval") return { label: "Pending Approval", colorClass: "text-warning-foreground", dotClass: "bg-warning", pulse: false };
  if (status === "input") return { label: "Awaiting Input", colorClass: "text-[#4f46e5] dark:text-[#a5b4fc]", dotClass: "bg-[#6366f1] dark:bg-[#a5b4fc]", pulse: false };
  if (status === "request") return { label: "Guest Request", colorClass: "text-guest-foreground", dotClass: "bg-guest", pulse: false };
  if (status === "working") return { label: "Working", colorClass: "text-info-foreground", dotClass: "bg-info", pulse: true };
  if (status === "preparing") return { label: "Connecting", colorClass: "text-info-foreground", dotClass: "bg-info", pulse: true };
  if (status === "waiting") return { label: "Waiting", colorClass: "text-muted-foreground", dotClass: "bg-muted-foreground", pulse: false };
  if (status === "failed" || status === "limited") return { label: "Failed", colorClass: "text-error-foreground", dotClass: "bg-error", pulse: false };
  if (hasUnseenCompletion(thread)) return { label: "Completed", colorClass: "text-success-foreground", dotClass: "bg-success", pulse: false };
  return null;
}
