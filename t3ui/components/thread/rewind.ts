// "Edit from here": rewind the thread to just before a user message and put that
// message back in the composer. Ported from chat/useTimelineRewind.ts,
// chat/chatViewSend.ts (rewindToMessage), ChatView.logic.ts
// (deriveAvailableRevertTurnCounts, waitForRevertedMessage) and
// session-logic.ts (deriveRevertTurnCountByUserMessageId, findRevertCheckpoint).
import { record } from "../../backend/client";
import { backendConnectionGeneration, backendStatus, backendUrl, openThread, requestBackend } from "../../store";
import type { Message, Thread } from "../../store";
import { readAttachment } from "./readAttachment";

export interface RewindTarget {
  turnCount: number;
  /** The live checkpoint identity, when the projection has one for the target. */
  checkpoint?: { id: string; scopeId: string };
  /** The newest settled run past the target; rollback is done when it reads rolled_back. */
  witnessRunId: string;
}

const SETTLED_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);
const REWIND_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** findRevertCheckpoint: the newest ready checkpoint for a turn count (0 is the thread start). */
export function findRevertCheckpoint(checkpoints: Record<string, unknown>[], turnCount: number): Record<string, unknown> | undefined {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint.status !== "ready") continue;
    if (turnCount === 0 ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null : checkpoint.appRunOrdinal === turnCount) return checkpoint;
  }
  return undefined;
}

/**
 * deriveAvailableRevertTurnCounts: a ready file checkpoint alone cannot restore the
 * provider conversation, so a turn count is available only when the active provider
 * thread owns that run's latest provider turn.
 */
export function availableRevertTurnCounts(projection: Record<string, unknown>): Set<number> {
  const available = new Set<number>();
  const thread = record(projection.thread);
  const providerThread = rows(projection.providerThreads).find((candidate) => candidate.id === thread?.activeProviderThreadId);
  const selection = record(thread?.modelSelection);
  if (!providerThread || !nonempty(providerThread.providerSessionId) || providerThread.providerInstanceId !== selection?.instanceId) return available;
  available.add(0);
  const attempts = new Map(rows(projection.attempts).map((attempt) => [attempt.id, attempt]));
  const turnsById = new Map<unknown, Record<string, unknown>>();
  const latestByAttempt = new Map<unknown, Record<string, unknown>>();
  for (const turn of rows(projection.providerTurns)) {
    turnsById.set(turn.id, turn);
    if (turn.runAttemptId === null || turn.runAttemptId === undefined) continue;
    const latest = latestByAttempt.get(turn.runAttemptId);
    if (!latest || Number(turn.ordinal) > Number(latest.ordinal)) latestByAttempt.set(turn.runAttemptId, turn);
  }
  for (const run of rows(projection.runs)) {
    if (run.activeAttemptId === null || run.activeAttemptId === undefined) continue;
    const attempt = attempts.get(run.activeAttemptId);
    const turn = latestByAttempt.get(run.activeAttemptId) ?? (attempt && attempt.providerTurnId != null ? turnsById.get(attempt.providerTurnId) : undefined);
    if (turn && turn.providerThreadId === providerThread.id && typeof run.ordinal === "number") available.add(run.ordinal);
  }
  return available;
}

/**
 * The turn count to rewind to for a user message: that run's predecessor, or the
 * thread start for the first run. Undefined when the history cannot be restored there.
 */
export function findRewindTarget(projection: Record<string, unknown>, messageId: string): RewindTarget | undefined {
  const runs = rows(projection.runs).filter((run) => typeof run.ordinal === "number").sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  const index = runs.findIndex((run) => run.userMessageId === messageId);
  if (index < 0) return undefined;
  const checkpoints = rows(projection.checkpoints);
  const previous = runs[index - 1];
  let turnCount: number | undefined;
  if (!previous) {
    turnCount = findRevertCheckpoint(checkpoints, 0) ? 0 : undefined;
  } else {
    const ready = checkpoints.find((checkpoint) => checkpoint.status === "ready" && checkpoint.runId === previous.id && typeof checkpoint.appRunOrdinal === "number");
    turnCount = ready ? Number(ready.appRunOrdinal) : undefined;
  }
  if (turnCount === undefined || !availableRevertTurnCounts(projection).has(turnCount)) return undefined;
  // Paging can omit the source run. Rollback commits the entire settled suffix atomically.
  let witness: Record<string, unknown> | undefined;
  for (const run of runs) {
    if (Number(run.ordinal) <= turnCount || !SETTLED_RUN_STATUSES.has(String(run.status))) continue;
    if (!witness || Number(run.ordinal) > Number(witness.ordinal)) witness = run;
  }
  if (!witness || !nonempty(witness.id)) return undefined;
  const checkpoint = findRevertCheckpoint(checkpoints, turnCount);
  return {
    turnCount,
    witnessRunId: witness.id,
    ...(checkpoint && nonempty(checkpoint.id) && nonempty(checkpoint.scopeId) ? { checkpoint: { id: checkpoint.id, scopeId: checkpoint.scopeId } } : {}),
  };
}

/** Every user message the thread can be rewound to, as the web's revertTurnCount map. */
export function rewindableMessageIds(projection: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const run of rows(projection.runs)) {
    if (nonempty(run.userMessageId) && findRewindTarget(projection, run.userMessageId)) ids.add(run.userMessageId);
  }
  return ids;
}

