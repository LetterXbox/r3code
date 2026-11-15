// The open thread's message queue, shared by the composer (editing a queued message, Update queued message,
// shortcuts) and the transcript (QueuedMessages): the web keeps this in QueuedRunsControl + useQueuedRunEdit.
// Everything derives from the thread subscription's runs, messages and provider state, so a reconnect
// (which re-sends the projection snapshot) restores the queue.
import { computed, signal } from "nsh";
import { automaticQueueMessageIdsFor, composerDraft, composerDraftFor, openThread, setComposerDraft, threadMessages, threadMessagesFor, threadProviderStateFor, threadRuns, threadRunsFor, threadScopeOverride } from "../../store";
import { deriveQueueState, parseRuns } from "./runState";
import type { QueuedMessage } from "./runState";
import { cancelQueuedRun, promoteQueuedRun, resumeThreadQueue } from "./runCommands";
import { deriveSteerState, providerState, providerTurnEnded, readActiveRun } from "./threadProviderState";

/**
 * The run the server still lists as active although its provider turn ended: it is finishing, not working, so the
 * composer neither offers Stop for it nor tries to steer it (providerTurnEnded).
 */
export const endedRunId = computed<string | null>(() => {
  const runs = parseRuns(threadRuns());
  const active = deriveQueueState(runs, threadMessages()).activeRun;
  return active !== null && providerTurnEnded(providerState(), readActiveRun(threadRuns(), active.id)) ? active.id : null;
});

/** deriveThreadQueueWorkflowState over the open thread. */
export const threadQueue = computed(() => {
  const ended = endedRunId();
  const runs = parseRuns(threadRuns()).filter((run) => run.id !== ended);
  const messages = threadMessages();
  const active = deriveQueueState(runs, messages).activeRun;
  const steer = deriveSteerState({
    data: providerState(), activeRun: readActiveRun(threadRuns(), active?.id ?? null), appThreadId: openThread()?.id ?? "",
    activeMessage: messages.find((message) => message.id === active?.userMessageId),
  });
  return deriveQueueState(runs, messages, steer, automaticQueueMessageIdsFor(openThread()?.id ?? ""));
});

/**
 * The queue of a retained thread shown beside the selected conversation, using its own provider state.
 */
export function threadQueueFor(threadId: () => string) {
  const endedRunId = computed<string | null>(() => {
    const runs = threadRunsFor(threadId());
    const active = deriveQueueState(parseRuns(runs), threadMessagesFor(threadId())).activeRun;
    return active && providerTurnEnded(threadProviderStateFor(threadId()), readActiveRun(runs, active.id)) ? active.id : null;
  });
  const queue = computed(() => {
    const id = threadId();
    const rawRuns = threadRunsFor(id);
    const runs = parseRuns(rawRuns).filter((run) => run.id !== endedRunId());
    const messages = threadMessagesFor(id);
    const active = deriveQueueState(runs, messages).activeRun;
    const steer = deriveSteerState({ data: threadProviderStateFor(id), activeRun: readActiveRun(rawRuns, active?.id ?? null), appThreadId: id, activeMessage: messages.find((message) => message.id === active?.userMessageId) });
    return deriveQueueState(runs, messages, steer, automaticQueueMessageIdsFor(id));
  });
  return { endedRunId, queue };
}
const scopedQueues = new Map<string, ReturnType<typeof threadQueueFor>>();
const queueOf = (threadId: string) => {
  let found = scopedQueues.get(threadId);
  if (!found) { found = threadQueueFor(() => threadId); scopedQueues.set(threadId, found); }
  return found.queue();
};

/** What the actions below read and call; a test swaps these for a fake thread and recording commands. */
export const queueDeps = {
  // A side chat runs these for its own thread (withThreadScope); otherwise they act on the open thread.
  threadId: (): string | undefined => threadScopeOverride() ?? openThread()?.id,
  queue: () => { const scopedId = threadScopeOverride(); return scopedId ? queueOf(scopedId) : threadQueue(); },
  commands: { resume: resumeThreadQueue, promote: promoteQueuedRun, cancel: cancelQueuedRun },
};

/** A fresh message starts its own turn: it may skip compaction, but not steer into a turn. */
export const canSendQueuedRun = (item: QueuedMessage) => {
  const queue = queueDeps.queue();
  return queue.canSendNow || (queue.canPromoteToSteer && (!item.freshContext || queue.promoteSkipsCompaction));
};

/** QueuedRunsControl's Send now tooltip: start a turn, skip compaction, or steer into the running turn. */
export const queuedSendNowTooltip = (index: number, steerShortcutLabel: string | null = null) => {
  const queue = queueDeps.queue();
  const base = queue.canSendNow ? "Start a turn with this message" : queue.promoteSkipsCompaction ? "Skip compaction and send this message" : "Send into the current turn";
  return `${base}${index === 0 && steerShortcutLabel ? ` (${steerShortcutLabel})` : ""}`;
};

