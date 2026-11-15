// Thread-switch flicker fix (store.ts subscribeOpenThread / handleThreadEvent): before this fix, switching the
// open thread wiped turnItems, runs, subagents and checkpoints to empty and waited on a fresh server snapshot
// even for a thread already visited in this session, so a revisit replayed the whole "empty, then jump" sequence
// the owner saw on screen. This test re-opens a visited thread with no new server event and asserts its activity
// and sync phase are restored synchronously, in the same tick as the switch, with no zero-row gap in between.
import { expect, test } from "nsh/test";
import { mergeTimeline } from "./components/thread/timeline";
import { threadSessionState } from "./components/banners/threadSessionState";
import { threadQueue, threadQueueFor } from "./components/composer/queueState";
import { providerState } from "./components/composer/threadProviderState";
import { subagentStatusFor } from "./components/chat/providerSubagentLogic";
import {
  applyShellEventForTest, applyThreadEventForTest, liveThreadProjection, markThreadSubscribingForTest, openThreadById, setBackendStatusForTest,
  retainThread, setFakeClientForTest, setRequestBackendForTest, threadActivity, threadActivityFor, threadAttemptSourcesFor, threadExecutionNodes, threadLifecycleItemsFor, threadMessages, threadMessagesFor, threadSubagentRecordsFor, threadSyncPhase, threadWorkFor, threadWorking, threadWorkStartedAt,
} from "./store";

const iso = () => new Date().toISOString();

// Each test uses its own thread ids: store.ts's signals are module-global with no per-test reset (as
// optimisticSend.test.ts also works around), so reused ids would carry the previous test's cached detail.
function seed(idA: string, idB: string) {
  setRequestBackendForTest(() => Promise.resolve({}));
  setBackendStatusForTest("connected");
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(), updatedAt: iso() }],
    threads: [
      { id: idA, projectId: "project-1", title: "Thread A", creationSource: "web", providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"], status: "completed",
        latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: iso(), updatedAt: iso() },
      { id: idB, projectId: "project-1", title: "Thread B", creationSource: "web", providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"], status: "completed",
        latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: iso(), updatedAt: iso() },
    ],
  } });
}

