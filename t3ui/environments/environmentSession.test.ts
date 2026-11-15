import { expect, test } from "nsh/test";
import { BackendClient, type SocketConnection } from "../backend/client";
import { canResumeShellFrom, noteShellEvent, prepareShellInput, ReconnectLadder, retryDelayMs, runInConfigLane, shellIdentityOf, type ShellResumeState } from "./environmentSession";
import { environmentConnections, environmentGeneration, environmentUsageSources, remoteShell, resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } from "./connectionManager";

class FakeSocket implements SocketConnection {
  sent: string[] = [];
  private incoming: (string | null)[] = [];
  private reader: ((value: string | null) => void) | null = null;
  async write(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  read(): Promise<string | Uint8Array | null> {
    if (this.incoming.length) return Promise.resolve(this.incoming.shift() ?? null);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async close() { this.push(null); }
  push(value: string | null) { const r = this.reader; this.reader = null; if (r) r(value); else this.incoming.push(value); }
  frame(value: unknown) { this.push(JSON.stringify(value)); }
  requests(method: string) { return this.sent.map((text) => JSON.parse(text)).filter((frame) => frame.tag === method); }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

test("the reconnect ladder is supervisor.ts: jittered growth to 300 s, 250 ms after a lost session, reset after 30 s connected", () => {
  expect(retryDelayMs(0, 0)).toBe(1000);
  expect(retryDelayMs(0, 1)).toBe(2000);
  expect(retryDelayMs(20, 1)).toBe(300000);
  let now = 0;
  const ladder = new ReconnectLadder(() => now, () => 1);
  expect(ladder.nextDelay()).toBe(2000);
  expect(ladder.nextDelay()).toBe(4000);
  ladder.established();
  now += 5000;
  // Lost after 5 s: the ladder keeps counting (no 250 ms quick retry, it is not the first failure).
  expect(ladder.nextDelay()).toBe(8000);
  ladder.established();
  now += 30000;
  // Lost after 30 s connected: the ladder resets and the first loss retries after ~250 ms.
  expect(ladder.nextDelay()).toBe(250);
  expect(ladder.nextDelay()).toBe(4000);
});

test("shell input resumes from the cursor for the same origin, else loads the HTTP snapshot first", async () => {
  const identity = shellIdentityOf({ environment: { serverVersion: "1" }, shellThreadFamilies: true, shellOlderSettled: true });
  const state: ShellResumeState = { cursor: null, origin: null };
  let applied = 0;
  const first = await prepareShellInput(state, identity, async () => ({ snapshotSequence: 7, projects: [], threads: [] }), () => { applied++; return true; });
  expect(first).toEqual({ afterSequence: 7, omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  expect(applied).toBe(1);
  noteShellEvent(state, { kind: "snapshot", snapshot: { snapshotSequence: 7 } }, identity);
  noteShellEvent(state, { kind: "thread.updated", sequence: 9 }, identity);
  expect(canResumeShellFrom(state, identity)).toBe(true);
  expect(await prepareShellInput(state, identity, null, () => true)).toEqual({ afterSequence: 9, httpSnapshotFallback: true, omitIdleSubagents: true, omitOlderSettled: true, requestCompletionMarker: true });
  expect(canResumeShellFrom(state, shellIdentityOf({ environment: { serverVersion: "2" } }))).toBe(false);
});

test("config edits run one at a time per environment, in call order", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const a = runInConfigLane("env", () => new Promise<void>((resolve) => { release = () => { order.push("a"); resolve(); }; }));
  const b = runInConfigLane("env", async () => { order.push("b"); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(order).toEqual([]);
  release();
  await Promise.all([a, b]);
  expect(order).toEqual(["a", "b"]);
});

test("a stream that ends normally calls its end handler instead of failing", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => undefined, async () => socket);
  await client.connect("ws://x");
  let ended = false;
  let failed: Error | null = null;
  client.subscribe("s", {}, () => {}, (error) => { failed = error; }, () => { ended = true; });
  socket.frame({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } });
  await until(() => ended);
  expect(failed).toBe(null);
  client.close();
});

test("a socket that never opens fails after the open timeout", async () => {
  const client = new BackendClient(() => undefined, () => new Promise<SocketConnection>(() => {}));
  const started = Date.now();
  const outcome = await client.connect("ws://blackhole").then(() => "opened", (error: Error) => error.message);
  expect(outcome).toBe("Timed out opening the connection to the environment.");
  expect(Date.now() - started >= 14000).toBe(true);
});

test("a saved environment: a refused shell retries on the same socket, usage sources come from its config stream, and a reconnect resumes", async () => {
  const sockets: FakeSocket[] = [];
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: async () => { const next = new FakeSocket(); sockets.push(next); return next; } });
  syncEnvironments([{ id: "saved:r", label: "r", url: "ws://r/ws", enabled: true }]);
  await until(() => sockets[0]?.requests("subscribeServerConfig").length === 1);
  const socket = sockets[0];
  socket.frame({ _tag: "Chunk", requestId: "1", values: [{ type: "snapshot", config: { environment: { serverVersion: "1" }, shellThreadFamilies: true, usageLimitSources: [{ id: "hub" }] } }] });
  await until(() => socket.requests("orchestration.subscribeShell").length === 1);
  expect(environmentUsageSources()["saved:r"]).toEqual([{ id: "hub" }]);
  expect(socket.requests("orchestration.subscribeShell")[0].payload).toEqual({ omitIdleSubagents: true, requestCompletionMarker: true });
  // Refused: retried on the same socket after 250 ms, the session stays connected.
  socket.frame({ _tag: "Exit", requestId: "2", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "X", message: "busy" } }] } });
  await until(() => socket.requests("orchestration.subscribeShell").length === 2);
  expect(sockets.length).toBe(1);
  expect(environmentConnections()["saved:r"]?.phase).toBe("connected");
  const shellId = socket.requests("orchestration.subscribeShell")[1].id;
  socket.frame({ _tag: "Chunk", requestId: shellId, values: [{ kind: "snapshot", snapshot: { snapshotSequence: 4, projects: [], threads: [{ id: "t" }] } }, { kind: "thread.updated", sequence: 5, location: "active", thread: { id: "t" } }] });
  await until(() => remoteShell("saved:r")?.loaded === true);
  const firstGeneration = environmentGeneration("saved:r");
  // Session lost: the next socket's shell resumes after the cursor.
  socket.push(null);
  await until(() => sockets.length === 2 && sockets[1].requests("subscribeServerConfig").length === 1);
  expect(environmentGeneration("saved:r") === firstGeneration).toBe(false);
  sockets[1].frame({ _tag: "Chunk", requestId: "1", values: [{ type: "snapshot", config: { environment: { serverVersion: "1" }, shellThreadFamilies: true } }] });
  await until(() => sockets[1].requests("orchestration.subscribeShell").length === 1);
  expect(sockets[1].requests("orchestration.subscribeShell")[0].payload).toEqual({ afterSequence: 5, httpSnapshotFallback: true, omitIdleSubagents: true, requestCompletionMarker: true });
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});
