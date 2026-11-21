// The queue and interrupt commands the web's threadEnvironment dispatches (client-runtime
// operations/commands.ts), sent through `orchestration.dispatchCommand`.
import { requestBackend, setScopedThreadModel } from "../../store";

const dispatch = (command: Record<string, unknown>) =>
  requestBackend("orchestration.dispatchCommand", { ...command, commandId: `command:${crypto.randomUUID()}` });

/** Releases a held queue (`queue.resume`), or starts one queued run now (`queued-run.start`). */
export const resumeThreadQueue = (threadId: string, runId?: string) =>
  dispatch(runId === undefined ? { type: "queue.resume", threadId } : { type: "queued-run.start", threadId, runId });

export const promoteQueuedRun = (threadId: string, queuedRunId: string, targetRunId: string) =>
  dispatch({ type: "queued-message.promote-to-steer", threadId, queuedRunId, targetRunId });

export const cancelQueuedRun = (threadId: string, runId: string) =>
  dispatch({ type: "queued-run.cancel", threadId, runId });

export const editQueuedRun = (threadId: string, runId: string, text: string, attachments?: unknown[]) =>
  dispatch({ type: "queued-run.edit", threadId, runId, text, ...(attachments ? { attachments } : {}) });

/** Resume an interrupted run: a fresh message that continues it. */
export const continueRun = (threadId: string, runId: string, modelSelection: Record<string, unknown> | null) =>
  dispatch({
    type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: `message:${crypto.randomUUID()}`,
    text: "Continue where you left off.", attachments: [], manualContinuationOfRunId: runId,
    ...(modelSelection ? { modelSelection } : {}), dispatchMode: { type: "start_immediately" },
  });

/** forkSideChat: forks the thread's latest stable point into a hidden side chat. */
export const forkSideChat = (sourceThreadId: string, targetThreadId: string) =>
  dispatch({ type: "thread.fork", createdBy: "user", creationSource: "web", sourceThreadId, targetThreadId, sourcePoint: { type: "latest_stable" }, sideChat: true, title: "Side chat" });

/** A lone `/compact` message, queued ahead of the user's message ("Compact and send"). */
export const compactThread = (threadId: string, modelSelection: Record<string, unknown> | null) =>
  dispatch({
    type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: `message:${crypto.randomUUID()}`,
    text: "/compact", attachments: [], idleCompaction: "onReturn", ...(modelSelection ? { modelSelection } : {}), dispatchMode: { type: "start_immediately" },
  });

/** The side chat's first message (useSideChat.start), dispatched on the forked thread. */
export const sendSideChatMessage = (
  threadId: string,
  text: string,
  modelSelection: Record<string, unknown> | null,
  extras?: { attachments?: unknown[]; context?: Record<string, unknown> },
) =>
  dispatch({
    type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: `message:${crypto.randomUUID()}`,
    text, attachments: extras?.attachments ?? [], ...(extras?.context ? { context: extras.context } : {}),
    ...(modelSelection ? { modelSelection } : {}), dispatchMode: { type: "start_immediately" },
  });

/** thread.runtime-mode.set: the thread's permission mode (Supervised, Auto-accept edits, Full access). */
export const setThreadRuntimeMode = (threadId: string, runtimeMode: string) =>
  dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode });

export interface SideChatCommands {
  fork: (parentId: string, targetId: string) => Promise<unknown>;
  setRuntimeMode: (threadId: string, runtimeMode: string) => Promise<unknown>;
  send: (threadId: string, text: string, modelSelection: Record<string, unknown> | null, extras?: { attachments?: unknown[]; context?: Record<string, unknown> }) => Promise<unknown>;
  /** thread.delete onlyIfUnused: removes a side chat a failed start left empty. */
  discard?: (threadId: string) => Promise<unknown>;
  /** useSideChat.start with no prompt: the side chat's composer draft takes the parent's model selection. */
  setDraftModel?: (threadId: string, modelSelection: Record<string, unknown>) => void;
}

export const sideChatCommands: SideChatCommands = { fork: forkSideChat, setRuntimeMode: setThreadRuntimeMode, send: sendSideChatMessage, discard: (threadId) => dispatch({ type: "thread.delete", threadId, onlyIfUnused: true }),
  setDraftModel: (threadId, selection) => { if (typeof selection.instanceId === "string" && typeof selection.model === "string") setScopedThreadModel(threadId, selection.instanceId, selection.model); } };

/**
 * useSideChat.start: forks the thread into a side chat, waits for it to reach this client, gives it the parent's
 * runtime mode (the side chat is a fork, so it would otherwise keep the default), then sends the question.
 * Returns the side chat's thread id.
 */
export async function startSideChat(input: {
  parentId: string;
  targetId: string;
  prompt: string;
  attachments?: unknown[];
  context?: Record<string, unknown>;
  /** The parent's current permission mode. */
  runtimeMode: string | null;
  modelSelection: Record<string, unknown> | null;
  /** True once the forked thread is in the client's thread list. */
  arrived: () => boolean;
  /** The forked thread's own permission mode once it arrived (set only when it differs from the parent's). */
  forkRuntimeMode?: () => string | null;
  commands?: SideChatCommands;
  wait?: (ms: number) => Promise<void>;
}): Promise<string | null> {
  // useSideChat.open: a second open while one is starting resolves without starting another.
  if (sideChatStarting) return null;
  sideChatStarting = true;
  try { return await runSideChatStart(input); } finally { sideChatStarting = false; }
}
let sideChatStarting = false;

const failWith = (fallback: string) => (cause: unknown): never => {
  throw cause instanceof Error && cause.message ? cause : new Error(fallback);
};

async function runSideChatStart(input: Parameters<typeof startSideChat>[0]): Promise<string> {
  const commands = input.commands ?? sideChatCommands;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await commands.fork(input.parentId, input.targetId).catch(failWith("Could not start a side chat."));
  // Drops the empty side chat a failed start leaves behind; one that got its message stays.
  const discard = () => { void Promise.resolve(commands.discard?.(input.targetId)).catch(() => {}); };
  for (let attempt = 0; attempt < 50 && !input.arrived(); attempt += 1) await wait(100);
  if (!input.arrived()) { discard(); throw new Error("The side chat was created, but it did not reach this client."); }
  if (input.runtimeMode && input.runtimeMode !== (input.forkRuntimeMode?.() ?? null)) {
    await commands.setRuntimeMode(input.targetId, input.runtimeMode).catch((cause: unknown) => { discard(); return failWith("Could not set the side chat's permission mode.")(cause); });
  }
  if (input.prompt.trim() || (input.attachments?.length ?? 0) > 0) {
    await commands.send(input.targetId, input.prompt.trim(), input.modelSelection, { attachments: input.attachments, context: input.context }).catch((cause: unknown) => { discard(); return failWith("Could not send the side chat message.")(cause); });
  } else if (input.modelSelection) {
    commands.setDraftModel?.(input.targetId, input.modelSelection);
  }
  return input.targetId;
}

/** threadEnvironment.setModelSelection (updateThreadMetadata with a modelSelection): `thread.model-selection.set`. */
export const setThreadModelSelection = (threadId: string, modelSelection: Record<string, unknown>) =>
  dispatch({ type: "thread.model-selection.set", threadId, modelSelection });
