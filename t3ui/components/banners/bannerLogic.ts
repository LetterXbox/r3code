// Show/hide rules and copy for every banner, ported from the reference's chat folder: ProviderStatusBanner.tsx,
// ThreadErrorBanner.tsx, ThreadActivityBanners.tsx, UsageLimitRecoveryBanner.tsx, ComposerServerUpdateStatus.tsx,
// useSystemComposerBanners.tsx and ChatView.logic.ts (branch mismatch). Pure: inputs are contract-shaped state.
import type { ProviderStatus } from "../../store";
import type { BackgroundTask, LimitRecovery, ProviderGoal, ThreadBannerShell } from "./threadBannerShell";
import type { BannerAction, BannerItem, LaneAlert } from "./bannerTypes";
import { presentRunStop, type RunStop } from "./threadSessionState";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE = "subscription_sharing_workplace_individual_usage_limit_exceeded";
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

// ---- Provider status (the lane) ----

export interface CompatibilityAdvisory { status: string; message: string | null }

/** `compatibilityAdvisory` off the server's raw provider snapshot. */
export function readCompatibilityAdvisory(raw: unknown): CompatibilityAdvisory | null {
  const advisory = record(record(raw)?.compatibilityAdvisory);
  return advisory && typeof advisory.status === "string" ? { status: advisory.status, message: typeof advisory.message === "string" && advisory.message ? advisory.message : null } : null;
}

function incompatibleVersion(status: ProviderStatus, advisory: CompatibilityAdvisory | null): CompatibilityAdvisory | null {
  if (status.status === "error" && status.authStatus === "unauthenticated") return null;
  return advisory?.status === "broken" || (status.status === "ready" && advisory?.status === "unsupported") ? advisory : null;
}

export function providerName(status: ProviderStatus): string {
  return status.name.trim() || status.driver;
}

export function providerStatusBannerKey(status: ProviderStatus | null, advisory: CompatibilityAdvisory | null = null): string | null {
  if (!status || status.status === "disabled") return null;
  const incompatible = incompatibleVersion(status, advisory);
  if (incompatible) return [status.instanceId, incompatible.status, status.version ?? "", incompatible.message ?? ""].join("\u0000");
  if (status.status === "ready") return null;
  // Antigravity validates credentials at session start; unknown restart auth is not failure.
  if (status.driver === "antigravity" && status.installed && status.status === "warning" && status.authStatus === "unknown") return null;
  return [status.instanceId, status.status, status.authStatus, status.message ?? ""].join("\u0000");
}

export function shouldShowProviderStatusBanner(status: ProviderStatus | null, dismissedKey: string | null, advisory: CompatibilityAdvisory | null = null): boolean {
  const key = providerStatusBannerKey(status, advisory);
  return key !== null && key !== dismissedKey;
}

export function hasProviderSetup(status: ProviderStatus): boolean {
  return status.driver === "antigravity" || status.canAuthenticate || status.canInstall;
}

