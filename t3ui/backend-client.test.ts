import { expect, test } from "nsh/test";
import { BackendClient, RequestFailure, stringifiedFailure, type HeartbeatClock, type SocketConnection } from "./backend/client";

class FakeSocket implements SocketConnection {
  sent: string[] = [];
  private incoming: (string | Uint8Array | null)[] = [];
  private reader: ((value: string | Uint8Array | null) => void) | null = null;
  async write(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  read(): Promise<string | Uint8Array | null> {
    if (this.incoming.length) return Promise.resolve(this.incoming.shift() ?? null);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async close() { this.push(null); }
  push(value: string | Uint8Array | null) {
    const reader = this.reader;
    this.reader = null;
    if (reader) reader(value);
    else this.incoming.push(value);
  }
  frame(value: unknown) { this.push(JSON.stringify(value)); }
}

class FakeHeartbeatClock implements HeartbeatClock {
  time = 0;
  callback: (() => void) | null = null;
  now() { return this.time; }
  setInterval(callback: () => void) { this.callback = callback; return 1; }
  clearInterval() { this.callback = null; }
  tick(time: number) { this.time = time; this.callback?.(); }
}

test("split socket frames join before the message is read", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  const pending = client.request("joined", {});
  const whole = JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: "joined-result" } });
  socket.push(`\u001e${whole.slice(0, 20)}`);
  socket.push(whole.slice(20));
  expect(await pending).toBe("joined-result");
  client.close();
});

test("a held-back frame part keeps the socket alive", async () => {
  const socket = new FakeSocket();
  const clock = new FakeHeartbeatClock();
  let closed = "";
  const client = new BackendClient((error) => { closed = error.message; }, async () => socket, clock);
  await client.connect("ws://test");
  clock.tick(5000);
  socket.push("\u001e{\"partial\":");
  await Promise.resolve();
  await Promise.resolve();
  clock.tick(10000);
  clock.tick(15000);
  clock.tick(20000);
  expect(closed).toBe("");
  client.close();
});

test("RPC replies resolve the corresponding request even when responses arrive out of order", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  const first = client.request("first", {});
  const second = client.request("second", {});
  socket.frame({ _tag: "Exit", requestId: "2", exit: { _tag: "Success", value: "second-result" } });
  socket.frame({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: "first-result" } });
  expect(await first).toBe("first-result");
  expect(await second).toBe("second-result");
  client.close();
});

test("stream chunks are acknowledged and unsubscribe interrupts only that subscription", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  let received = "";
  const dispose = client.subscribe("stream", {}, (value) => { received = String(value); }, () => {});
  socket.frame({ _tag: "Chunk", requestId: "1", values: ["hello"] });
  // Frames are written one at a time, so the Ack follows the request's write.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toBe("hello");
  expect(socket.sent.some((text) => text.includes('"_tag":"Ack"'))).toBe(true);
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(socket.sent.some((text) => text.includes('"_tag":"Interrupt"'))).toBe(true);
  client.close();
});

test("a closed socket rejects in-flight requests rather than reporting success", async () => {
  const socket = new FakeSocket();
  let closed = "";
  const client = new BackendClient((error) => { closed = error.message; }, async () => socket);
  await client.connect("ws://test");
  const request = client.request("pending", {});
  socket.push(null);
  let error = "";
  try { await request; } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  expect(error).toBe("The environment closed the connection");
  expect(closed).toBe("The environment closed the connection");
});

test("a request uses its configured timeout and reports an uncertain outcome", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  let error = "";
  try { await client.request("slow", {}, { timeoutMs: 1000 }); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  expect(error).toBe("Request timed out. Its outcome may be unknown; check the thread before retrying.");
  client.close();
});

test("a delayed first heartbeat sends a ping instead of disconnecting", async () => {
  const socket = new FakeSocket();
  const clock = new FakeHeartbeatClock();
  let closed = "";
  const client = new BackendClient((error) => { closed = error.message; }, async () => socket, clock);
  await client.connect("ws://test");
  clock.tick(30000);
  expect(closed).toBe("");
  expect(socket.sent.some((value) => value.includes('"_tag":"Ping"'))).toBe(true);
  client.close();
});

test("a stalled local event loop gets a fresh ping before a quiet socket times out", async () => {
  const socket = new FakeSocket();
  const clock = new FakeHeartbeatClock();
  let closed = "";
  const client = new BackendClient((error) => { closed = error.message; }, async () => socket, clock);
  await client.connect("ws://test");
  const pending = client.request("pending", {}).catch((error: Error) => error.message);
  clock.tick(5000);
  clock.tick(30000);
  expect(closed).toBe("");
  clock.tick(35000);
  clock.tick(40000);
  clock.tick(45000);
  expect(closed).toBe("");
  clock.tick(50000);
  expect(closed).toBe("Environment stopped responding");
  expect(await pending).toBe("Environment stopped responding");
});

test("any received frame resets heartbeat liveness", async () => {
  const socket = new FakeSocket();
  const clock = new FakeHeartbeatClock();
  let closed = "";
  const client = new BackendClient((error) => { closed = error.message; }, async () => socket, clock);
  await client.connect("ws://test");
  clock.tick(5000);
  clock.tick(10000);
  socket.frame({ _tag: "Pong" });
  await Promise.resolve();
  await Promise.resolve();
  clock.tick(15000);
  clock.tick(20000);
  clock.tick(25000);
  expect(closed).toBe("");
  clock.tick(30000);
  expect(closed).toBe("Environment stopped responding");
});

