// The thread shell fields the sidebar reads beyond title/pin/status. They come
// straight off OrchestrationV2ThreadShell (packages/contracts/src/orchestrationV2.ts)
// so the sidebar can tell approval from input, unread from read, snoozed from active.

import { badgeLinkFromShell, resolveCurrentLink, stackBadgeFromShell, type ThreadPullRequestStackBadge } from "./threadPullRequestStack";

export type ThreadRunStatus =
  | "idle" | "preparing" | "queued" | "starting" | "running" | "waiting"
  | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";

export interface ThreadSidebarMeta {
  /** The shell's own status: the latest run's state, or idle. */
  runStatus: ThreadRunStatus;
  /** `activityRunStatus`: set while a run is live (preparing, starting, running, waiting). */
  activityRunStatus: string | null;
  /** `pendingRuntimeRequest.kind`: user_input is a question, anything else an approval. */
  pendingRequestKind: string | null;
  pendingGuestMessageCount: number;
  blockedOnThreadWait: boolean;
  lastErrorClass: string | null;
  /** Epoch ms of the last visit; null when the server has no watermark yet. */
  lastVisitedAt: number | null;
  latestRunCompletedAt: number | null;
  latestRunStartedAt: number | null;
  snoozedUntil: number | null;
  /** `snoozedAt`: when the snooze was set; an early wake compares newer requests and failures against it. */
  snoozedAt?: number | null;
  /** `pendingRuntimeRequest.createdAt`: when the open question or approval was raised. */
  pendingRequestAt?: number | null;
  settled: boolean;
  hasActionableProposedPlan: boolean;
  branch: string | null;
  titleRegenerating: boolean;
  /** `autoSettleDisabledAt` is set: this thread opted out of auto-settle. */
  autoSettleDisabled?: boolean;
  /** The server's fractional keys that order Pinned and Active rows. */
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
  /** The pull request the row's badge names, when the thread has one. */
  pullRequest?: ThreadPullRequestBadge | null;
  /**
   * The shell's runtime status (shellRuntime in client-runtime models.ts): null when the thread
   * never ran, "idle" while background work parks a finished run, else the activity run's status
   * or the shell status. Absent on fixtures that predate it; readers then fall back to runStatus.
   */
  runtimeStatus?: string | null;
  interactionMode?: string | null;
  latestRunId?: string | null;
  activeRunId?: string | null;
  latestRunRequestedAt?: number | null;
  /** `activityRunStartedAt`; undefined when the server did not send the field at all. */
  activityStartedAt?: number | null;
  latestUserAuthoredMessageAt?: number | null;
  unsettledAt?: number | null;
  /** The shell's `settledAt`: when the thread was settled (ThreadStatusLine reads "Settled 5m ago"). */
  settledAt?: number | null;
  goalActive?: boolean;
  /** A live subagent or side chat under this thread asks for approval (derived, see subagentRequests.ts): the thread is not Working. */
  pendingSubagentRequest?: boolean;
  /** The provider instance the thread runs on now, and the ones it ran on before. */
  providerInstanceId?: string | null;
  providerInstanceHistory?: string[];
  /** `modelSelection.model`. */
  model?: string | null;
}

export type PullRequestBadgeState = "open" | "draft" | "merged" | "closed";