/** Editing a queued message: its text sits in the composer, and the draft that was there waits aside. */
/** The queued message being edited: its thread and run, the draft it replaced, and its attachments, which stay
 * listed (and removable) while it is edited (ChatComposer.tsx editingQueuedAttachments). */
export const queueEditing = signal<{ threadId: string; runId: string; stash: string; attachments?: QueuedMessage["attachments"]; originalAttachmentCount?: number; originalText?: string } | null>(null);
/** Drops one attachment from the queued message being edited (ComposerQueuedAttachmentRow onRemove). */
export function removeEditingQueuedAttachment(attachmentId: string): void {
  queueEditing.update((current) => current === null ? null : { ...current, attachments: (current.attachments ?? []).filter((item) => item.id !== attachmentId) });
}
/** What `queued-run.edit` carries for attachments: the list only when one was removed (absent keeps them as they are). */
export function editedQueuedAttachments(edit: { attachments?: QueuedMessage["attachments"]; originalAttachmentCount?: number }): QueuedMessage["attachments"] | undefined {
  const list = edit.attachments ?? [];
  return list.length === (edit.originalAttachmentCount ?? list.length) ? undefined : list;
}
export const editingQueuedRun = () => {
  const current = queueEditing();
  return current !== null && current.threadId === queueDeps.threadId() ? current : null;
};
export const busyQueuedRunId = signal<string | null>(null);
/** The last queue action's failure, shown by the composer. */
export const queueActionError = signal("");
const report = (cause: unknown) => queueActionError.set(cause instanceof Error ? cause.message : String(cause));

export async function sendQueuedNow(item: QueuedMessage) {
  const threadId = queueDeps.threadId();
  const active = queueDeps.queue().activeRun;
  if (threadId === undefined || busyQueuedRunId() !== null) return;
  busyQueuedRunId.set(item.runId);
  queueActionError.set("");
  try {
    if (queueDeps.queue().canSendNow) await queueDeps.commands.resume(threadId, item.runId);
    else if (active) await queueDeps.commands.promote(threadId, item.runId, active.id);
  } catch (cause) { report(cause); }
  finally { busyQueuedRunId.set(null); }
}

export async function removeQueued(item: QueuedMessage) {
  const threadId = queueDeps.threadId();
  if (threadId === undefined || busyQueuedRunId() !== null) return;
  busyQueuedRunId.set(item.runId);
  queueActionError.set("");
  try { await queueDeps.commands.cancel(threadId, item.runId); }
  catch (cause) { report(cause); }
  finally { busyQueuedRunId.set(null); }
}

export function startQueuedEdit(item: QueuedMessage) {
  const threadId = queueDeps.threadId();
  if (threadId === undefined || editingQueuedRun()) return;
  queueEditing.set({ threadId, runId: item.runId, stash: threadScopeOverride() ? composerDraftFor(threadId) : composerDraft(), attachments: [...item.attachments], originalAttachmentCount: item.attachments.length, originalText: item.text });
  setComposerDraft(item.text);
}

export function cancelQueuedEdit() {
  const current = editingQueuedRun();
  if (!current) return;
  setComposerDraft(current.stash);
  queueEditing.set(null);
}

/**
 * queuedMessageEdit.ts recoverQueuedMessageEdit / resolveQueuedEditExit: the edited run left the queue (it started or was
 * cancelled elsewhere). A changed edit stays in the composer when the thread's own draft was empty ("kept"); otherwise the
 * thread's draft comes back ("discarded"); an unchanged edit just ends ("clean").
 */
export function resolveQueuedEditExit(input: { editChanged: boolean; threadDraftEmpty: boolean }): "kept" | "discarded" | "clean" {
  if (!input.editChanged) return "clean";
  return input.threadDraftEmpty ? "kept" : "discarded";
}

export function recoverQueuedEditLeftQueue(composerText: string, threadTitle: string | undefined, toast: (input: { type: "info" | "warning"; title: string; description: string }) => void): void {
  const current = queueEditing();
  if (!current) return;
  const removedAttachment = (current.attachments?.length ?? 0) < (current.originalAttachmentCount ?? 0);
  const recovery = resolveQueuedEditExit({
    editChanged: removedAttachment || composerText !== (current.originalText ?? composerText),
    threadDraftEmpty: composerText.trim().length > 0 && current.stash.trim().length === 0,
  });
  queueEditing.set(null);
  if (recovery !== "kept") setComposerDraft(current.stash);
  if (recovery === "clean") return;
  const where = threadTitle === undefined ? "" : ` in \u201c${threadTitle}\u201d`;
  toast({ type: recovery === "kept" ? "info" : "warning", title: "Queued message is no longer queued", description: recovery === "kept" ? `Your unsaved edit${where} was kept in the composer.` : `Your unsaved edit${where} was discarded.` });
}