export function providerStatusMessage(status: ProviderStatus, advisory: CompatibilityAdvisory | null = null): string {
  if (status.authStatus !== "unauthenticated" && advisory?.status === "broken" && advisory.message) return advisory.message;
  if (status.message) return status.message;
  if (!status.installed && hasProviderSetup(status)) return `Open provider setup to install ${status.driver} on this environment.`;
  if (status.authStatus === "unauthenticated") {
    if (hasProviderSetup(status)) return status.driver === "antigravity" ? "Open provider setup to sign in with Google." : "Open provider setup to sign in.";
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName(status)} provider is unavailable.`
      : `${providerName(status)} provider has limited availability.`;
}

export function providerStatusAlert(input: {
  status: ProviderStatus | null;
  advisory: CompatibilityAdvisory | null;
  dismissedKey: string | null;
  refreshing: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onOpenSetup: () => void;
  onDismiss: () => void;
}): LaneAlert | null {
  const { status, advisory } = input;
  if (!status || !shouldShowProviderStatusBanner(status, input.dismissedKey, advisory)) return null;
  const name = providerName(status);
  const unauthenticated = status.status === "error" && status.authStatus === "unauthenticated";
  const incompatible = incompatibleVersion(status, advisory);
  const title = unauthenticated
    ? `${name} is unauthenticated`
    : incompatible ? `${name} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}` : `${name} provider status`;
  const warning = incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null);
  const actions: BannerAction[] = [];
  if (hasProviderSetup(status)) actions.push({ id: "setup", label: "Open provider setup", tone: "inline", run: input.onOpenSetup });
  actions.push({ id: "refresh", label: input.refreshing ? "Refreshing..." : "Refresh", tone: "button", disabled: !input.canRefresh || input.refreshing, run: input.onRefresh });
  return {
    id: `provider-status:${status.instanceId}`,
    variant: warning ? "warning" : "error",
    role: incompatible && incompatible.status !== "broken" ? "status" : "alert",
    mark: "info",
    title,
    message: incompatible?.message ?? providerStatusMessage(status, advisory),
    actions,
    dismissLabel: `Dismiss ${name} provider ${status.status}`,
    onDismiss: input.onDismiss,
  };
}

// ---- Thread error (the lane) ----

export function threadErrorBannerMessage(error: string): string {
  let payload: unknown;
  try { payload = JSON.parse(error); } catch { return error; }
  const nested = record(record(payload)?.error);
  return nested && typeof nested.message === "string" && nested.message.trim().length > 0 ? nested.message : error;
}

/** ChatView's timelineThreadError: the usage-limit recovery card says what the error would, so the error hides. */
export function limitRecoveryActive(shell: Pick<ThreadBannerShell, "status" | "lastErrorClass" | "latestRunId"> | undefined): boolean {
  return shell?.status === "failed" && shell.lastErrorClass === "usage_limit" && shell.latestRunId !== null;
}

export function threadErrorAlert(input: {
  error: string | null;
  errorClass: string | null;
  errorCode: string | null;
  /** The thread's error is already told by the usage-limit recovery card. */
  limitRecoveryShown: boolean;
  dismissed: boolean;
  onCopyAdminRequest: () => void;
  onOpenChatGptUsage: () => void;
  onDismiss: () => void;
}): LaneAlert | null {
  const { error } = input;
  if (!error || input.dismissed || input.limitRecoveryShown) return null;
  const workspaceLimit = input.errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || input.errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const warning = input.errorClass === "usage_limit" || chatGptLimit;
  const actions: BannerAction[] = workspaceLimit
    ? [{ id: "copy-request", label: "Copy request for admin", tone: "button", run: input.onCopyAdminRequest }]
    : chatGptLimit ? [{ id: "manage-usage", label: "Manage usage", tone: "button", run: input.onOpenChatGptUsage }] : [];
  const collapsed = threadErrorBannerMessage(error);
  return {
    id: "thread-error",
    variant: warning ? "warning" : "error",
    role: "alert",
    mark: chatGptLimit ? "openai" : "alert",
    ...(chatGptLimit ? { title: "ChatGPT usage limit reached" } : {}),
    message: chatGptLimit ? (workspaceLimit ? "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits." : "") : collapsed,
    ...(!chatGptLimit && (collapsed !== error || error.length > 180 || error.includes("\n")) ? { full: error } : {}),
    actions,
    dismissLabel: "Dismiss error",
    onDismiss: input.onDismiss,
  };
}

// ---- Thread-now items (the end of the timeline) ----

const KIND_NAMES = {
  subagent: { order: 0, singular: "subagent", plural: "subagents" },
  command: { order: 1, singular: "command", plural: "commands" },
  monitor: { order: 2, singular: "monitor", plural: "monitors" },
  background_task: { order: 3, singular: "background task", plural: "background tasks" },
} as const;

/** backgroundWorkHoldsCompletion: work the agent declared it resumes on, or any subagent. */
export function backgroundWorkHoldsCompletion(tasks: readonly BackgroundTask[]): boolean {
  return tasks.some((task) => task.kind === "subagent" || task.awaited === true);
}

const joinAnd = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** commandDisplayText: the command a shell wrapper runs, without the wrapper (`bash -lc 'x'` shows `x`). */
export function commandDisplayText(command: string): string {
  const wrapped = command.trim().match(/^(?:\/\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return (wrapped ? wrapped[2] : command).trim();
}

export interface BackgroundWorkPresentation { title: string; items: { taskId: string; kind: BackgroundTask["kind"]; label: string; childThreadId?: string }[]; waiting: boolean }

export function presentPendingBackgroundWork(tasks: readonly BackgroundTask[]): BackgroundWorkPresentation | null {
  if (tasks.length === 0) return null;
  const waiting = backgroundWorkHoldsCompletion(tasks);
  const items = tasks.map((task) => {
    const description = task.description?.trim();
    const label = description === undefined || description === "" ? undefined : task.kind === "command" || task.kind === "monitor" ? commandDisplayText(description) : description;
    return { taskId: task.taskId, kind: task.kind, label: label === undefined || label.length === 0 ? KIND_NAMES[task.kind].singular : label, ...(task.kind === "subagent" && task.childThreadId ? { childThreadId: task.childThreadId } : {}) };
  }).sort((a, b) => KIND_NAMES[a.kind].order - KIND_NAMES[b.kind].order);
  const only = items.length === 1 ? items[0] : undefined;
  if (only) {
    const noun = KIND_NAMES[only.kind].singular;
    const title = only.label !== noun ? `${waiting ? "Waiting" : "Running"} · ${only.label}` : waiting ? `Waiting on a ${noun}` : `Running a ${noun}`;
    return { title, items, waiting };
  }
  const counts = new Map<BackgroundTask["kind"], number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = [...counts].map(([kind, count]) => `${count} ${count === 1 ? KIND_NAMES[kind].singular : KIND_NAMES[kind].plural}`);
  return { title: `${waiting ? "Waiting on" : "Running"} ${joinAnd(groups)}`, items, waiting };
}

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  const thousands = Math.round(tokens / 1_000);
  return thousands < 1_000 ? `${thousands}k` : `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const GOAL_TITLES: Record<ProviderGoal["status"], string> = {
  active: "Pursuing goal", paused: "Goal paused", blocked: "Goal blocked", usage_limited: "Goal hit a usage limit",
  budget_limited: "Goal reached its token budget", complete: "Goal complete",
};