function snapshotFor(threadId: string, messageId: string, itemId: string) {
  applyThreadEventForTest(threadId, { kind: "snapshot", projection: {
    messages: [{ id: messageId, role: "user", text: `hello from ${threadId}`, createdAt: iso() }],
    turnItems: [{ id: itemId, type: "command_execution", status: "completed", startedAt: iso(), updatedAt: iso() }],
    runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
}

test("a background message update preserves the open conversation's message list", () => {
  seed("thread:background-list", "thread:visible-list");
  const transport = setFakeClientForTest();
  openThreadById("thread:background-list");
  snapshotFor("thread:background-list", "background-message", "background-command");
  openThreadById("thread:visible-list");
  snapshotFor("thread:visible-list", "visible-message", "visible-command");
  const release = retainThread("thread:background-list");
  const before = threadMessages();
  const beforeIndex = threadAttemptSourcesFor("thread:visible-list")!.messageItems;
  transport.emitToCurrentSubscription({ kind: "event", sequence: 1, event: {
    type: "message.updated", payload: { id: "background-message", role: "user", text: "background changed", createdAt: iso() },
  } });
  expect(threadMessagesFor("thread:background-list")[0]?.body).toBe("background changed");
  expect(threadMessages() === before).toBe(true);
  expect(threadAttemptSourcesFor("thread:visible-list")!.messageItems === beforeIndex).toBe(true);
  expect(threadMessages()[0]?.body).toBe("hello from thread:visible-list");
  release();
});

test("a retained conversation keeps message list identity until its messages change", () => {
  seed("thread:stable-side", "thread:stable-main");
  const transport = setFakeClientForTest();
  openThreadById("thread:stable-side");
  snapshotFor("thread:stable-side", "stable-message", "stable-command");
  openThreadById("thread:stable-main");
  const release = retainThread("thread:stable-side");
  const before = threadMessagesFor("thread:stable-side");
  expect(threadMessagesFor("thread:stable-side") === before).toBe(true);
  transport.emitToCurrentSubscription({ kind: "event", sequence: 1, event: {
    type: "message.updated", payload: { id: "stable-message", role: "user", text: "updated side", createdAt: iso() },
  } });
  expect(threadMessagesFor("thread:stable-side") === before).toBe(false);
  expect(threadMessagesFor("thread:stable-side")[0]?.body).toBe("updated side");
  release();
});

test("a message record without context does not erase context from its turn item", () => {
  seed("thread:message-context", "thread:message-context-other");
  openThreadById("thread:message-context");
  const context = { version: 1, records: [{ kind: "image", contextId: "image_1", label: "image.png", attachmentId: "asset" }] };
  applyThreadEventForTest("thread:message-context", { kind: "snapshot", projection: {
    messages: [], runs: [], turnItems: [{ id: "item:context", messageId: "message:context", type: "user_message", text: "See image", context, startedAt: iso() }],
  } });
  applyThreadEventForTest("thread:message-context", { kind: "event", sequence: 1, event: {
    type: "message.updated", payload: { id: "message:context", role: "user", text: "See image", createdAt: iso() },
  } });
  expect(threadMessages()[0]?.context).toEqual(context);
});

test("context transfers survive updates and a conversation switch in the live projection", () => {
  seed("thread:transfer-a", "thread:transfer-b");
  openThreadById("thread:transfer-a");
  const transfer = { id: "transfer:1", sourceThreadId: "thread:transfer-a", targetThreadId: "thread:transfer-b", status: "pending" };
  applyThreadEventForTest("thread:transfer-a", { kind: "snapshot", projection: { messages: [], runs: [], turnItems: [], contextTransfers: [transfer] } });
  expect(liveThreadProjection("thread:transfer-a")?.contextTransfers).toEqual([transfer]);
  applyThreadEventForTest("thread:transfer-a", { kind: "event", sequence: 1, event: { type: "context-transfer.updated", payload: { ...transfer, status: "consumed" } } });
  openThreadById("thread:transfer-b");
  openThreadById("thread:transfer-a");
  expect(liveThreadProjection("thread:transfer-a")?.contextTransfers).toEqual([{ ...transfer, status: "consumed" }]);
});

test("a retained conversation receives context transfer updates while another is open", () => {
  seed("thread:transfer-side", "thread:transfer-open");
  const transport = setFakeClientForTest();
  openThreadById("thread:transfer-side");
  const transfer = { id: "transfer:side", sourceThreadId: "thread:transfer-side", targetThreadId: "thread:transfer-open", status: "pending" };
  applyThreadEventForTest("thread:transfer-side", { kind: "snapshot", snapshotSequence: 1, projection: { messages: [], runs: [], turnItems: [], contextTransfers: [transfer] } });
  openThreadById("thread:transfer-open");
  const release = retainThread("thread:transfer-side");
  transport.emitToCurrentSubscription({ kind: "event", sequence: 2, event: { type: "context-transfer.updated", payload: { ...transfer, status: "consumed" } } });
  openThreadById("thread:transfer-side");
  expect(liveThreadProjection("thread:transfer-side")?.contextTransfers).toEqual([{ ...transfer, status: "consumed" }]);
  release();
});

test("automatic queued messages stay out of the visible count as snapshots and updates arrive", () => {
  seed("thread:queue-parity", "thread:queue-parity-other");
  openThreadById("thread:queue-parity");
  const messages = Array.from({ length: 7 }, (_, index) => ({
    id: `queue-message:${index}`, role: "user", text: `Message ${index}`, createdAt: iso(),
    ...(index === 6 ? { delegatedCompletion: { sourceThreadId: "child" } } : {}),
  }));
  const runs = messages.map((message, index) => ({
    id: `queue-run:${index}`, status: "queued", ordinal: index, userMessageId: message.id,
  }));
  applyThreadEventForTest("thread:queue-parity", { kind: "snapshot", projection: { messages, runs, turnItems: [] } });
  expect(threadQueue().queued.length).toBe(6);
  applyThreadEventForTest("thread:queue-parity", { kind: "event", sequence: 1, event: {
    type: "message.updated", payload: { ...messages[0], notification: { type: "resumed" } },
  } });
  expect(threadQueue().queued.length).toBe(5);
  applyThreadEventForTest("thread:queue-parity", { kind: "event", sequence: 2, event: {
    type: "message.updated", payload: messages[0],
  } });
  expect(threadQueue().queued.length).toBe(6);
  openThreadById("thread:queue-parity-other");
  openThreadById("thread:queue-parity");
  expect(threadQueue().queued.length).toBe(6);
});

test("a large subagent snapshot retains every record and omitted duplicate results", () => {
  seed("thread:many-agents", "thread:many-agents-other");
  openThreadById("thread:many-agents");
  const agents = Array.from({ length: 100 }, (_, index) => ({ id: `agent:${index}`, status: "completed", result: `result ${index}` }));
  applyThreadEventForTest("thread:many-agents", { kind: "snapshot", projection: {
    messages: [], runs: [], turnItems: [], subagents: [...agents, { id: "agent:0", status: "completed", resultOmitted: true }],
  } });
  const records = threadSubagentRecordsFor("thread:many-agents");
  expect(records.length).toBe(100);
  expect(records.find((agent) => agent.id === "agent:0")?.result).toBe("result 0");
});

test("subagent updates restore omitted bodies repeatedly and retain them across thread switches", () => {
  seed("thread:subagent-bodies", "thread:subagent-bodies-other");
  openThreadById("thread:subagent-bodies");
  applyThreadEventForTest("thread:subagent-bodies", { kind: "snapshot", snapshotSequence: 0, projection: {
    messages: [], runs: [], turnItems: [], subagents: [{ id: "agent", status: "running", prompt: "original prompt", result: "original result" }],
  } });
  const update = (sequence: number) => ({ kind: "event", sequence, event: { type: "subagent.updated", payload: {
    id: "agent", status: "running", prompt: "", promptOmitted: true, result: null, resultOmitted: true,
  } } });
  applyThreadEventForTest("thread:subagent-bodies", update(1));
  applyThreadEventForTest("thread:subagent-bodies", update(2));
  let agent = threadSubagentRecordsFor("thread:subagent-bodies")[0];
  expect([agent?.prompt, agent?.result, agent?.promptOmitted, agent?.resultOmitted]).toEqual(["original prompt", "original result", undefined, undefined]);
  openThreadById("thread:subagent-bodies-other");
  openThreadById("thread:subagent-bodies");
  agent = threadSubagentRecordsFor("thread:subagent-bodies")[0];
  expect([agent?.prompt, agent?.result]).toEqual(["original prompt", "original result"]);
});

test("background subagent updates retain omitted bodies when returning to the conversation", () => {
  seed("thread:side-bodies", "thread:side-bodies-other");
  const transport = setFakeClientForTest();
  openThreadById("thread:side-bodies");
  applyThreadEventForTest("thread:side-bodies", { kind: "snapshot", snapshotSequence: 1, projection: {
    messages: [], runs: [], turnItems: [], subagents: [{ id: "agent", status: "running", prompt: "prompt", result: "result" }],
  } });
  openThreadById("thread:side-bodies-other");
  const release = retainThread("thread:side-bodies");
  for (const sequence of [2, 3]) transport.emitToCurrentSubscription({ kind: "event", sequence, event: {
    type: "subagent.updated", payload: { id: "agent", status: "running", prompt: "", promptOmitted: true, result: null, resultOmitted: true },
  } });
  const retained = threadSubagentRecordsFor("thread:side-bodies")[0];
  expect([retained?.prompt, retained?.result, retained?.promptOmitted, retained?.resultOmitted]).toEqual(["prompt", "result", undefined, undefined]);
  openThreadById("thread:side-bodies");
  expect(threadSubagentRecordsFor("thread:side-bodies")[0]?.prompt).toBe("prompt");
  release();
});

test("a provider subagent's runless root node drives live work and completion", () => {
  seed("thread:runless", "thread:runless-other");
  openThreadById("thread:runless");
  const startedAt = "2026-11-13T15:30:00.000Z";
  const node = { id: "node:root", kind: "root_turn", runId: null, status: "running", startedAt };
  applyThreadEventForTest("thread:runless", { kind: "snapshot", projection: {
    thread: { creationSource: "provider", lineage: { relationshipToParent: "subagent" } },
    messages: [], runs: [], nodes: [node], turnItems: [],
  } });
  expect(threadWorking()).toBe(true);
  expect(subagentStatusFor(threadExecutionNodes())?.status).toBe("running");
  expect(threadWorkStartedAt()).toBe(Date.parse(startedAt));
  applyThreadEventForTest("thread:runless", { kind: "event", sequence: 1, event: { type: "node.updated", payload: { ...node, status: "completed" } } });
  expect(threadWorking()).toBe(false);
  expect(subagentStatusFor(threadExecutionNodes())?.status).toBe("completed");
});

test("a retained thread stops working as soon as its provider turn completes", () => {
  seed("thread:provider-ended", "thread:provider-other");
  const transport = setFakeClientForTest();
  openThreadById("thread:provider-ended");
  applyThreadEventForTest("thread:provider-ended", { kind: "snapshot", snapshotSequence: 1, projection: {
    messages: [{ id: "message:one", role: "user", text: "hello", createdAt: iso() }], turnItems: [], runs: [{ id: "run:one", userMessageId: "message:one", status: "running", activeAttemptId: "attempt:one", ordinal: 1 }],
    providerTurns: [{ id: "turn:one", providerThreadId: "provider:one", runAttemptId: "attempt:one", status: "running" }],
    providerSessions: [{ id: "session:one", status: "running", capabilities: { turns: { supportsActiveSteering: true } } }],
    providerThreads: [{ id: "provider:one", appThreadId: "thread:provider-ended", providerSessionId: "session:one" }],
  } });
  openThreadById("thread:provider-other");
  const release = retainThread("thread:provider-ended");
  const retainedQueue = threadQueueFor(() => "thread:provider-ended");
  expect(threadWorkFor("thread:provider-ended").working).toBe(true);
  expect(retainedQueue.queue().activeRun?.id).toBe("run:one");
  expect(retainedQueue.queue().canPromoteToSteer).toBe(true);
  transport.emitToCurrentSubscription({ kind: "event", sequence: 2, event: { type: "provider-turn.updated", payload: {
    id: "turn:one", providerThreadId: "provider:one", runAttemptId: "attempt:one", status: "completed",
  } } });
  expect(threadWorkFor("thread:provider-ended").working).toBe(false);
  expect(retainedQueue.endedRunId()).toBe("run:one");
  expect(retainedQueue.queue().canSendNow).toBe(true);
  expect(retainedQueue.queue().canPromoteToSteer).toBe(false);
  release();
});

test("returning to a live retained thread adopts its updates and resumes after the latest event", () => {
  seed("thread:retained-a", "thread:retained-b");
  const transport = setFakeClientForTest();
  openThreadById("thread:retained-a");
  applyThreadEventForTest("thread:retained-a", { kind: "snapshot", snapshotSequence: 10, projection: {
    thread: { id: "thread:retained-a", activeProviderThreadId: "provider-thread:1" },
    messages: [{ id: "message:retained", role: "user", text: "kept body", createdAt: iso() }],
    runs: [{ id: "run:retained", status: "running", ordinal: 1, userMessageId: "message:retained" }],
    attempts: [{ id: "attempt:cached", runId: "run:retained", status: "completed" }],
    nodes: [{ id: "node:cached", runAttemptId: "attempt:cached", kind: "root_turn", status: "completed" }],
    turnItems: [{ id: "fork:cached", type: "fork", title: "Cached fork" }], providerSessions: [{ id: "session:retained", status: "running", providerInstanceId: "codex" }],
    subagents: [{ id: "agent:retained", childThreadId: "thread:child", title: "Initial", status: "running" }],
    providerThreads: [{ id: "provider-thread:1", appThreadId: "thread:retained-a", providerSessionId: "session:retained", providerInstanceId: "codex" }],
  } });
  openThreadById("thread:retained-b");
  const release = retainThread("thread:retained-a");
  expect(threadSubagentRecordsFor("thread:retained-a")[0]?.title).toBe("Initial");
  expect(threadAttemptSourcesFor("thread:retained-a")?.attempts[0]?.id).toBe("attempt:cached");
  expect(threadAttemptSourcesFor("thread:retained-a")?.nodes[0]?.id).toBe("node:cached");
  expect(threadLifecycleItemsFor("thread:retained-a")["fork:cached"]?.title).toBe("Cached fork");
  const retainedActivity = threadActivityFor("thread:retained-a");
  expect(threadActivityFor("thread:retained-a") === retainedActivity).toBe(true);
  const sideInput = transport.subscribeThreadInputs().at(-1) as Record<string, unknown>;
  expect(sideInput.afterSequence).toBe(10);
  transport.emitToCurrentSubscription({ kind: "event", sequence: 11, event: { type: "turn-item.updated", payload: {
    id: "item:retained", type: "command_execution", status: "running", startedAt: iso(), updatedAt: iso(),
  } } });
  transport.emitToCurrentSubscription({ kind: "event", sequence: 12, event: { type: "provider-turn.updated", payload: {
    id: "provider-turn:1", providerThreadId: "provider-thread:1", runAttemptId: "attempt:1", status: "running",
  } } });
  transport.emitToCurrentSubscription({ kind: "event", sequence: 13, event: { type: "run.updated", payload: {
    id: "run:retained", status: "waiting", ordinal: 1, userMessageId: "message:retained",
  } } });
  transport.emitToCurrentSubscription({ kind: "event", sequence: 14, event: { type: "subagent.updated", payload: {
    id: "agent:retained", childThreadId: "thread:child", title: "Updated", status: "completed",
  } } });
  expect(threadSubagentRecordsFor("thread:retained-a")[0]?.title).toBe("Updated");
  openThreadById("thread:retained-a");
  expect(threadActivity().some((item) => item.id === "item:retained")).toBe(true);
  expect(threadMessages()[0]?.body).toBe("kept body");
  expect(providerState().turns[0]?.id).toBe("provider-turn:1");
  expect(threadSessionState().runs[0]?.status).toBe("waiting");
  expect(threadSyncPhase()).toBe(null);
  const openInput = transport.subscribeThreadInputs().at(-1) as Record<string, unknown>;
  expect(openInput.afterSequence).toBe(14);
  // The resumed open subscription may omit text already sent to its retained predecessor.
  transport.emitToCurrentSubscription({ kind: "event", sequence: 15, event: { type: "turn-item.updated", payload: {
    id: "item:user-retained", type: "user_message", messageId: "message:retained", textOmitted: true,
  } } });
  expect(threadAttemptSourcesFor("thread:retained-a")?.messageItems.get("message:retained")?.text).toBe("kept body");
  release();
});

function timelineLength() {
  return mergeTimeline(threadMessages(), threadActivity()).length;
}

test("re-opening an already-loaded thread restores its activity and messages in the same tick, with no empty gap", () => {
  seed("thread:a", "thread:b");

  openThreadById("thread:a");
  markThreadSubscribingForTest("thread:a");
  snapshotFor("thread:a", "message:a1", "item:a1");
  expect(threadMessages().length).toBe(1);
  expect(threadActivity().length).toBe(1);
  expect(threadSyncPhase()).toBe(null);
  const activityA = threadActivity();

  openThreadById("thread:b");
  markThreadSubscribingForTest("thread:b");
  snapshotFor("thread:b", "message:b1", "item:b1");
  expect(threadMessages().length).toBe(1);
  expect(threadActivity().length).toBe(1);

  // Switch back to A with no new server event: its cached detail must already be in place the instant
  // openThreadById returns, not after another round trip. timelineLength() is read straight after the
  // switch call, the same way the render that follows it would read it.
  openThreadById("thread:a");
  markThreadSubscribingForTest("thread:a");
  expect(threadMessages()[0]?.body).toBe("hello from thread:a");
  expect(threadActivity().length).toBe(1);
  expect(timelineLength()).toBe(2);
  expect(threadActivity()).toBe(activityA);
  // A thread that had fully loaded before is not "loading" again: no blank Timeline-loading panel.
  expect(threadSyncPhase()).toBe(null);

  // And B, switched back to, still has its own cached detail (the cache holds more than one thread at once).
  openThreadById("thread:b");
  markThreadSubscribingForTest("thread:b");
  expect(threadMessages()[0]?.body).toBe("hello from thread:b");
  expect(threadActivity().length).toBe(1);
  expect(timelineLength()).toBe(2);
  expect(threadSyncPhase()).toBe(null);
});

test("a burst of shell updates for other threads (plus a shell-only update of the open thread) never empties its rows or resubscribes it", () => {
  setRequestBackendForTest(() => Promise.resolve({}));
  setBackendStatusForTest("connected");
  const { subscribeThreadCalls, failCurrentSubscription } = setFakeClientForTest();
  const openShell = {
    id: "thread:e", projectId: "project-2", title: "Thread E", creationSource: "web", providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"], status: "completed",
    latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null,
    createdAt: iso(), updatedAt: iso(),
  };
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-2", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(), updatedAt: iso() }],
    threads: [openShell],
  } });

  openThreadById("thread:e");
  expect(subscribeThreadCalls()).toBe(1);
  applyThreadEventForTest("thread:e", { kind: "snapshot", projection: {
    messages: [{ id: "message:e1", role: "user", text: "hello from thread:e", createdAt: iso() }],
    turnItems: [{ id: "item:e1", type: "command_execution", status: "completed", startedAt: iso(), updatedAt: iso() }],
    runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
    providerSessions: [{ id: "session:e1", providerInstanceId: "codex", status: "active", extensionStatuses: [] }],
  } });
  expect(threadMessages().length).toBe(1);
  expect(threadActivity().length).toBe(1);
  expect(threadSessionState().sessions.length).toBe(1);

  // The live subscription for the open thread drops (server load during the import, say): subscribedThreadId is
  // nulled by its error callback even though the thread itself never changed and its detail is still loaded.
  failCurrentSubscription(new Error("stream interrupted"));
  expect(threadMessages().length).toBe(1);
  expect(threadActivity().length).toBe(1);
  // resetBannerThreadState must not run for this re-entry either, or the provider-session banner (the extension
  // status pill) blanks out until the server happens to resend a full snapshot.
  expect(threadSessionState().sessions.length).toBe(1);

  // An agent-history import: a burst of thread.updated for brand-new threads, which never touch the open thread.
  // The first of these re-enters subscribeOpenThread with id !== subscribedThreadId (the drop above) and must
  // restore the subscription without wiping what is already shown; subscribeThreadCalls below proves it does
  // not resubscribe again and again as the burst continues.
  for (let index = 0; index < 5; index++) {
    applyShellEventForTest({ kind: "thread.updated", location: "active", thread: {
      id: `thread:import-${index}`, projectId: "project-2", title: `Imported ${index}`, creationSource: "web",
      providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"],
      status: "idle", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null,
      createdAt: iso(), updatedAt: iso(),
    } });
    expect(threadMessages().length).toBe(1);
    expect(threadActivity().length).toBe(1);
    expect(threadSessionState().sessions.length).toBe(1);
    // One resubscribe restored the dropped subscription (on the first of these events); the rest of the burst
    // must not trigger another one.
    expect(subscribeThreadCalls()).toBe(2);
  }

  // A shell-only update of the open thread itself (settledAt / updatedAt, as "Settled just now" ticking does):
  // its own detail (messages, activity) must stay exactly as it was, and it must not be resubscribed either.
  applyShellEventForTest({ kind: "thread.updated", location: "active", thread: { ...openShell, settledOverride: "manual", updatedAt: iso() } });
  expect(threadMessages().length).toBe(1);
  expect(threadMessages()[0]?.body).toBe("hello from thread:e");
  expect(threadActivity().length).toBe(1);
  expect(subscribeThreadCalls()).toBe(2);

  // A repeated full shell snapshot (every thread re-sent, as a periodic refresh would) is no different.
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-2", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(), updatedAt: iso() }],
    threads: [openShell, ...Array.from({ length: 5 }, (_, index) => ({
      id: `thread:import-${index}`, projectId: "project-2", title: `Imported ${index}`, creationSource: "web",
      providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"],
      status: "idle", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null,
      createdAt: iso(), updatedAt: iso(),
    }))],
  } });
  expect(threadMessages().length).toBe(1);
  expect(threadActivity().length).toBe(1);
  expect(subscribeThreadCalls()).toBe(2);
});