export interface ThreadPullRequestBadge {
  number: number;
  url: string;
  state: PullRequestBadgeState;
  /** Several links: one stack ("Stack of N") or the newest with others linked ("+N"), with their overall state (threadPullRequestStack.ts). */
  many?: ThreadPullRequestStackBadge;
  /** The legacy linked or branch pull request (no link list): its state comes from the linked summary (useLinkedThreadPullRequest). */
  fallback?: { kind: "linked" | "branch"; projectId: string; repository: string; number: number; url: string };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

/**
 * The pull request a row's badge shows (resolveThreadCurrentPullRequestLink, then the linked and
 * branch pull requests): the one open link, the top of an open stack, else the top of the only chain or the most
 * recently updated link, with its state from the link's snapshot. A link with no snapshot yet reads as open.
 */
export function pullRequestBadgeFromShell(value: Record<string, unknown>): ThreadPullRequestBadge | null {
  const links = Array.isArray(value.pullRequests) ? value.pullRequests.flatMap((raw) => { const link = badgeLinkFromShell(raw); return link ? [link] : []; }) : [];
  const link = resolveCurrentLink(links.filter((item) => typeof item.url === "string"));
  if (link && link.url !== undefined) {
    const snapshot = link.snapshot;
    const state = snapshot?.state === "merged" ? "merged" : snapshot?.state === "closed" ? "closed" : snapshot?.isDraft === true ? "draft" : "open";
    const many = stackBadgeFromShell(value);
    return { number: link.number, url: link.url, state, ...(many ? { many } : {}) };
  }
  const legacy = record(value.linkedPullRequest);
  const linked = legacy ?? record(value.branchPullRequest);
  if (linked && typeof linked.number === "number" && typeof linked.url === "string") {
    const fallback = typeof linked.projectId === "string" && typeof linked.repository === "string"
      ? { fallback: { kind: legacy ? "linked" as const : "branch" as const, projectId: linked.projectId, repository: linked.repository, number: linked.number, url: linked.url } } : {};
    return { number: linked.number, url: linked.url, state: "open", ...fallback };
  }
  return null;
}

function epoch(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const RUN_STATUSES: readonly string[] = [
  "idle", "preparing", "queued", "starting", "running", "waiting",
  "completed", "interrupted", "failed", "cancelled", "rolled_back",
];

/** Reads the sidebar's fields off a raw shell thread record. */
export function threadMetaFromShell(value: Record<string, unknown>): ThreadSidebarMeta {
  const request = value.pendingRuntimeRequest;
  const kind = request && typeof request === "object" ? text((request as Record<string, unknown>).kind) : null;
  const status = typeof value.status === "string" && RUN_STATUSES.includes(value.status)
    ? (value.status as ThreadRunStatus)
    : "idle";
  return {
    runStatus: status,
    activityRunStatus: text(value.activityRunStatus),
    pendingRequestKind: request ? (kind ?? "approval") : null,
    pendingGuestMessageCount: typeof value.pendingGuestMessageCount === "number" ? value.pendingGuestMessageCount : 0,
    blockedOnThreadWait: value.blockedOnThreadWait === true,
    lastErrorClass: text(value.lastErrorClass),
    lastVisitedAt: epoch(value.lastVisitedAt),
    latestRunCompletedAt: epoch(value.latestRunCompletedAt),
    latestRunStartedAt: epoch(value.latestRunStartedAt) ?? epoch(value.activityRunStartedAt),
    snoozedUntil: epoch(value.snoozedUntil),
    snoozedAt: epoch(value.snoozedAt),
    pendingRequestAt: request && typeof request === "object" ? epoch((request as Record<string, unknown>).createdAt) : null,
    settled: value.settledOverride === "settled",
    hasActionableProposedPlan: value.hasActionableProposedPlan === true,
    branch: text(value.branch),
    titleRegenerating: value.titleRegeneration != null,
    autoSettleDisabled: value.autoSettleDisabledAt != null,
    pinOrderKey: text(value.pinOrderKey),
    activeOrderKey: text(value.activeOrderKey),
    pullRequest: pullRequestBadgeFromShell(value),
    runtimeStatus: runtimeStatusFromShell(value, status),
    interactionMode: text(value.interactionMode),
    latestRunId: text(value.latestRunId),
    activeRunId: text(value.activeRunId),
    latestRunRequestedAt: epoch(value.latestRunRequestedAt),
    activityStartedAt: "activityRunStartedAt" in value ? epoch(value.activityRunStartedAt) : undefined,
    latestUserAuthoredMessageAt: "latestUserAuthoredMessageAt" in value ? epoch(value.latestUserAuthoredMessageAt) : undefined,
    unsettledAt: epoch(value.unsettledAt),
    settledAt: epoch(value.settledAt),
    goalActive: record(value.goal)?.status === "active",
    providerInstanceId: text(value.providerInstanceId) ?? text(record(value.modelSelection)?.instanceId),
    providerInstanceHistory: Array.isArray(value.providerInstanceHistory)
      ? value.providerInstanceHistory.filter((id): id is string => typeof id === "string")
      : [],
    model: text(record(value.modelSelection)?.model),
  };
}

/** backgroundWorkHoldsCompletion: subagents and background tasks hold; commands and monitors only when awaited. */
function backgroundWorkHolds(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((task) => {
    const item = record(task);
    if (!item) return false;
    return item.awaited === true || item.kind === "subagent" || item.kind === "background_task";
  });
}

/** shellRuntime (client-runtime models.ts): the status the sidebar reads as the thread's runtime. */
export function runtimeStatusFromShell(value: Record<string, unknown>, status: string): string | null {
  const parked = backgroundWorkHolds(value.pendingBackgroundTasks) && status !== "failed";
  if (text(value.latestRunId) === null && text(value.activeProviderThreadId) === null && !parked) return null;
  return parked ? "idle" : (text(value.activityRunStatus) ?? status);
}
