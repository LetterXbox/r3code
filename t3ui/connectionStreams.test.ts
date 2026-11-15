import { expect, test } from "nsh/test";
import {
  applyConfigEventForTest, applyShellEventForTest, onServerConfigEvent, SERVER_CONFIG_STREAM_INPUT, setBackendStatusForTest,
  setShellFetchForTests, shellSubscribeInput, startShellStreamForTest, streamRetryDelay,
} from "./store";
import { RequestFailure } from "./backend/client";
import { createThreadWireDecoder } from "./backend/threadWire";

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 400; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${label}`);
};

const configSnapshot = (serverVersion = "1.0.0", databaseMigration: number | null = 7) => ({
  type: "snapshot",
  config: { environment: { environmentId: "env-1", label: "Local", serverVersion, databaseMigration }, shellThreadFamilies: true, shellOlderSettled: true, providers: [], settings: { a: 1 } },
});

// apps/web state/server.ts + connection/runtime.ts: the one config stream asks for themes, usage sources and the limits command.
test("the config stream carries the reference's flags", () => {
  expect(SERVER_CONFIG_STREAM_INPUT).toEqual({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true });
});

// rpc/session.ts serverConfigReplayEvents: a late reader (Usage, Settings > Providers) gets the projection, themes and sources.
test("a late config reader gets the current projection, then the latest themes and sources events", () => {
  applyConfigEventForTest(configSnapshot());
  applyConfigEventForTest({ type: "settingsUpdated", payload: { settings: { a: 2 } } });
  applyConfigEventForTest({ type: "usageLimitSourcesUpdated", payload: { sources: [{ id: "hub" }] } });
  applyConfigEventForTest({ type: "environmentThemesUpdated", payload: { themes: [{ id: "ocean" }] } });
  const seen: Record<string, unknown>[] = [];
  const stop = onServerConfigEvent((event) => seen.push(event));
  expect(seen.map((event) => event.type)).toEqual(["snapshot", "environmentThemesUpdated", "usageLimitSourcesUpdated"]);
  expect((seen[0]!.config as { settings: unknown }).settings).toEqual({ a: 2 });
  applyConfigEventForTest({ type: "providerStatuses", payload: { providers: [] } });
  stop();
  expect(seen.length).toBe(4);
});

// rpc/client.ts: 250 ms, doubling, capped at 30 s.
test("stream retries back off from 250 ms to 30 s", () => {
  expect([0, 1, 2, 3, 7, 12].map(streamRetryDelay)).toEqual([250, 500, 1000, 2000, 30000, 30000]);
});

// shell.ts canResumeFrom: only rows from the same server build and migration resume, with httpSnapshotFallback.
test("the shell resumes only rows from the same server build and migration", () => {
  setBackendStatusForTest("connected", "ws://resume.test/ws");
  applyConfigEventForTest(configSnapshot("1.0.0", 7));
  applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 40, projects: [], threads: [] } });
  applyShellEventForTest({ kind: "project.removed", sequence: 42, projectId: "gone" });
  expect(shellSubscribeInput("ws://resume.test/ws")).toEqual({ afterSequence: 42, httpSnapshotFallback: true, omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  applyConfigEventForTest(configSnapshot("1.0.1", 7));
  expect(shellSubscribeInput("ws://resume.test/ws")).toEqual({ omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  applyConfigEventForTest(configSnapshot("1.0.0", 8));
  expect(shellSubscribeInput("ws://resume.test/ws")).toEqual({ omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  applyConfigEventForTest(configSnapshot("1.0.0", 7));
  // snapshot-required: the rows stay, but the next subscribe reloads.
  applyShellEventForTest({ kind: "snapshot-required" });
  expect(shellSubscribeInput("ws://resume.test/ws")).toEqual({ omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  setBackendStatusForTest("disconnected");
});

function fakeShellClient() {
  const calls: { method: string; payload: any; receive: (value: unknown) => void; reject: (error: Error) => void; stopped: boolean }[] = [];
  const client = {
    subscribe: (method: string, payload: unknown, receive: (value: unknown) => void, reject: (error: Error) => void) => {
      const call = { method, payload, receive, reject, stopped: false };
      calls.push(call);
      return () => { call.stopped = true; };
    },
    request: () => Promise.resolve({}),
  };
  return { client, calls };
}

// shell.ts: no cursor loads GET /api/orchestration/shell, then subscribes after its cursor (no httpSnapshotFallback).
test("a cold shell loads the HTTP snapshot and subscribes after its cursor; a failed stream retries alone", async () => {
  setBackendStatusForTest("connected", "ws://cold.test/ws");
  applyConfigEventForTest(configSnapshot());
  applyShellEventForTest({ kind: "snapshot-required" });
  const urls: string[] = [];
  setShellFetchForTests((async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(`${url} ${init.headers["x-t3-orchestration-protocol"]}`);
    return { status: 200, json: async () => ({ snapshotSequence: 90, projects: [], threads: [] }) };
  }) as never);
  const { client, calls } = fakeShellClient();
  startShellStreamForTest(client, "ws://cold.test/ws", "bearer");
  await until(() => calls.length === 1, "the first shell subscribe");
  expect(urls).toEqual(["http://cold.test/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1 2"]);
  expect(calls[0]!.payload).toEqual({ afterSequence: 90, omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  // An expected failure retries this stream only (no socket close), resuming the rows it now holds.
  calls[0]!.reject(new RequestFailure("boom", "OrchestrationV2SubscribeShellError"));
  await until(() => calls.length === 2, "the retried shell subscribe");
  expect(calls[1]!.payload).toEqual({ afterSequence: 90, httpSnapshotFallback: true, omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  // A refused cursor reloads over HTTP and subscribes after the fresh cursor.
  calls[1]!.receive({ kind: "snapshot-required" });
  await until(() => calls.length === 3, "the reload after snapshot-required");
  expect(calls[1]!.stopped).toBe(true);
  expect(urls.length).toBe(2);
  expect(calls[2]!.payload).toEqual({ afterSequence: 90, omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  // An authorization failure does not retry.
  calls[2]!.reject(new RequestFailure("denied", "EnvironmentAuthorizationError"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(calls.length).toBe(3);
  setShellFetchForTests(null);
  setBackendStatusForTest("disconnected");
});

test("a failed HTTP shell snapshot falls back to the socket snapshot", async () => {
  setBackendStatusForTest("connected", "ws://fallback.test/ws");
  applyConfigEventForTest(configSnapshot());
  applyShellEventForTest({ kind: "snapshot-required" });
  setShellFetchForTests((async () => ({ status: 502, json: async () => ({}) })) as never);
  const { client, calls } = fakeShellClient();
  startShellStreamForTest(client, "ws://fallback.test/ws", "bearer");
  await until(() => calls.length === 1, "the socket subscribe");
  expect(calls[0]!.payload).toEqual({ omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  setShellFetchForTests(null);
  setBackendStatusForTest("disconnected");
});

// Thread compact wire forms (orchestrationV2IdTable.ts, orchestrationV2BoundedSnapshot.ts, orchestrationV2DedupedBodies.ts).
test("thread wire forms: id table, omitted local turn items and deduped bodies are restored", () => {
  const decode = createThreadWireDecoder();
  const user = { type: "user_message", id: 2, threadId: 0, messageId: 3, text: "", textOmitted: true };
  const inherited = { type: "assistant_message", id: "item-x", threadId: "other", messageId: "m-x", text: "inherited" };
  const snapshot = decode({
    kind: "snapshot", snapshotSequence: 5, turnItemsOmitLocalVisible: true, ids: ["thread-1", "row-1", "item-1", "m-1"],
    projection: {
      thread: { id: 0 },
      messages: [{ id: 3, text: "hello" }],
      checkpoints: [], subagents: [{ id: "s1", prompt: "do it", result: "done" }],
      visibleTurnItems: [{ id: 1, visibility: "local", item: user }, { id: "row-x", visibility: "inherited", sourceThreadId: "other", item: inherited }],
      turnItems: [inherited],
    },
  }) as any;
  expect(snapshot.ids).toBe(undefined);
  expect(snapshot.turnItemsOmitLocalVisible).toBe(undefined);
  expect(snapshot.projection.thread.id).toBe("thread-1");
  expect(snapshot.projection.turnItems.map((item: any) => [item.id, item.text, item.textOmitted])).toEqual([["item-1", "hello", undefined], ["item-x", "inherited", undefined]]);
  expect(snapshot.projection.visibleTurnItems[0].item).toBe(snapshot.projection.turnItems[0]);
  const event = decode({ kind: "event", sequence: 6, event: { type: "turn-item.updated", payload: { type: "assistant_message", id: "item-1", messageId: "m-1", text: "", textOmitted: true } } }) as any;
  expect(event.event.payload.text).toBe("hello");
  const agent = decode({ kind: "event", sequence: 7, event: { type: "subagent.updated", payload: { id: "s1", prompt: "", promptOmitted: true, result: "new" } } }) as any;
  expect([agent.event.payload.prompt, agent.event.payload.promptOmitted, agent.event.payload.result]).toEqual(["do it", undefined, "new"]);
  decode({ kind: "event", sequence: 8, event: { type: "message.updated", payload: { id: "m-2", text: "later" } } });
  const later = decode({ kind: "event", sequence: 9, event: { type: "turn-item.updated", payload: { type: "assistant_message", id: "item-2", messageId: "m-2", text: "", textOmitted: true } } }) as any;
  expect(later.event.payload.text).toBe("later");
});

// threads.ts: a socket-only cold open that fails asks HTTP /bounded; a 404 parks the thread instead of retrying.
test("a failed cold thread open loads the bounded HTTP snapshot and resumes after it; a missing thread parks", async () => {
  const { applyShellEventForTest: shell, openThreadById, setFakeClientForTest, setRequestBackendForTest, setBoundedThreadFetchForTests, threadMessages } = await import("./store");
  setRequestBackendForTest(() => Promise.resolve({}));
  setBackendStatusForTest("connected", "ws://bounded.test/ws");
  const iso = new Date().toISOString();
  const row = (id: string) => ({ id, projectId: "p1", title: id, creationSource: "web", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "m" },
    providerInstanceHistory: ["codex"], status: "completed", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: iso, updatedAt: iso });
  const fake = setFakeClientForTest();
  shell({ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p1", title: "p", workspaceRoot: "/w", createdAt: iso, updatedAt: iso }], threads: [row("tb-1"), row("tb-gone")] } });
  const urls: string[] = [];
  setBoundedThreadFetchForTests((async (url: string) => {
    urls.push(url);
    if (url.includes("tb-gone")) return { status: 404, json: async () => ({ _tag: "EnvironmentResourceNotFoundError", message: "missing" }) };
    return { status: 200, json: async () => ({ snapshotSequence: 33, historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: null, ids: ["tb-1", "m-1"],
      projection: { thread: { id: 0 }, messages: [{ id: 1, role: "user", text: "from http", createdAt: iso }], turnItems: [], visibleTurnItems: [], runs: [], checkpoints: [], subagents: [], runtimeRequests: [] } }) };
  }) as never, { url: "ws://bounded.test/ws", bearer: "b" });
  openThreadById("tb-1");
  await until(() => fake.subscribeThreadCalls() === 1, "the first thread subscribe");
  expect((fake.subscribeThreadInputs()[0] as Record<string, unknown>).acceptDedupedBodies).toBe(true);
  fake.failCurrentSubscription(new Error("socket open failed"));
  await until(() => fake.subscribeThreadCalls() === 2, "the resubscribe after the HTTP snapshot");
  expect(urls[0]).toBe("http://bounded.test/api/orchestration/threads/tb-1/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1");
  expect((fake.subscribeThreadInputs()[1] as Record<string, unknown>).afterSequence).toBe(33);
  expect(threadMessages().some((message) => message.id === "m-1" && message.body === "from http")).toBe(true);
  openThreadById("tb-gone");
  await until(() => fake.subscribeThreadCalls() === 3, "the missing thread's subscribe");
  fake.failCurrentSubscription(new Error("socket open failed"));
  await until(() => urls.length === 2, "the missing thread's HTTP read");
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(fake.subscribeThreadCalls()).toBe(3);
  setBoundedThreadFetchForTests(null);
  setBackendStatusForTest("disconnected");
});

// connection/compatibility.ts: protocol skew blocks the connection; an older self-updatable server asks for an update.
test("orchestration protocol skew is reported as the reference does", async () => {
  const { orchestrationProtocolCompatibilityError: check } = await import("./store");
  expect(check({ label: "Box", orchestrationProtocolVersion: 2 })).toBe(null);
  expect(check(null)).toBe(null);
  expect(check({ label: "Box", orchestrationProtocolVersion: 3 })?.detail).toBe("This client is not supported by this server. Update your app or use a compatible release to connect to Box.");
  const old = check({ label: "Box", capabilities: { serverSelfUpdate: "npm" } });
  expect([old?.detail, old?.serverUpdateRequired]).toEqual(["This client requires a newer server. Update T3 Code on Box to connect.", true]);
  expect(check({ label: "Box", orchestrationProtocolVersion: 1, capabilities: { serverSelfUpdate: "desktop-managed" } })?.serverUpdateRequired).toBe(undefined);
});

// shell.ts: omissions follow the server's shellThreadFamilies / shellOlderSettled; the shelf reads pages below the cut.
test("omissions follow the server's capabilities and the Settled shelf reads older pages", async () => {
  const st = await import("./store");
  const { settledThreadCount } = await import("./components/sidebar/sidebarModel");
  const sections = (count: number) => ({ pinned: [], loose: [], working: [], snoozed: [], projects: [], settled: Array.from({ length: count }, () => ({} as never)) });
  setBackendStatusForTest("connected", "ws://older.test/ws");
  applyConfigEventForTest(configSnapshot());
  applyShellEventForTest({ kind: "snapshot-required" });
  expect(shellSubscribeInput("ws://older.test/ws")).toEqual({ omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  const iso = "2026-01-01T00:00:00.000Z";
  const row = (id: string) => ({ id, projectId: "p1", title: id, creationSource: "web", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "m" },
    providerInstanceHistory: ["codex"], status: "completed", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: "settled", snoozedUntil: null, settledAt: iso, createdAt: iso, updatedAt: iso });
  applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 3, projects: [{ id: "p1", title: "p", workspaceRoot: "/w", createdAt: iso, updatedAt: iso }], threads: [],
    olderSettled: { before: "2026-02-01T00:00:00.000Z", asOfSequence: 3, counts: [{ projectId: "p1", count: 2 }] } } });
  expect(st.unloadedOlderSettledCount()).toBe(2);
  expect(settledThreadCount(sections(0))).toBe(2);
  applyShellEventForTest({ kind: "thread.updated", sequence: 4, location: "active", thread: row("old-1") });
  expect(st.unloadedOlderSettledCount()).toBe(1);
  expect(settledThreadCount(sections(1))).toBe(2);
  const calls: { method: string; payload: any }[] = [];
  st.setRequestBackendForTest(async (method: string, payload: unknown) => { calls.push({ method, payload }); return { snapshotSequence: 3, threads: [row("old-1"), row("old-2")], counts: [] }; });
  await st.loadOlderSettledPage();
  expect(calls).toEqual([{ method: "orchestration.getOlderSettledThreads", payload: { before: { settledAt: "2026-02-01T00:00:00.000Z" }, limit: 25 } }]);
  expect(st.unloadedOlderSettledCount()).toBe(0);
  expect(settledThreadCount(sections(2))).toBe(2);
  expect(st.olderSettledStatus()).toBe("done");
  setBackendStatusForTest("disconnected");
});

// threads.ts loadEarlier(workAnchorId): a deferred-work anchor reads /history?view=work through itself, keeps its
// thread's items between its ordinal and lastOrdinal, and drops deferredWork when complete.
test("collapsed work loads after its anchor and the anchor stops being deferred", async () => {
  const st = await import("./store");
  const { foldCompletedTurns } = await import("./components/thread/timeline/turnFolds");
  setBackendStatusForTest("connected", "ws://work.test/ws");
  const iso = new Date().toISOString();
  st.applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p1", title: "p", workspaceRoot: "/w", createdAt: iso, updatedAt: iso }], threads: [
    { id: "tw-1", projectId: "p1", title: "w", creationSource: "web", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "m" }, providerInstanceHistory: ["codex"], status: "completed", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: iso, updatedAt: iso }] } });
  st.setRequestBackendForTest(() => Promise.resolve({}));
  st.openThreadById("tw-1");
  const tool = (id: string, ordinal: number, extra: Record<string, unknown> = {}) => ({ id, threadId: "tw-1", type: "command_execution", status: "completed", ordinal, input: id, startedAt: iso, updatedAt: iso, ...extra });
  st.applyThreadEventForTest("tw-1", { kind: "snapshot", snapshotSequence: 2, projection: { messages: [], turnItems: [tool("a1", 1, { deferredWork: { cursor: "c1", itemCount: 2, lastOrdinal: 3 } })], runs: [], checkpoints: [], subagents: [], runtimeRequests: [] } });
  const urls: string[] = [];
  st.setThreadHistoryFetchForTests((async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => ({ snapshotSequence: 2, nextCursor: null, hasMoreHistory: false,
      items: [{ sourceThreadId: "tw-1", item: tool("a1", 1) }, { sourceThreadId: "tw-1", item: tool("a2", 2) }, { sourceThreadId: "tw-1", item: tool("a3", 3) }, { sourceThreadId: "tw-1", item: tool("a9", 9) }] }) };
  }) as never, { url: "ws://work.test/ws", bearer: "b" });
  expect(foldCompletedTurns([{ kind: "work", id: "work:a1", items: [{ id: "a1", type: "command_execution", title: "a1", detail: "", status: "completed", item: { deferredWork: {} } as never }], active: false }] as never, { running: false, expanded: {} }).length).toBe(1);
  expect(await st.loadDeferredWork("tw-1", "a1")).toBe("loaded");
  expect(urls[0]).toBe("http://work.test/api/orchestration/threads/tw-1/history?cursor=c1&throughEntryId=a1&view=work");
  const ids = st.threadActivity().map((item: { id: string }) => item.id);
  expect(ids.includes("a2") && ids.includes("a3") && !ids.includes("a9")).toBe(true);
  expect(await st.loadDeferredWork("tw-1", "a1")).toBe("noop");
  st.setThreadHistoryFetchForTests(null);
  setBackendStatusForTest("disconnected");
});

test("deferredWorkItemIds names the work items with a deferred cursor", async () => {
  const { deferredWorkItemIds } = await import("./components/thread/timeline/turnFolds");
  expect(deferredWorkItemIds([
    { kind: "work", id: "work:x", active: false, items: [{ id: "x", type: "t", title: "", detail: "", status: "completed", item: { deferredWork: { cursor: "c" } } as never }, { id: "y", type: "t", title: "", detail: "", status: "completed" }] },
  ] as never)).toEqual(["x"]);
});

test("older settled pages follow the sidebar's project scope", async () => {
  const st = await import("./store");
  setBackendStatusForTest("connected", "ws://scope.test/ws");
  const iso = "2026-01-01T00:00:00.000Z";
  applyConfigEventForTest(configSnapshot());
  applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 4, projects: [], threads: [], olderSettled: { before: iso, asOfSequence: 4, counts: [{ projectId: "p1", count: 3 }, { projectId: "p2", count: 5 }] } } });
  expect(st.unloadedOlderSettledCount(new Set(["p2"]))).toBe(5);
  const calls: any[] = [];
  st.setRequestBackendForTest(async (_method: string, payload: unknown) => { calls.push(payload); return { snapshotSequence: 4, threads: [], counts: [] }; });
  await st.loadOlderSettledPage(["p2"]);
  expect(calls[0]).toEqual({ before: { settledAt: iso }, projectIds: ["p2"], limit: 25 });
  // A short page marks paging complete; it does not replace the server's count.
  expect(st.unloadedOlderSettledCount(new Set(["p2"]))).toBe(5);
  expect(st.unloadedOlderSettledCount(new Set(["p1"]))).toBe(3);
  setBackendStatusForTest("disconnected");
});

test("older settled counts refresh after removals and ignore a response from an obsolete snapshot", async () => {
  const st = await import("./store");
  setBackendStatusForTest("connected", "ws://count-refresh.test/ws");
  const before = "2026-02-01T00:00:00.000Z";
  const snapshot = (sequence: number, count: number) => ({ kind: "snapshot", snapshot: { snapshotSequence: sequence, projects: [], threads: [], olderSettled: { before, asOfSequence: sequence, counts: [{ projectId: "p1", count }] } } });
  applyShellEventForTest(snapshot(1, 5));
  let resolveRead: ((value: unknown) => void) | undefined;
  const calls: unknown[] = [];
  st.setRequestBackendForTest(async (_method, payload) => { calls.push(payload); return await new Promise((resolve) => { resolveRead = resolve; }); });
  applyShellEventForTest({ kind: "thread.removed", location: "active", threadId: "old", sequence: 2 });
  await until(() => resolveRead !== undefined, "settled count read");
  expect(calls).toEqual([{ before: { settledAt: before }, limit: 0 }]);
  applyShellEventForTest(snapshot(3, 7));
  resolveRead!({ snapshotSequence: 2, threads: [], counts: [{ projectId: "p1", count: 4 }] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(st.unloadedOlderSettledCount()).toBe(7);
  st.setRequestBackendForTest(async () => ({ snapshotSequence: 4, threads: [], counts: [{ projectId: "p1", count: 6 }] }));
  applyShellEventForTest({ kind: "thread.removed", location: "active", threadId: "other", sequence: 4 });
  await until(() => st.unloadedOlderSettledCount() === 6, "refreshed settled count");
  setBackendStatusForTest("disconnected");
});
