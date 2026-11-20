// Pure ingestion helpers for the open thread's stream, shaped by the server's contracts
// (packages/contracts orchestrationV2.ts): a message is carried twice, as a
// `message.updated` record and as a `user_message` / `assistant_message` turn item that
// repeats its text, and the run lifecycle is the `run.created` / `run.updated` records.
// The web app builds its transcript from the turn items (session-logic.ts
// deriveTimelineEntriesFromVisibleTurnItems), so a message that only arrives as a turn
// item must show, and run state must come from the runs, not from a stale shell status.
import type { Message } from "../../../store";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const time = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Run statuses that have not finished (OrchestrationV2RunStatus). */
const UNFINISHED = new Set(["preparing", "queued", "starting", "running", "waiting"]);
export const runUnfinished = (status: unknown) => typeof status === "string" && UNFINISHED.has(status);

/** The message a user_message / assistant_message turn item carries, as the transcript holds it. */
export function messageFromTurnItem(value: unknown): Message | null {
  const item = rec(value);
  if (!item || (item.type !== "user_message" && item.type !== "assistant_message")) return null;
  if (typeof item.messageId !== "string") return null;
  const text = typeof item.text === "string" ? item.text : "";
  const attachments = Array.isArray(item.attachments) ? item.attachments.map(rec).flatMap((entry) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.mimeType !== "string" ||
      typeof entry.sizeBytes !== "number" || typeof entry.type !== "string") return [];
    return [{ id: entry.id, name: entry.name, mimeType: entry.mimeType, sizeBytes: entry.sizeBytes, type: entry.type }];
  }) : [];
  return {
    id: item.messageId, role: item.type === "user_message" ? "user" : "assistant", body: text,
    ...(typeof item.id === "string" ? { itemId: item.id } : {}),
    order: time(item.startedAt) || time(item.updatedAt), streaming: item.type === "assistant_message" && item.streaming === true,
    attachments, ...(typeof item.ordinal === "number" ? { ordinal: item.ordinal } : {}), ...(item.context ? { context: item.context } : {}),
    ...(typeof item.status === "string" ? { status: item.status } : {}), ...(time(item.updatedAt) ? { updatedAt: time(item.updatedAt) } : {}),
    ...(item.type === "user_message" ? userMessageFields(item) : {}),
    ...(typeof item.runId === "string" ? { runId: item.runId } : {}),
  };
}

/** The user_message turn-item fields MessageRow's variants read (attribution, steer marker, new-session and model-switch dividers). */
function userMessageFields(item: Rec): Partial<Message> {
  const modelSwitch = rec(item.modelSwitch);
  return {
    ...(typeof item.inputIntent === "string" ? { inputIntent: item.inputIntent } : {}),
    ...(typeof item.createdBy === "string" ? { createdBy: item.createdBy } : {}),
    ...(typeof item.creationSource === "string" ? { creationSource: item.creationSource } : {}),
    ...(typeof item.idleCompaction === "string" ? { idleCompaction: item.idleCompaction } : {}),
    ...(typeof item.scheduledTaskId === "string" ? { scheduledTaskId: item.scheduledTaskId } : {}),
    ...(typeof item.senderThreadId === "string" ? { senderThreadId: item.senderThreadId } : {}),
    ...(item.freshContext === true ? { freshContext: true } : {}),
    ...(modelSwitch ? { modelSwitch: { from: modelSwitch.from, to: modelSwitch.to } } : {}),
  };
}

const VARIANT_KEYS = ["inputIntent", "createdBy", "creationSource", "idleCompaction", "scheduledTaskId", "senderThreadId", "freshContext", "modelSwitch", "runId", "itemId"] as const;

/**
 * Folds a message seen on the turn-item path into the transcript. The record path
 * (`message.updated`) owns the creation time, attachments and context; the turn item
 * supplies text and the streaming flag, and adds the message when no record came.
 */
