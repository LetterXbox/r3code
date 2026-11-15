// Optimistic send (useComposerSend / optimisticUserMessages.ts): the message is in the transcript and the draft is clear the
// moment Send is pressed; a failed dispatch takes the echo back out, restores the draft and raises the thread error.
import { expect, test } from "nsh/test";
import {
  applyConfigEventForTest, applyShellEventForTest, applyThreadEventForTest, composerDraft, openThreadById, sendDraft,
  setBackendStatusForTest, pendingQueuedSendsFor, setComposerDraft, setRequestBackendForTest, setSelectedModel, setThreadError, threadLocalError, threadMessages,
} from "./store";

const iso = () => new Date().toISOString();
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}
let sentCommands: Record<string, unknown>[] = [];
let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;

function seed(threadId: string) {
  sentCommands = [];
  setRequestBackendForTest((method, payload) => {
    if (method !== "orchestration.dispatchCommand") return Promise.resolve({});
    sentCommands.push(payload as Record<string, unknown>);
    return new Promise((resolve, reject) => { settle = { resolve, reject }; });
  });
  setBackendStatusForTest("connected");
  applyConfigEventForTest({ type: "snapshot", config: { providers: [
    { instanceId: "codex", driver: "codex", displayName: "Codex", models: [{ slug: "gpt-6.1-sol", name: "GPT" }] },
  ] } });
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(), updatedAt: iso() }],
    threads: [{ id: threadId, projectId: "project-1", title: "Thread", creationSource: "web", providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"], status: "completed",
      latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: iso(), updatedAt: iso() }],
  } });
  openThreadById(threadId);
  setSelectedModel("codex", "gpt-6.1-sol");
}

test("the message echoes and the draft clears at once, before the server answers", () => {
  seed("thread:opt1");
  setComposerDraft("hello there");
  sendDraft();
  expect(composerDraft()).toBe("");
  const echoed = threadMessages().filter((message) => message.role === "user");
  expect(echoed.map((message) => [message.body, message.pending])).toEqual([["hello there", true]]);
  expect(sentCommands.length).toBe(1);
  settle?.resolve({});
});

test("the server's copy of the message replaces the echo without a duplicate", async () => {
  seed("thread:opt2");
  setComposerDraft("one");
  sendDraft();
  const messageId = String(sentCommands[0].messageId);
  applyThreadEventForTest("thread:opt2", { kind: "event", event: { type: "turn-item.updated", payload: {
    id: "item:1", type: "user_message", messageId, text: "one", status: "completed", inputIntent: "start_turn", createdBy: "user",
    startedAt: iso(), updatedAt: iso(), ordinal: 1, attachments: [],
  } } });
  settle?.resolve({});
  const users = threadMessages().filter((message) => message.role === "user");
  expect(users.length).toBe(1);
  expect(users[0].pending).toBe(undefined);
  expect(users[0].inputIntent).toBe("start_turn");
});

test("a failed dispatch removes the echo, restores the draft and raises the thread error", async () => {
  seed("thread:opt3");
  setComposerDraft("will fail");
  sendDraft();
  expect(composerDraft()).toBe("");
  settle?.reject(new Error("Provider is offline"));
  await until(() => threadLocalError("thread:opt3") === "Provider is offline");
  expect(threadMessages().filter((message) => message.role === "user").length).toBe(0);
  expect(composerDraft()).toBe("will fail");
  setThreadError("thread:opt3", null);
  expect(threadLocalError("thread:opt3")).toBe(null);
});

test("text typed while the send was in flight is kept when the send fails", async () => {
  seed("thread:opt4");
  setComposerDraft("first");
  sendDraft();
  setComposerDraft("second draft");
  settle?.reject(new Error("nope"));
  await until(() => threadLocalError("thread:opt4") === "nope");
  expect(composerDraft()).toBe("second draft");
});

test("a queued send does not echo into the timeline", () => {
  seed("thread:opt5");
  setComposerDraft("later");
  sendDraft({ intent: "queue" });
  expect(threadMessages().length).toBe(0);
  expect(composerDraft()).toBe("");
  // QueuedRunsControl: it shows in the composer's queue as a "Saving" row until the server's queued run arrives.
  expect(pendingQueuedSendsFor("thread:opt5").map((item) => item.text)).toEqual(["later"]);
  settle?.resolve({});
});

test("a queued send that fails drops its Saving row", async () => {
  seed("thread:opt5b");
  setComposerDraft("later too");
  sendDraft({ intent: "queue" });
  expect(pendingQueuedSendsFor("thread:opt5b").length).toBe(1);
  settle?.reject(new Error("nope"));
  await until(() => pendingQueuedSendsFor("thread:opt5b").length === 0);
});

test("sending without a connection toasts and keeps the draft; an empty message sends nothing", () => {
  seed("thread:opt6");
  setBackendStatusForTest("disconnected");
  setComposerDraft("offline text");
  sendDraft();
  expect(composerDraft()).toBe("offline text");
  expect(threadMessages().length).toBe(0);
  setBackendStatusForTest("connected");
  setComposerDraft("   ");
  sendDraft();
  expect(sentCommands.length).toBe(0);
});

test("a later message.updated record keeps the turn item's steer intent", () => {
  seed("thread:opt7");
  applyThreadEventForTest("thread:opt7", { kind: "event", event: { type: "turn-item.updated", payload: {
    id: "item:s", type: "user_message", messageId: "m-steer", text: "left", status: "completed", inputIntent: "steer", createdBy: "user",
    startedAt: iso(), updatedAt: iso(), ordinal: 1, attachments: [],
  } } });
  applyThreadEventForTest("thread:opt7", { kind: "event", event: { type: "message.updated", payload: { id: "m-steer", role: "user", text: "left", createdAt: iso() } } });
  expect(threadMessages().find((message) => message.id === "m-steer")?.inputIntent).toBe("steer");
});

test("a send the server queued behind a running turn leaves the timeline", () => {
  seed("thread:opt8");
  setComposerDraft("wait for it");
  sendDraft();
  const messageId = String(sentCommands[0].messageId);
  expect(threadMessages().length).toBe(1);
  applyThreadEventForTest("thread:opt8", { kind: "event", event: { type: "run.created", payload: { id: "run:q", threadId: "thread:opt8", ordinal: 2, status: "queued", userMessageId: messageId } } });
  expect(threadMessages().length).toBe(0);
  settle?.resolve({});
});