export function presentProviderGoal(goal: ProviderGoal, working: boolean): { title: string; objective: string; usage: string | null; canResume: boolean } {
  const usage: string[] = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) usage.push(goal.tokenBudget == null ? `${formatGoalTokens(goal.tokensUsed)} tokens` : `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(goal.tokenBudget)} tokens`);
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  if (goal.checks !== undefined && goal.checks > 0) usage.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  return {
    title: goal.status === "active" && !working ? "Goal set" : GOAL_TITLES[goal.status],
    objective: goal.objective,
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}

export interface ChildInput { id: string; title: string; sideChat: boolean; hasPendingApprovals: boolean }

/** childThreadInputsTitle (client-runtime state/threadShell.ts). */
export function childThreadInputsTitle(children: readonly ChildInput[]): string {
  const approvals = children.filter((child) => child.hasPendingApprovals).length;
  const need = approvals === 0 ? "input" : approvals === children.length ? "approval" : "you";
  const sideChats = children.filter((child) => child.sideChat).length;
  const noun = sideChats === children.length ? "side chat" : sideChats === 0 ? "subagent" : "thread";
  return children.length === 1 ? `${noun === "side chat" ? "Side chat" : "Subagent"} needs ${need}` : `${children.length} ${noun}s need ${need}`;
}

/** What the end of the timeline says the thread is doing, in the reference's order: child input, goal, stop, background work. */
export interface ThreadNowItem {
  id: string;
  icon: BannerItem["icon"];
  /** Tint: "info" and "warning" colour the mark; otherwise the muted default. */
  tone?: "info" | "warning";
  title: string;
  description?: string;
  /** Child threads named in the description, each openable. */
  threads?: { id: string; title: string }[];
  elapsedSince?: string | null;
  actions: BannerAction[];
  /** The label the thread-status row shows while this is the latest line ("Subagent waiting"). */
  waitingLabel?: string;
}

