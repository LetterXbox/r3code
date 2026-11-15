// How the composer reads the open thread's runs: ports of resolveComposerDispatchMode
// (client-runtime state/composerDispatch.ts) and deriveThreadQueueWorkflowState /
// deriveResumableRunId (state/threadWorkflows.ts, state/threadExecution.ts), over the run
// records the thread subscription delivers.

export type FollowUpBehavior = "queue" | "steer";
export type ComposerDispatchMode = "auto" | "queue" | "steer";

/** What a send does: idle starts a turn; during a turn the default follow-up, flipped by the alternate modifier. */
export function resolveComposerDispatchMode(input: {
  running: boolean;
  alternateModifier: boolean;
  activeTurnDefault?: FollowUpBehavior;
  /** False while the active turn cannot take steering input, such as during compaction. */
  canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

/** derivePhase: only a running or waiting run is "running"; preparing, starting and queued runs are "connecting". */
export function isRunningPhase(status: string | null | undefined): boolean {
  return status === "running" || status === "waiting";
}

/**
 * What a send does for the open thread's run, as ChatComposer and planComposerTurn decide it. A run that is
 * still preparing or starting is not "running", so the send goes out as "auto" and the server queues it behind
 * that run; only a running turn takes a steer, and one that cannot be steered (compaction) queues.
 */
export function resolveSendIntent(input: {
  /** The active run's status, or null when no run is active. */
  runStatus: string | null;
  alternateModifier: boolean;
  activeTurnDefault?: FollowUpBehavior;
  canSteer?: boolean;
  /** A fresh provider session never steers into the running turn. */
  freshContext?: boolean;
}): ComposerDispatchMode {
  const mode = resolveComposerDispatchMode({
    running: isRunningPhase(input.runStatus),
    alternateModifier: input.alternateModifier,
    ...(input.activeTurnDefault ? { activeTurnDefault: input.activeTurnDefault } : {}),
    ...(input.canSteer === undefined ? {} : { canSteer: input.canSteer }),
  });
  return input.freshContext && mode === "steer" ? "queue" : mode;
}

/** Contract error tags a rejected `message.dispatch` carries (orchestrationV2.ts, orchestrationDispatch.ts). */
const DISPATCH_REFUSAL_TAGS = new Set(["OrchestrationV2DispatchCommandError", "OrchestrationDispatchCommandError"]);

/**
 * The server rejected the command itself (a tagged contract error), as opposed to the transport failing. The
 * server states no machine-readable reason for refusing a steer (run not running, stopping, no provider session,
 * no running provider turn), so a rejected steer is told apart by its tag, never by its message text.
 */
export function isSteerRefusal(error: unknown): boolean {
  const tag = typeof error === "object" && error !== null ? (error as { tag?: unknown }).tag : undefined;
  return typeof tag === "string" && DISPATCH_REFUSAL_TAGS.has(tag);
}

/**
 * Sends with the intent given. A steer (or an automatic send the server resolved to a steer) that lost a race with the run's state is sent again as a
 * queued message, so the user sees the message wait its turn and never the server's refusal.
 */
export async function sendWithSteerFallback<T>(send: (mode: ComposerDispatchMode) => Promise<T>, intent: ComposerDispatchMode): Promise<T> {
  try {
    return await send(intent);
  } catch (error) {
    if (intent === "queue" || !isSteerRefusal(error)) throw error;
    return send("queue");
  }
}

export function alternateComposerDispatchAction(activeTurnDefault?: FollowUpBehavior): FollowUpBehavior {
  return resolveComposerDispatchMode({ running: true, alternateModifier: true, ...(activeTurnDefault ? { activeTurnDefault } : {}) }) as FollowUpBehavior;
}

export function followUpFromSetting(value: unknown): FollowUpBehavior {
  return value === "queue" ? "queue" : "steer";
}

export interface RunInfo {
  id: string; status: string; ordinal: number; queuePosition: number | null; queueHeld: boolean;
  userMessageId: string; freshContext: boolean; startedAt: string | null;
}

export function parseRuns(records: readonly Record<string, unknown>[]): RunInfo[] {
  return records.flatMap((item): RunInfo[] => {
    if (typeof item.id !== "string" || typeof item.status !== "string" || typeof item.userMessageId !== "string") return [];
    return [{
      id: item.id, status: item.status, ordinal: typeof item.ordinal === "number" ? item.ordinal : 0,
      queuePosition: typeof item.queuePosition === "number" ? item.queuePosition : null,
      queueHeld: item.queueHeld === true, userMessageId: item.userMessageId, freshContext: item.freshContext === true,
      startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
    }];
  });
}

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

export interface QueuedMessage {
  runId: string; messageId: string; text: string; freshContext: boolean;
  attachments: { id: string; name: string; mimeType: string; sizeBytes: number; type: string }[];
  /** The queued turn's user message fields its attribution reads (QueuedRunsControl QueuedMessage). */
  source?: { createdBy?: string; creationSource?: string; scheduledTaskId?: string; senderThreadId?: string; context?: unknown };
}

export interface QueueState {
  activeRun: RunInfo | null;
  queued: QueuedMessage[];
  isHeld: boolean;
  canSendNow: boolean;
  canPromoteToSteer: boolean;
  /** The active run is a `/compact`: a queued message may start it without steering, and nothing can steer into it. */
  promoteSkipsCompaction: boolean;
  resumableRunId: string | null;
}

interface MessageLike { id: string; body: string; attachments?: QueuedMessage["attachments"]; createdBy?: string; creationSource?: string; scheduledTaskId?: string; senderThreadId?: string; context?: unknown }

export function deriveQueueState(runs: RunInfo[], messages: readonly MessageLike[], steer?: { canPromoteToSteer: boolean; promoteSkipsCompaction: boolean }, automaticMessageIds: readonly string[] = []): QueueState {
  const activeRun = [...runs].reverse().find((run) => ACTIVE.has(run.status)) ?? null;
  const automatic = new Set(automaticMessageIds);
  const queued = runs
    .filter((run) => run.status === "queued" && !automatic.has(run.userMessageId))
    .sort((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal) || a.ordinal - b.ordinal)
    .map((run): QueuedMessage => {
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      const context = message?.context && typeof message.context === "object" ? message.context as Record<string, unknown> : null;
      const guest = context?.guest && typeof context.guest === "object" ? context.guest as Record<string, unknown> : null;
      const displayText = typeof guest?.text === "string" ? guest.text : message?.body ?? "Queued message";
      const source = message ? {
        ...(message.createdBy ? { createdBy: message.createdBy } : {}), ...(message.creationSource ? { creationSource: message.creationSource } : {}),
        ...(message.scheduledTaskId ? { scheduledTaskId: message.scheduledTaskId } : {}), ...(message.senderThreadId ? { senderThreadId: message.senderThreadId } : {}),
        ...(message.context !== undefined ? { context: message.context } : {}),
      } : undefined;
      return { runId: run.id, messageId: run.userMessageId, text: displayText, freshContext: run.freshContext, attachments: message?.attachments ?? [], ...(source ? { source } : {}) };
    });
  // latestExecutedRun: the newest run that is neither queued nor a cancelled run that never started.
  let latest: RunInfo | null = null;
  for (const run of runs) {
    if (run.status === "queued" || (run.status === "cancelled" && run.startedAt === null)) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return {
    activeRun, queued,
    isHeld: runs.some((run) => run.status === "queued" && run.queueHeld),
    canSendNow: activeRun === null,
    // Without provider state only a running turn can be steered; with it, the provider must also take steering (deriveSteerState).
    canPromoteToSteer: steer ? steer.canPromoteToSteer : activeRun?.status === "running",
    promoteSkipsCompaction: steer?.promoteSkipsCompaction ?? false,
    resumableRunId: latest?.status === "interrupted" ? latest.id : null,
  };
}

/** The label a primary send action carries, in the order ComposerPrimaryActions resolves it. */
export function submitLabel(input: {
  showResume: boolean; editingQueued: boolean; running: boolean; mode: ComposerDispatchMode;
  /** The next send summarizes a stale conversation first. */
  compactsBeforeSend?: boolean;
}): string {
  if (input.showResume) return "Resume thread";
  if (input.editingQueued) return "Update queued message";
  if (input.compactsBeforeSend) return "Compact and send";
  if (input.mode === "queue") return "Queue message";
  if (input.running) return "Steer message";
  return "Submit message";
}

/** Tooltip while a turn runs: click does the default, the modifier-click the other. */
/** ComposerPrimaryActions submitStatus: why the send button is busy or unavailable, before any other tooltip. */
export function submitStatus(input: { environmentUnavailable: boolean; voicePreparing?: boolean; preparingWorktree?: boolean; sending: boolean; editingQueued: boolean }): string | null {
  if (input.environmentUnavailable) return "Environment disconnected";
  // voiceSendDisabledReason (ChatComposer): the send waits for the dictation session to open.
  if (input.voicePreparing) return "Preparing voice input";
  if (input.preparingWorktree) return "Preparing worktree";
  if (input.sending) return input.editingQueued ? "Updating queued message" : "Submitting message";
  return null;
}

export function submitTooltip(input: { running: boolean; editingQueued: boolean; canSteer: boolean; followUp: FollowUpBehavior; label: string; mac: boolean; compactTokens?: string | null; status?: string | null; alternateShortcut?: string | null }): string {
  if (input.status) return input.status;
  if (input.compactTokens) return `Summarize ${input.compactTokens} tokens of history, then send`;
  if (input.running && !input.editingQueued && input.canSteer) {
    return `Click to ${input.followUp}, ${input.mac ? "⌘" : "Ctrl"}-click${input.alternateShortcut ? ` or ${input.alternateShortcut}` : ""} to ${alternateComposerDispatchAction(input.followUp)}`;
  }
  return input.label;
}