test("a burst of requests never overlaps writes on the host socket", async () => {
  // The host rejects a write issued while others are outstanding.
  class OneAtATimeSocket extends FakeSocket {
    private busy = false;
    async write(data: string | Uint8Array) {
      if (this.busy) throw new Error("WebSocket command queue is full; wait for an outstanding operation");
      this.busy = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      this.busy = false;
      await super.write(data);
    }
  }
  const socket = new OneAtATimeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  const calls = Array.from({ length: 40 }, (_, index) => client.request(`method-${index}`, {}));
  const settled = Promise.allSettled(calls);
  // Wait for the queue to drain rather than a fixed time: timers run slowly on a loaded machine.
  for (let waited = 0; socket.sent.length < 40 && waited < 5000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(socket.sent.length).toBe(40);
  expect(socket.sent.map((frame) => JSON.parse(frame).tag)).toEqual(Array.from({ length: 40 }, (_, index) => `method-${index}`));
  for (let index = 1; index <= 40; index++) socket.frame({ _tag: "Exit", requestId: String(index), exit: { _tag: "Success", value: index } });
  expect((await settled).every((result) => result.status === "fulfilled")).toBe(true);
  client.close();
});

test("failed RPCs rebuild the text of contract errors whose message is computed from fields", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  const fail = (id: string, error: unknown) => socket.frame({ _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] } });
  const outcome = (promise: Promise<unknown>) => promise.then(() => "", (error: { message: string; tag: string | null }) => `${error.tag}|${error.message}`);
  const boot = outcome(client.request("device.open", {}));
  const host = outcome(client.request("device.list", {}));
  const eas = outcome(client.request("device.easAccount", {}));
  const setup = outcome(client.request("provider.auth.start", {}));
  const usage = outcome(client.request("provider.consumeResetCredit", {}));
  fail("1", { _tag: "DeviceBootError", hostId: "local", deviceId: "sim-1", reason: "timeout" });
  fail("2", { _tag: "DeviceHostUnavailableError", hostId: "ssh-1", hostLabel: "Mac mini", reason: "connection refused" });
  fail("3", { _tag: "DeviceEasAccountError", reason: "Expo rejected the token." });
  fail("4", { _tag: "ProviderSetupError", instanceId: "codex", operation: "start", detail: "Codex is not installed." });
  fail("5", { _tag: "UsageLimitSourceError", detail: "Source unavailable." });
  expect(await boot).toBe("DeviceBootError|Device sim-1 failed to boot: The device did not become ready in time. The device host sent no details. Try again or open another device; if it keeps failing, check the device on that host.");
  expect(await host).toBe("DeviceHostUnavailableError|Mac mini is unavailable: connection refused");
  expect(await eas).toBe("DeviceEasAccountError|Expo rejected the token.");
  expect(await setup).toBe("ProviderSetupError|Codex is not installed.");
  expect(await usage).toBe("UsageLimitSourceError|Source unavailable.");
  client.close();
});

test("contract errors with computed messages cover secret, link and MCP app requests", async () => {
  const { contractErrorMessage } = await import("./backend/client");
  expect(contractErrorMessage({ _tag: "SecretRequestError", reason: "already_answered" })).toBe("This secret request was already answered.");
  expect(contractErrorMessage({ _tag: "SecretRequestError", reason: "reference_unreadable", provider: "1password" })).toBe('Could not read the secret from the secret provider "1password". Unlock it and try again, or enter the value.');
  expect(contractErrorMessage({ _tag: "PeerLinkRequestError", reason: "not_found" })).toBe("This link request no longer exists.");
  expect(contractErrorMessage({ _tag: "McpAppRequestError", threadId: "t", reason: "session-stopped" })).toBe("The app's thread is not running. Send a message in the thread that created it to use the app again.");
  expect(contractErrorMessage({ _tag: "DeviceOperationError", operation: "tap", reason: "command_failed", exitCode: 2 })).toBe("Device tap failed: The device command failed (exit code 2).");
  expect(contractErrorMessage({ _tag: "ScheduledTaskError", message: "x" })).toBe(null);
});

test("stringifiedFailure is the reference's String(squashed error): the contract tag then its message", () => {
  expect(stringifiedFailure(new RequestFailure("Could not reach the machine.", "PeerLinkError"))).toBe("PeerLinkError: Could not reach the machine.");
  expect(stringifiedFailure(new RequestFailure("Request timed out", null))).toBe("Request timed out");
  expect(stringifiedFailure(new Error("Connect an environment first"))).toBe("Connect an environment first");
});

// rpc/client.ts has no RPC timeout: a request waits for its answer; only a caller's own deadline ends (and interrupts) it.
test("requests have no default timeout; an explicit deadline rejects and interrupts the request", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  let settled = false;
  const open = client.request("slow", {}).then(() => { settled = true; }, () => { settled = true; });
  const bounded = client.request("probe", {}, { timeoutMs: 1000 });
  let error = "";
  await bounded.catch((cause: Error) => { error = cause.message; });
  expect(error.startsWith("Request timed out")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(socket.sent.some((text) => text.includes('"_tag":"Interrupt"') && text.includes('"requestId":"2"'))).toBe(true);
  expect(settled).toBe(false);
  socket.frame({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: 1 } });
  await open;
  expect(settled).toBe(true);
  client.close();
});

test("Die defect payloads unwrap defect.message instead of falling back to Request failed", async () => {
  const socket = new FakeSocket();
  const client = new BackendClient(() => {}, async () => socket);
  await client.connect("ws://test");
  const pending = client.request("server.getResourceTelemetryHistory", {}).catch((e: Error) => e.message);
  socket.frame({
    _tag: "Exit",
    requestId: "1",
    exit: {
      _tag: "Failure",
      cause: {
        _tag: "Die",
        defect: { name: "Error", message: "RPC method is not implemented" },
      },
    },
  });
  expect(await pending).toBe("RPC method is not implemented");
  client.close();
});