export function childInputNowItem(input: { children: readonly ChildInput[]; parentAwaitingUser: boolean; onOpenThread: (threadId: string) => void }): ThreadNowItem | null {
  const first = input.children[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    icon: first.hasPendingApprovals ? "shield-question" : "message-circle",
    tone: "info",
    title: childThreadInputsTitle(input.children),
    waitingLabel: input.children.every((child) => child.sideChat) ? "Side chat waiting" : "Subagent waiting",
    threads: input.children.map((child) => ({ id: child.id, title: child.title })),
    actions: [{ id: "open", label: first.hasPendingApprovals ? "Open approval" : "Open question", tone: "inline", run: () => input.onOpenThread(first.id) }],
  };
}

export function goalNowItem(input: { threadId: string; goal: ProviderGoal; isWorking: boolean; onSendCommand: (text: string, failureMessage: string) => void }): ThreadNowItem {
  const presentation = presentProviderGoal(input.goal, input.isWorking);
  const actions: BannerAction[] = [];
  // Clear stops goal work; Resume would stop unrelated work, so it waits.
  if (presentation.canResume && !input.isWorking) actions.push({ id: "resume", label: "Resume", tone: "inline", run: () => input.onSendCommand("/goal resume", "Failed to resume goal.") });
  actions.push({ id: "clear", label: "Clear", tone: "muted", run: () => input.onSendCommand("/goal clear", "Failed to clear goal.") });
  return {
    id: `goal:${input.threadId}`, icon: "target",
    title: presentation.usage === null ? presentation.title : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective, actions,
  };
}

export function runStopNowItem(input: { threadId: string; stop: RunStop; canForceStop: boolean; forceStopping: boolean; onForceStop: () => void }): ThreadNowItem {
  const unresponsive = input.stop.state === "unresponsive";
  const actions: BannerAction[] = [];
  if (unresponsive && input.canForceStop) actions.push({ id: "force-stop", label: input.forceStopping ? "Force stopping..." : "Force stop", tone: "inline", disabled: input.forceStopping, run: input.onForceStop });
  return {
    id: `run-stop:${input.threadId}`,
    icon: unresponsive ? "triangle-alert" : "circle-stop",
    ...(unresponsive ? { tone: "warning" as const } : {}),
    title: unresponsive ? "Agent not responding to Stop" : "Stopping",
    ...(unresponsive ? { description: "It may be short on memory. Force stop kills its processes." } : {}),
    elapsedSince: input.stop.requestedAt,
    actions,
  };
}

export function backgroundWorkNowItem(input: {
  threadId: string; tasks: readonly BackgroundTask[]; startedAt: (taskId: string) => string | null; activity: (taskId: string) => string | null;
  stopDisabled: boolean; stopping: boolean; onStop: () => void; onOpenThread: (threadId: string) => void;
}): ThreadNowItem | null {
  const presentation = presentPendingBackgroundWork(input.tasks);
  if (!presentation) return null;
  const rows = presentation.items.map((task) => ({ task, activity: input.activity(task.taskId) }));
  const only = rows.length === 1 ? rows[0] : undefined;
  const newest = rows.find((row) => row.activity);
  const actions: BannerAction[] = [];
  if (only?.task.childThreadId) { const id = only.task.childThreadId; actions.push({ id: "open", label: "Open", tone: "muted", run: () => input.onOpenThread(id) }); }
  actions.push({ id: "stop", label: input.stopping ? "Stopping..." : "Stop", tone: "inline", disabled: input.stopDisabled, run: input.onStop });
  return {
    id: `background-work:${input.threadId}`,
    icon: rows.every((row) => row.task.kind !== "subagent") ? "terminal" : "circle-dashed",
    title: presentation.title,
    description: only ? only.activity ?? undefined : newest ? `${newest.task.label}: ${newest.activity}` : rows.map((row) => row.task.label).join(", "),
    elapsedSince: only ? input.startedAt(only.task.taskId) : null,
    actions,
  };
}

