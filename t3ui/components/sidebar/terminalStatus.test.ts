import { expect, test } from "nsh/test";
import { applyTerminalMetadata, runningTerminalIds, selectRunningTerminalIds, serverTerminalIds, serverTerminalSessionsKnown, startTerminalStatus, terminalLabel } from "./terminalStatus";
import { forgetTerminalSession, noteTerminalSession } from "../terminal/terminalSessionInfo";
import { pullRequestBadgeFromShell } from "./threadMeta";
import { environmentConnections, resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } from "../../environments/connectionManager";
import type { SocketConnection } from "../../backend/client";

const summary = (threadId: string, terminalId: string, running = true) => ({
  threadId, terminalId, status: running ? "running" : "exited", hasRunningSubprocess: running,
});

test("a snapshot replaces the list and only running terminals with a subprocess count", () => {
  const next = applyTerminalMetadata([], { type: "snapshot", terminals: [summary("a", "t1"), summary("a", "t2", false)] });
  expect(next.map((item) => [item.terminalId, item.running])).toEqual([["t1", true], ["t2", false]]);
});

test("an upsert replaces the same terminal and a remove drops it", () => {
  const first = applyTerminalMetadata([], { type: "snapshot", terminals: [summary("a", "t1")] });
  const updated = applyTerminalMetadata(first, { type: "upsert", terminal: summary("a", "t1", false) });
  expect(updated.length).toBe(1);
  expect(updated[0].running).toBe(false);
  const added = applyTerminalMetadata(updated, { type: "upsert", terminal: summary("b", "t9") });
  expect(added.length).toBe(2);
  expect(applyTerminalMetadata(added, { type: "remove", threadId: "a", terminalId: "t1" }).map((item) => item.threadId)).toEqual(["b"]);
});

test("running terminals use the reference's numeric order regardless of event order", () => {
  const snapshot = applyTerminalMetadata([], { type: "snapshot", terminals: [summary("a", "Terminal 10"), summary("a", "Terminal 2"), summary("a", "Terminal 1"), summary("b", "Terminal 0")] });
  expect(selectRunningTerminalIds(snapshot, "a")).toEqual(["Terminal 1", "Terminal 2", "Terminal 10"]);
});

test("a malformed event leaves the list alone", () => {
  const first = applyTerminalMetadata([], { type: "snapshot", terminals: [summary("a", "t1")] });
  expect(applyTerminalMetadata(first, null).length).toBe(1);
  expect(applyTerminalMetadata(first, { type: "upsert", terminal: { threadId: 3 } }).length).toBe(1);
});

test("the badge takes the current pull request link (the open one) and its state", () => {
  const link = (number: number, linkedAt: string, extra: Record<string, unknown> = {}) =>
    ({ number, url: `https://x/pull/${number}`, linkedAt, source: "manual", snapshot: { state: "open", isDraft: false }, ...extra });
  // resolveThreadCurrentPullRequestLink: with one open link that one is current, however new the others are.
  expect(pullRequestBadgeFromShell({ pullRequests: [link(1, "2026-01-01T00:00:00Z"), link(2, "2026-02-01T00:00:00Z", { snapshot: { state: "merged", isDraft: false } })] })?.number).toBe(1);
  // With none open and no chain between them, the most recently updated link is current.
  expect(pullRequestBadgeFromShell({ pullRequests: [link(1, "2026-01-01T00:00:00Z", { snapshot: { state: "closed", isDraft: false } }), link(2, "2026-02-01T00:00:00Z", { snapshot: { state: "merged", isDraft: false } })] }))
    .toMatchObject({ number: 2, url: "https://x/pull/2", state: "merged" });
  expect(pullRequestBadgeFromShell({ pullRequests: [link(3, "2026-01-01T00:00:00Z", { snapshot: { state: "open", isDraft: true } })] })?.state).toBe("draft");
  expect(pullRequestBadgeFromShell({ pullRequests: [link(4, "2026-03-01T00:00:00Z", { source: "stack-dismissed" })] })).toBe(null);
});

