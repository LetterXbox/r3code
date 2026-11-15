import { record } from "../../backend/client";
import { backendConnectionGeneration, backendStatus, backendUrl, openThread, openThreadById, requestBackend, threadById } from "../../store";
import type { Thread } from "../../store";

interface ForkCandidate {
  sourceThreadId: string;
  sourceItemId: string;
  messageId: string;
  runId: string;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function projection(value: unknown, threadId: string): Record<string, unknown> {
  const result = record(value);
  if (!result || record(result.thread)?.id !== threadId) throw new Error("Could not verify the source conversation for this response.");
  return result;
}

/** The visible item supplies the original thread and run, including for inherited messages. */
export function findForkCandidate(value: unknown, threadId: string, messageId: string): ForkCandidate {
  const source = projection(value, threadId);
  const matches = rows(source.visibleTurnItems).filter((row) => {
    const item = record(row.item);
    return item?.type === "assistant_message" && item.messageId === messageId;
  });
  if (matches.length !== 1) throw new Error("This response is not available in the current conversation snapshot.");
  const item = record(matches[0].item);
  const sourceThreadId = matches[0].sourceThreadId;
  const sourceItemId = matches[0].sourceItemId;
  if (!item || item.status !== "completed" || item.streaming === true || !nonempty(item.runId) || !nonempty(sourceThreadId) || !nonempty(sourceItemId)) {
    throw new Error("Only a completed response with a known source can be forked.");
  }
  return { sourceThreadId, sourceItemId, messageId, runId: item.runId };
}

/** Match the reference's native-fork or full-thread-handoff capability check. */
export function verifyForkSupport(value: unknown, candidate: ForkCandidate): void {
  const source = projection(value, candidate.sourceThreadId);
  const item = rows(source.turnItems).find((row) => row.id === candidate.sourceItemId)
    ?? rows(source.visibleTurnItems).find((row) => row.sourceItemId === candidate.sourceItemId && row.sourceThreadId === candidate.sourceThreadId)?.item;
  const actual = record(item);
  if (!actual || actual.type !== "assistant_message" || actual.messageId !== candidate.messageId || actual.runId !== candidate.runId || actual.status !== "completed" || actual.streaming === true) {
    throw new Error("The response is no longer available to fork. Refresh the thread and try again.");
  }
  const providerThread = rows(source.providerThreads).find((row) => nonempty(actual.providerThreadId) && row.id === actual.providerThreadId);
  const session = rows(source.providerSessions).find((row) => nonempty(providerThread?.providerSessionId) && row.id === providerThread.providerSessionId);
  if (!session) return; // Historical sessions may be absent; the server can use a portable handoff.
  const capabilities = record(session.capabilities);
  const threads = record(capabilities?.threads);
  const identity = record(capabilities?.identity);
  const context = record(capabilities?.context);
  if (!threads || !identity || !context || typeof threads.canForkThread !== "boolean" || typeof threads.canForkFromTurn !== "boolean" || typeof identity.nativeThreadIds !== "string" || typeof context.supportsFullThreadHandoff !== "boolean") {
    throw new Error("The provider did not report whether it can fork this response.");
  }
  const native = threads.canForkThread && threads.canForkFromTurn && identity.nativeThreadIds === "strong";
  if (!native && !context.supportsFullThreadHandoff) throw new Error("This provider cannot fork from a response.");
}

type Dependencies = {
  request: (method: string, payload: unknown) => Promise<unknown>;
  connected: () => boolean;
  environment: () => string;
  generation: () => number;
  currentThread: () => Thread | undefined;
  waitForThread: (id: string, stillCurrent: () => boolean) => Promise<boolean>;
  open: (id: string) => void;
  newId: () => string;
};

export async function forkMessageWith(deps: Dependencies, messageId: string): Promise<void> {
  const thread = deps.currentThread();
  if (!thread || !deps.connected()) throw new Error("Connect the environment before forking a response.");
  const environment = deps.environment();
  const generation = deps.generation();
  const sameEnvironment = () => deps.environment() === environment && deps.generation() === generation && deps.connected();
  const current = await deps.request("orchestration.getThreadProjection", { threadId: thread.id });
  if (!sameEnvironment()) throw new Error("The environment changed before the response could be forked.");
  const candidate = findForkCandidate(current, thread.id, messageId);
  const source = candidate.sourceThreadId === thread.id ? current : await deps.request("orchestration.getThreadProjection", { threadId: candidate.sourceThreadId });
  if (!sameEnvironment()) throw new Error("The environment changed before the response could be forked.");
  verifyForkSupport(source, candidate);
  const targetThreadId = `thread:${deps.newId()}`;
  try {
    await deps.request("orchestration.dispatchCommand", {
      type: "thread.fork", commandId: `command:${deps.newId()}`, createdBy: "user", creationSource: "web",
      sourceThreadId: candidate.sourceThreadId, targetThreadId,
      sourcePoint: { type: "run", runId: candidate.runId }, title: `${thread.title} fork`,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Request timed out.")) {
      throw new Error("The fork request timed out and may have succeeded. Check the sidebar before retrying.");
    }
    throw cause;
  }
  if (!sameEnvironment()) throw new Error("The fork was requested in the previous environment. Reconnect to check the sidebar.");
  const appeared = await deps.waitForThread(targetThreadId, sameEnvironment);
  if (!sameEnvironment()) throw new Error("The fork was requested in the previous environment. Reconnect to check the sidebar.");
  if (!appeared) throw new Error("The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.");
  if (deps.currentThread()?.id === thread.id) deps.open(targetThreadId);
}

async function waitForThread(id: string, stillCurrent: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (stillCurrent() && Date.now() < deadline) {
    if (threadById(id)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return stillCurrent() && Boolean(threadById(id));
}

export function forkMessage(messageId: string): Promise<void> {
  return forkMessageWith({
    request: requestBackend,
    connected: () => backendStatus() === "connected",
    environment: backendUrl,
    generation: backendConnectionGeneration,
    currentThread: openThread,
    waitForThread,
    open: openThreadById,
    newId: () => crypto.randomUUID(),
  }, messageId);
}