test("a thread that never finished loading is still shown as loading when revisited", () => {
  seed("thread:c", "thread:d");
  openThreadById("thread:c");
  markThreadSubscribingForTest("thread:c");
  // No snapshot delivered yet: thread:c never finished loading before the reader switches away.
  expect(threadMessages().length).toBe(0);
  expect(threadSyncPhase()).toBe("loading");
  openThreadById("thread:d");
  markThreadSubscribingForTest("thread:d");
  snapshotFor("thread:d", "message:d1", "item:d1");
  openThreadById("thread:c");
  markThreadSubscribingForTest("thread:c");
  expect(threadMessages().length).toBe(0);
  expect(threadActivity().length).toBe(0);
  expect(threadSyncPhase()).toBe("loading");
});

test("streaming message records and replacement snapshots retain server ordering", () => {
  const id = "thread:streaming-order";
  seed(id, "thread:streaming-order-other");
  setFakeClientForTest();
  openThreadById(id);
  const date = (seconds: number) => new Date(seconds * 1000).toISOString();
  const start = { id: "stream-start", role: "user", text: "Start", createdAt: date(4) };
  const answer = { id: "stream-answer", role: "assistant", text: "Answer", createdAt: date(1) };
  const items = [
    { id: "item-start", type: "user_message", messageId: start.id, text: start.text, ordinal: 1, startedAt: date(4) },
    { id: "tool-stream", type: "command_execution", status: "completed", ordinal: 2, startedAt: date(2) },
    { id: "item-answer", type: "assistant_message", messageId: answer.id, text: answer.text, ordinal: 3, startedAt: date(1) },
  ];
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 0, projection: { messages: [start, answer], turnItems: items } });
  const rows = () => mergeTimeline(threadMessages(), threadActivity()).map((row) => row.id);
  const original = rows();
  const stream = { id: "stream-next", role: "assistant", text: "Growing response", streaming: true, createdAt: date(5) };
  applyThreadEventForTest(id, { kind: "event", sequence: 1, event: { type: "message.updated", payload: stream } });
  expect(rows().filter((key) => key !== "message:stream-next")).toEqual(original);
  const item = { id: "item-next", type: "assistant_message", messageId: stream.id, text: stream.text, streaming: true, ordinal: 4, startedAt: date(5) };
  applyThreadEventForTest(id, { kind: "event", sequence: 2, event: { type: "turn-item.updated", payload: item } });
  applyThreadEventForTest(id, { kind: "event", sequence: 3, event: { type: "message.updated", payload: { ...stream, text: "Growing response with more tokens" } } });
  expect(threadMessages().find((message) => message.id === stream.id)?.ordinal).toBe(4);
  const beforeRefresh = rows();
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 3, projection: { messages: [start, answer, stream], turnItems: [...items, item] } });
  expect(rows()).toEqual(beforeRefresh);
  expect(threadMessages().find((message) => message.id === stream.id)?.ordinal).toBe(4);
});
