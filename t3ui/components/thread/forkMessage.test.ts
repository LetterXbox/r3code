import { expect, test } from "nsh/test";
import { findForkCandidate, forkMessageWith, verifyForkSupport } from "./forkMessage";
import { record } from "../../backend/client";
import type { Thread } from "../../store";

const thread: Thread = { id: "source", projectId: "project", title: "Original", status: "idle", pinned: false, updatedAt: 0 };
const item = { id: "item", type: "assistant_message", messageId: "message", status: "completed", streaming: false, runId: "run", providerThreadId: "provider-thread" };
function snapshot(canHandoff = true) {
  return {
    thread: { id: "source" },
    visibleTurnItems: [{ sourceThreadId: "source", sourceItemId: "item", item }],
    turnItems: [item],
    providerThreads: [{ id: "provider-thread", providerSessionId: "session" }],
    providerSessions: [{ id: "session", capabilities: {
      threads: { canForkThread: false, canForkFromTurn: false }, identity: { nativeThreadIds: "weak" },
      context: { supportsFullThreadHandoff: canHandoff },
    } }],
  };
}

async function errorOf(promise: Promise<unknown>) {
  try { await promise; return ""; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
}

test("requires a completed response with a correlated source and fork-capable provider", () => {
  const candidate = findForkCandidate(snapshot(), "source", "message");
  expect(candidate.runId).toBe("run");
  verifyForkSupport(snapshot(), candidate);
  expect(() => verifyForkSupport(snapshot(false), candidate)).toThrow("provider cannot fork");
  expect(() => findForkCandidate(snapshot(), "source", "missing")).toThrow("not available");
  const partial = snapshot();
  partial.visibleTurnItems[0].item = { ...item, status: "running", streaming: true };
  expect(() => findForkCandidate(partial, "source", "message")).toThrow("completed response");
});

test("fork dispatch uses the source run and opens the new thread after it appears", async () => {
  const calls: { method: string; payload: unknown }[] = [];
  let opened = "";
  let nextId = 0;
  await forkMessageWith({
    request: async (method, payload) => { calls.push({ method, payload }); return method === "orchestration.getThreadProjection" ? snapshot() : {}; },
    connected: () => true, environment: () => "server", generation: () => 1, currentThread: () => thread,
    waitForThread: async () => true, open: (id) => { opened = id; }, newId: () => String(++nextId),
  }, "message");
  expect(calls.map((call) => call.method)).toEqual(["orchestration.getThreadProjection", "orchestration.dispatchCommand"]);
  const command = record(calls[1].payload);
  expect(command?.type).toBe("thread.fork");
  expect(command?.sourceThreadId).toBe("source");
  expect(command?.targetThreadId).toBe("thread:1");
  expect(record(command?.sourcePoint)?.runId).toBe("run");
  expect(opened).toBe("thread:1");
});

test("an inherited response forks its original source thread and run", async () => {
  const child: Thread = { ...thread, id: "child" };
  const inherited = { ...snapshot(), thread: { id: "child" } };
  const calls: { method: string; payload: unknown }[] = [];
  await forkMessageWith({
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method !== "orchestration.getThreadProjection") return {};
      return record(payload)?.threadId === "child" ? inherited : snapshot();
    },
    connected: () => true, environment: () => "server", generation: () => 1, currentThread: () => child,
    waitForThread: async () => true, open: () => {}, newId: () => "id",
  }, "message");
  expect(calls.map((call) => call.method)).toEqual(["orchestration.getThreadProjection", "orchestration.getThreadProjection", "orchestration.dispatchCommand"]);
  expect(record(calls[2].payload)?.sourceThreadId).toBe("source");
  expect(record(record(calls[2].payload)?.sourcePoint)?.runId).toBe("run");
});

test("a known incapable provider prevents the fork command", async () => {
  let dispatched = false;
  const error = await errorOf(forkMessageWith({
    request: async (method) => { if (method === "orchestration.getThreadProjection") return snapshot(false); dispatched = true; return {}; },
    connected: () => true, environment: () => "server", generation: () => 1, currentThread: () => thread,
    waitForThread: async () => true, open: () => {}, newId: () => "id",
  }, "message"));
  expect(error).toBe("This provider cannot fork from a response.");
  expect(dispatched).toBe(false);
});

test("changing the environment before dispatch prevents the fork", async () => {
  let generation = 1;
  let dispatched = false;
  const error = await errorOf(forkMessageWith({
    request: async (method) => { if (method === "orchestration.getThreadProjection") { generation = 2; return snapshot(); } dispatched = true; return {}; },
    connected: () => true, environment: () => "server", generation: () => generation, currentThread: () => thread,
    waitForThread: async () => true, open: () => {}, newId: () => "id",
  }, "message"));
  expect(error).toBe("The environment changed before the response could be forked.");
  expect(dispatched).toBe(false);
});

test("a timed-out fork reports its uncertain outcome", async () => {
  const error = await errorOf(forkMessageWith({
    request: async (method) => {
      if (method === "orchestration.getThreadProjection") return snapshot();
      throw new Error("Request timed out. Its outcome may be unknown; check the thread before retrying.");
    },
    connected: () => true, environment: () => "server", generation: () => 1, currentThread: () => thread,
    waitForThread: async () => false, open: () => {}, newId: () => "id",
  }, "message"));
  expect(error).toBe("The fork request timed out and may have succeeded. Check the sidebar before retrying.");
});

test("a fork does not change the thread the user navigated to while it was being created", async () => {
  let selected = thread;
  let opened = "";
  await forkMessageWith({
    request: async (method) => method === "orchestration.getThreadProjection" ? snapshot() : {},
    connected: () => true, environment: () => "server", generation: () => 1, currentThread: () => selected,
    waitForThread: async () => { selected = { ...thread, id: "other" }; return true; },
    open: (id) => { opened = id; }, newId: () => "id",
  }, "message");
  expect(opened).toBe("");
});