/** The Stop the background-work row sent stays pending while its tasks are listed (isBackgroundWorkStopPending). */
export const BACKGROUND_WORK_STOP_RETRY_AFTER_MS = 10_000;
export interface BackgroundWorkStopRequest { threadKey: string; taskIds: string[]; retryAt: number | null }
export function isBackgroundWorkStopPending(request: BackgroundWorkStopRequest | null, threadKey: string, tasks: readonly Pick<BackgroundTask, "taskId">[], retryExpired: boolean): boolean {
  if (request === null || request.threadKey !== threadKey || retryExpired) return false;
  return request.retryAt === null || tasks.some((task) => request.taskIds.includes(task.taskId));
}

/** What the end of the timeline shows, in render order (ThreadNow): attention, work, then the goal. */
export interface ThreadNowSlots { attention: ThreadNowItem | null; work: ThreadNowItem | null; goal: ThreadNowItem | null }

/**
 * The rows for the open thread (useThreadLifecycle's attentionNow / workNow / goalNow). An unresponsive Stop outranks
 * a subagent's question; a pending Stop takes the work row from background work. A background Stop matters only while
 * that work is still pending.
 */
export function threadNowSlots(input: {
  shell: ThreadBannerShell | undefined; sessionRuns: Pick<import("./threadSessionState").ThreadSessionState, "runs" | "interrupts">;
  isWorking: boolean; children: readonly ChildInput[]; parentAwaitingUser: boolean; threadId: string;
  canOperate: boolean; canForceStop: boolean; forceStopping: boolean; stoppingBackground: boolean;
  taskStartedAt: (taskId: string) => string | null; taskActivity: (taskId: string) => string | null;
  onSendCommand: (text: string, failureMessage: string) => void; onForceStop: (runId: string) => void; onStopBackground: () => void; onOpenThread: (threadId: string) => void;
}): ThreadNowSlots {
  const tasks = !input.isWorking ? input.shell?.pendingBackgroundTasks ?? [] : [];
  const childInput = childInputNowItem({ children: input.children, parentAwaitingUser: input.parentAwaitingUser, onOpenThread: input.onOpenThread });
  const goal = input.shell?.goal ? goalNowItem({ threadId: input.threadId, goal: input.shell.goal, isWorking: input.isWorking, onSendCommand: input.onSendCommand }) : null;
  const anyStop = presentRunStop(input.sessionRuns);
  const stop = anyStop?.background && tasks.length === 0 ? null : anyStop;
  const stopItem = stop ? runStopNowItem({ threadId: input.threadId, stop, canForceStop: input.canForceStop, forceStopping: input.forceStopping, onForceStop: () => input.onForceStop(stop.runId) }) : null;
  const background = backgroundWorkNowItem({ threadId: input.threadId, tasks, startedAt: input.taskStartedAt, activity: input.taskActivity, stopDisabled: !input.canOperate || input.stoppingBackground, stopping: input.stoppingBackground, onStop: input.onStopBackground, onOpenThread: input.onOpenThread });
  return {
    attention: stop?.state === "unresponsive" ? stopItem : childInput,
    work: stop?.state === "stopping" ? stopItem : background,
    goal,
  };
}

// ---- Composer banners ----

export interface BranchMismatch { threadBranch: string; currentBranch: string }

/** resolveLocalCheckoutBranchMismatch: a local-checkout thread whose checkout moved off the branch it last ran on. */
export function resolveLocalCheckoutBranchMismatch(input: { local: boolean; worktreePath: string | null; threadBranch: string | null; currentBranch: string | null }): BranchMismatch | null {
  if (!input.local || input.worktreePath !== null) return null;
  if (!input.threadBranch || !input.currentBranch || input.threadBranch === input.currentBranch) return null;
  return { threadBranch: input.threadBranch, currentBranch: input.currentBranch };
}