export function mergeItemMessage(list: Message[], incoming: Message, itemOmitsText: boolean): Message[] {
  const index = list.findIndex((entry) => entry.id === incoming.id);
  if (index < 0) return [...list, incoming];
  const current = list[index];
  const next: Message = {
    ...current,
    body: itemOmitsText || (incoming.body === "" && current.body !== "") ? current.body : incoming.body,
    streaming: incoming.streaming,
    ordinal: incoming.ordinal ?? current.ordinal,
    order: current.order || incoming.order,
    attachments: current.attachments?.length ? current.attachments : incoming.attachments,
    context: current.context ?? incoming.context,
    status: incoming.status ?? current.status,
    updatedAt: incoming.updatedAt ?? current.updatedAt,
  };
  // The turn item owns the user message's variant fields; a record-path message has none of them yet.
  let variantChanged = false;
  for (const key of VARIANT_KEYS) {
    if (incoming[key] !== undefined && JSON.stringify(incoming[key]) !== JSON.stringify(current[key])) { (next as unknown as Record<string, unknown>)[key] = incoming[key]; variantChanged = true; }
  }
  if (!variantChanged && next.ordinal === current.ordinal && next.body === current.body && next.streaming === current.streaming && next.order === current.order && next.attachments === current.attachments && next.context === current.context && next.status === current.status && next.updatedAt === current.updatedAt) return list;
  return list.map((entry, position) => (position === index ? next : entry));
}

/** Keep unrelated conversations and subscribers untouched when an item has no message change. */
export function mergeTranscriptItem(all: Record<string, Message[]>, threadId: string, incoming: Message, itemOmitsText: boolean): Record<string, Message[]> {
  const current = all[threadId];
  const next = mergeItemMessage(current ?? [], incoming, itemOmitsText);
  return next === current ? all : { ...all, [threadId]: next };
}

/** Avoid publishing a fresh list when unrelated thread state changes. */
export function createStableMessageList() {
  let scope: string | null = null;
  let previous: Message[] = [];
  return (threadId: string | null, next: Message[]): Message[] => {
    if (scope === threadId && previous.length === next.length && previous.every((message, index) => message === next[index])) return previous;
    scope = threadId;
    previous = next;
    return next;
  };
}

/** Whether a turn item's text was left out because the client already holds it. */
export const itemTextOmitted = (value: unknown) => rec(value)?.textOmitted === true;

/** The run that is currently doing work, if any: the latest unfinished run. */
export function activeRun(runs: readonly Rec[]): Rec | null {
  let found: Rec | null = null;
  for (const run of runs) {
    if (!runUnfinished(run.status) || run.status === "queued") continue;
    const rank = (typeof run.ordinal === "number" ? run.ordinal : 0);
    const best = found && typeof found.ordinal === "number" ? found.ordinal : -1;
    if (!found || rank >= best) found = run;
  }
  return found;
}

/** Provider-native subagents run in a root execution node without an app run. */
export function runlessSubagentWork(thread: Rec | null, nodes: readonly Rec[]): { working: boolean; startedAt: number | null } | null {
  if (thread?.creationSource !== "provider" || rec(thread.lineage)?.relationshipToParent !== "subagent") return null;
  const node = [...nodes].reverse().find((candidate) => candidate.kind === "root_turn" && candidate.runId === null);
  if (!node) return null;
  const startedAt = time(node.startedAt);
  return { working: startedAt > 0 && (node.status === "pending" || node.status === "running" || node.status === "waiting"), startedAt: startedAt > 0 ? startedAt : null };
}

/**
 * The thread's working state: from the runs once the stream has delivered them, else from the
 * shell status. A run that finished ends it even when the shell row has not caught up.
 * `blocked` is a pending approval or question: the run is waiting on the user, not working.
 * `turnEnded` is true for a run whose provider turn already ended (providerTurnEnded).
 */
export function deriveWorking(runs: readonly Rec[], shellRunning: boolean, blocked: boolean, turnEnded: (run: Rec) => boolean = () => false): { working: boolean; startedAt: number | null } {
  if (runs.length === 0) return { working: shellRunning && !blocked, startedAt: null };
  const run = activeRun(runs);
  // The run still reads as running while its provider turn has ended (the server is projecting its completion): not working.
  if (!run || (run.status === "waiting" && blocked) || turnEnded(run)) return { working: false, startedAt: null };
  const started = time(run.workStartedAt) || time(run.startedAt) || time(run.requestedAt);
  return { working: true, startedAt: started > 0 ? started : null };
}