/** recallableComposerPrompt, reduced to the part a user types: the trimmed message text. */
export function recallableComposerPrompt(text: string): string {
  return text.trim();
}

/** The restored prompt goes after whatever is already in the composer. */
export function mergeRestoredPrompt(current: string, restored: string): string {
  if (restored.length === 0) return current;
  return current.length > 0 ? `${current}\n\n${restored}` : restored;
}

type Dependencies = {
  request: (method: string, payload: unknown) => Promise<unknown>;
  connected: () => boolean;
  environment: () => string;
  generation: () => number;
  currentThread: () => Thread | undefined;
  readAttachment: (id: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<Blob>;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export interface RewindInput {
  message: Pick<Message, "id" | "role" | "body" | "attachments">;
  restoreFiles: boolean;
  composerBusy: boolean;
  composerAttachmentCount: number;
  maxAttachments: number;
}

export interface RewindResult {
  prompt: string;
  files: File[];
}

/** Whether Edit from here makes sense right now; the reason is the web's own copy. */
export function rewindBlockedReason(thread: Thread | undefined, connected: boolean, sending: boolean, supportsConversationRollback = true, /** useTimelineRewind: the unavailable environment's label. */ environmentLabel?: string | null): string | null {
  if (thread && !connected && environmentLabel) return supportsConversationRollback ? `Reconnect ${environmentLabel} before reverting checkpoints.` : "This provider does not support reverting conversation history. Start a new thread instead.";
  if (!thread || !connected) return "Connect the environment before editing from here.";
  // useTimelineRewind: a provider that reports supportsConversationRollback false cannot rewind.
  if (!supportsConversationRollback) return "This provider does not support reverting conversation history. Start a new thread instead.";
  if (thread.status === "running" || thread.status === "awaiting" || sending) return "Interrupt the current turn before reverting checkpoints.";
  return null;
}

async function prepareFiles(deps: Dependencies, message: RewindInput["message"]): Promise<File[]> {
  const files: File[] = [];
  for (const attachment of message.attachments ?? []) {
    const controller = new AbortController();
    const blob = await deps.readAttachment(attachment.id, { signal: controller.signal, maxBytes: REWIND_ATTACHMENT_BYTES });
    files.push(new File([blob], attachment.name, { type: attachment.mimeType }));
  }
  return files;
}

export async function rewindToMessageWith(deps: Dependencies, input: RewindInput): Promise<RewindResult> {
  const thread = deps.currentThread();
  if (!thread || !deps.connected()) throw new Error("The environment is not connected.");
  if (input.message.role !== "user") throw new Error("Only your own messages can be edited.");
  if (input.composerBusy) throw new Error("Wait for attachments to finish preparing before rewinding.");
  const blocked = rewindBlockedReason(thread, true, false);
  if (blocked) throw new Error(blocked);
  const environment = deps.environment();
  const generation = deps.generation();
  const stillHere = () => deps.environment() === environment && deps.generation() === generation && deps.connected() && deps.currentThread()?.id === thread.id;
  const projection = record(await deps.request("orchestration.getThreadProjection", { threadId: thread.id }));
  if (!stillHere()) throw new Error("The environment changed before the thread could be rewound.");
  if (!projection || record(projection.thread)?.id !== thread.id) throw new Error("Could not verify the conversation to rewind.");
  const target = findRewindTarget(projection, input.message.id);
  if (!target) throw new Error("The thread has changed. Select a message to rewind again.");
  // Attachments are read first so a failure leaves the thread untouched.
  const files = await prepareFiles(deps, input.message);
  if (input.composerAttachmentCount + files.length > input.maxAttachments) throw new Error("Make room for this message's attachments in the composer before rewinding.");
  if (!stillHere()) throw new Error("The environment changed before the thread could be rewound.");
  const commandId = `command:${deps.newId()}`;
  await deps.request("orchestration.dispatchCommand", {
    type: "checkpoint.rollback",
    commandId,
    threadId: thread.id,
    restoreFiles: input.restoreFiles,
    ...(target.checkpoint ? { checkpointId: target.checkpoint.id, scopeId: target.checkpoint.scopeId } : {}),
  });
  const deadline = Date.now() + (deps.timeoutMs ?? 120_000);
  while (true) {
    if (!stillHere()) throw new Error("The environment changed while the thread was rewinding. Reconnect to check the thread.");
    const current = record(await deps.request("orchestration.getThreadProjection", { threadId: thread.id }));
    const failure = record(record(current?.thread)?.rollbackFailure);
    if (failure?.requestId === commandId) throw new Error(typeof failure.message === "string" ? failure.message : "Failed to revert thread state.");
    if (rows(current?.runs).some((run) => run.id === target.witnessRunId && run.status === "rolled_back")) break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the thread to rewind.");
    await deps.sleep(400);
  }
  return { prompt: recallableComposerPrompt(input.message.body), files };
}

export function rewindToMessage(input: RewindInput): Promise<RewindResult> {
  return rewindToMessageWith({
    request: requestBackend,
    connected: () => backendStatus() === "connected",
    environment: backendUrl,
    generation: backendConnectionGeneration,
    currentThread: openThread,
    readAttachment,
    newId: () => crypto.randomUUID(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }, input);
}