export function branchMismatchKey(threadId: string | null, mismatch: BranchMismatch | null): string | null {
  return !threadId || !mismatch ? null : `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

/** Composer autofocus makes focus unreliable as draft intent: the banner waits for draft content, then stays. */
export function shouldShowBranchMismatchBanner(input: { hasMismatch: boolean; isDismissed: boolean; composerHasContent: boolean; wasShownForCurrentMismatch: boolean }): boolean {
  if (!input.hasMismatch || input.isDismissed) return false;
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

export function branchMismatchItem(input: { key: string; mismatch: BranchMismatch; restoreDisabled: boolean; restoring: boolean; onRestore: () => void; onDismiss: () => void }): BannerItem {
  return {
    id: `branch-mismatch:${input.key}`,
    variant: "info",
    icon: "git-branch",
    title: `Branch changed from ${input.mismatch.threadBranch}`,
    description: `This thread last ran on ${input.mismatch.threadBranch}. Sending will continue on ${input.mismatch.currentBranch}.`,
    actions: [{ id: "restore", label: input.restoring ? "Restoring..." : "Restore branch", tone: "button", disabled: input.restoreDisabled, run: input.onRestore }],
    dismissLabel: "Dismiss branch change notice",
    onDismiss: input.onDismiss,
  };
}

export function extensionStatusItem(statuses: readonly { key: string; text: string }[]): BannerItem | null {
  if (statuses.length === 0) return null;
  return { id: "pi-extension-status", variant: "default", icon: "sparkles", title: `Pi · ${statuses.map((status) => status.text).join(" · ")}`, actions: [] };
}

export interface RecoveryInput {
  runId: string; errorCode: string | null; resetAt: string | null; stoppedAt: string; settled: boolean; requestPending: boolean;
  snoozedUntil: string | null; recovery: LimitRecovery | null; now: number;
  /** "tomorrow at 9:00 AM": the reference's formatUpcomingTimestamp in the viewer's timestamp format. */
  formatUpcoming: (iso: string) => string;
  pending: boolean;
  onToggle: (action: "resume" | "snooze") => void;
  onCopyAdminRequest: () => void;
  onOpenChatGptUsage: () => void;
}

/** limitRecoveryOwnsSnooze: the snooze this recovery set (a snooze past the reset belongs to the user). */
export function limitRecoveryOwnsSnooze(input: { runId: string | null | undefined; resetAt: string | null | undefined; recovery: LimitRecovery | null | undefined; snoozedUntil: string | null | undefined }): boolean {
  const { recovery } = input;
  return Boolean(recovery && input.runId && recovery.runId === input.runId && recovery.resetAt === input.resetAt && recovery.snooze === true && input.snoozedUntil);
}

export function usageLimitRecoveryItem(input: RecoveryInput): BannerItem {
  const { runId, resetAt, recovery } = input;
  // The server refuses recovery changes while a request is pending.
  const canSchedule = !input.settled && !input.requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(input.stoppedAt);
  const scheduled = recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume === true;
  const resumes = canSchedule && scheduled;
  const workspaceLimit = input.errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || input.errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const resetPassed = resetAt !== null && Date.parse(resetAt) <= input.now;
  const snoozed = limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil: input.snoozedUntil }) && !resetPassed;
  const displayAt = resumes && resetAt && input.snoozedUntil && Date.parse(input.snoozedUntil) > Date.parse(resetAt) ? input.snoozedUntil : resetAt;
  const resetDescription = displayAt ? `${resumes ? "Resumes" : "Resets"} ${input.formatUpcoming(displayAt)}` : "Reset time unavailable; retry manually";
  const actions: BannerAction[] = [];
  if (canSchedule) {
    actions.push({ id: "resume-at-reset", label: input.pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset", tone: "inline", disabled: input.pending, run: () => input.onToggle("resume") });
    actions.push({ id: "snooze", label: input.pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset", tone: "inline", disabled: input.pending || (!snoozed && resetPassed), run: () => input.onToggle("snooze") });
  }
  if (!chatGptLimit) return { id: `usage-limit-recovery:${runId}`, variant: "warning", group: "environment", icon: "gauge", title: "Usage limit reached", description: resetDescription, actions };
  actions.push(workspaceLimit
    ? { id: "copy-request", label: "Copy request for admin", tone: "button", run: input.onCopyAdminRequest }
    : { id: "manage-usage", label: "Manage usage", tone: "button", run: input.onOpenChatGptUsage });
  return {
    id: `usage-limit-recovery:${runId}`, variant: "warning", group: "environment", icon: "gauge", title: "ChatGPT usage limit reached",
    description: workspaceLimit ? "You've reached your workspace's limit for using your ChatGPT plan in other apps." : resetDescription, actions,
  };
}

export interface EnvironmentInput {
  /** The store's connection status: only a lost or failed link is an unavailable environment. */
  status: "disconnected" | "connecting" | "connected" | "error";
  label: string;
  error: string | null;
  /** Each reconnect attempt gets its own grace period before the banner shows (ENVIRONMENT_RECONNECT_WARNING_GRACE_MS). */
  graceElapsed: boolean;
  /** A server update is running: the reconnect is expected. */
  updateRunning: boolean;
  onReconnect: () => void;
  /** useSystemComposerBanners disconnectAction: a saved environment unavailable for 20 s can be switched off. */
  onDisconnect?: () => void;
  disconnecting?: boolean;
}

/** useEnvironmentDisconnectDelay DISCONNECT_DELAY_MS. */
export const ENVIRONMENT_DISCONNECT_DELAY_MS = 20_000;

/** The "Disconnect server" action shared by the offline notice and a running server update. */
export function disconnectServerAction(onDisconnect: () => void, disconnecting = false): BannerAction {
  return { id: "disconnect", label: "Disconnect server", tone: "button", disabled: disconnecting, title: "Hide this server's threads. Switch it on again in Environments.", run: onDisconnect };
}

export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 3_000;

export function environmentUnavailableItem(input: EnvironmentInput): BannerItem | null {
  if (input.status === "connected") return null;
  const reconnecting = input.status === "connecting";
  if (reconnecting && (input.updateRunning || !input.graceElapsed)) return null;
  const actions: BannerAction[] = reconnecting ? [] : [{ id: "reconnect", label: "Reconnect", tone: "button", run: input.onReconnect }];
  if (input.onDisconnect) actions.push(disconnectServerAction(input.onDisconnect, input.disconnecting));
  return {
    id: "environment-unavailable",
    variant: input.status === "error" ? "error" : "warning",
    group: "environment",
    icon: "wifi-off",
    title: `${input.label} is ${reconnecting ? "reconnecting" : "offline"}`,
    description: input.error ?? (input.status === "disconnected" ? "Environment disconnected. Your draft is kept here." : undefined),
    actions,
  };
}

/** The composer's banners in the reference's order, then stably sorted by group (environment before attention). */
export function orderComposerBanners(items: readonly BannerItem[]): BannerItem[] {
  return (["environment", "attention"] as const).flatMap((group) => items.filter((item) => (item.group ?? "attention") === group));
}

// ---- Timestamps ----

/** formatUpcomingTimestamp (timestampFormat.ts): today the time, tomorrow "tomorrow at <time>", a past day the day-aware form. */
export function formatUpcomingTimestamp(iso: string, format: import("../thread/timestampFormat").TimestampFormat, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const base: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const time = new Intl.DateTimeFormat(undefined, format === "locale" ? base : { ...base, hour12: format === "12-hour" }).format(new Date(ms));
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
  const target = new Date(ms);
  const now = new Date(nowMs);
  const diff = day(target) - day(now);
  if (diff < 0) {
    const options: Intl.DateTimeFormatOptions = target.getFullYear() === now.getFullYear() ? { month: "numeric", day: "numeric" } : { month: "numeric", day: "numeric", year: "numeric" };
    return diff === -1 ? `yesterday at ${time}` : `${new Intl.DateTimeFormat(undefined, options).format(target)} ${time}`;
  }
  if (diff === 0) return time;
  if (diff === 1) return `tomorrow at ${time}`;
  const options: Intl.DateTimeFormatOptions = target.getFullYear() === now.getFullYear() ? { month: "numeric", day: "numeric" } : { month: "numeric", day: "numeric", year: "numeric" };
  return `${new Intl.DateTimeFormat(undefined, options).format(target)} ${time}`;
}