test("without links the badge falls back to the linked or branch pull request", () => {
  expect(pullRequestBadgeFromShell({ linkedPullRequest: { number: 7, url: "https://x/pull/7" } })).toEqual({ number: 7, url: "https://x/pull/7", state: "open" });
  expect(pullRequestBadgeFromShell({ branchPullRequest: { number: 8, url: "https://x/pull/8" } })?.number).toBe(8);
  expect(pullRequestBadgeFromShell({})).toBe(null);
});

test("a removed or stopped terminal does not retain a running badge from attached activity", () => {
  noteTerminalSession("thread-x", "term-1", { hasRunningSubprocess: true });
  expect(runningTerminalIds("thread-x")).toEqual([]);
  const active = applyTerminalMetadata([], { type: "snapshot", terminals: [summary("thread-x", "term-1")] });
  expect(selectRunningTerminalIds(active, "thread-x")).toEqual(["term-1"]);
  expect(terminalLabel(selectRunningTerminalIds(active, "thread-x").length)).toBe("1 terminal process running. Open terminal");
  const removed = applyTerminalMetadata(active, { type: "remove", threadId: "thread-x", terminalId: "term-1" });
  expect(selectRunningTerminalIds(removed, "thread-x")).toEqual([]);
  const stopped = applyTerminalMetadata(active, { type: "upsert", terminal: summary("thread-x", "term-1", false) });
  expect(selectRunningTerminalIds(stopped, "thread-x")).toEqual([]);
  forgetTerminalSession("thread-x", "term-1");
});

test("linked environments keep terminal metadata scoped to their own threads", async () => {
  class Socket implements SocketConnection {
    sent: string[] = [];
    incoming: (string | null)[] = [];
    reader: ((value: string | null) => void) | null = null;
    async write(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
    read(): Promise<string | Uint8Array | null> { return this.incoming.length ? Promise.resolve(this.incoming.shift() ?? null) : new Promise((resolve) => { this.reader = resolve; }); }
    async close() { this.push(null); }
    push(value: string | null) { const reader = this.reader; this.reader = null; if (reader) reader(value); else this.incoming.push(value); }
  }
  const socket = new Socket();
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); expect(check()).toBe(true); };
  setEnvironmentTransportForTest({ ticket: async (url) => `${url}?ticket=t`, open: async () => socket });
  try {
    startTerminalStatus();
    syncEnvironments([{ id: "saved:remote", label: "Remote", url: "ws://remote/ws", enabled: true }]);
    await until(() => environmentConnections()["saved:remote"]?.phase === "connected");
    await until(() => socket.sent.some((message) => message.includes("subscribeTerminalMetadata")));
    const request = JSON.parse(socket.sent.find((message) => message.includes("subscribeTerminalMetadata"))!);
    socket.push(JSON.stringify({ _tag: "Chunk", requestId: String(request.id), values: [{ type: "snapshot", terminals: [summary("thread", "term-2"), summary("other", "term-1")] }] }));
    await until(() => serverTerminalSessionsKnown("saved:remote:thread"));
    expect(runningTerminalIds("saved:remote:thread")).toEqual(["term-2"]);
    expect(serverTerminalIds("saved:remote:thread")).toEqual(["term-2"]);
    expect(runningTerminalIds("thread")).toEqual([]);
    syncEnvironments([{ id: "saved:remote", label: "Remote", url: "ws://remote/ws", enabled: true }, { id: "saved:offline", label: "Offline", url: "ws://offline/ws", enabled: false }]);
    expect(serverTerminalSessionsKnown("saved:remote:thread")).toBe(true);
    expect(runningTerminalIds("saved:remote:thread")).toEqual(["term-2"]);
    expect(socket.sent.filter((message) => message.includes("subscribeTerminalMetadata")).length).toBe(1);
    syncEnvironments([]);
    expect(runningTerminalIds("saved:remote:thread")).toEqual([]);
  } finally {
    resetEnvironmentsForTest();
    setEnvironmentTransportForTest(null);
  }
});
