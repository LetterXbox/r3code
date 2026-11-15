import { expect, test } from "nsh/test";
import { ProviderSetupClient, isSafeProviderAuthUrl, parseProviderAuthState, type ProviderSetupTransport } from "./backend/providerSetup";

class FakeSetupTransport implements ProviderSetupTransport {
  revision = 1;
  calls: { method: string; input: unknown }[] = [];
  handler: (method: string, input: unknown) => Promise<unknown> = async () => authState();
  receive: ((value: unknown) => void) | null = null;
  fail: ((error: Error) => void) | null = null;
  unsubscribed = false;
  generation() { return this.revision; }
  request(method: string, input: unknown) { this.calls.push({ method, input }); return this.handler(method, input); }
  subscribe(method: string, input: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) {
    this.calls.push({ method, input }); this.receive = onValue; this.fail = onError;
    return () => { this.unsubscribed = true; };
  }
}

function authState(interaction: unknown = null) {
  return { instanceId: "codex", phase: "waiting", flowId: "flow-1", authorizationUrl: null,
    expiresAt: null, message: null, methods: [], interaction };
}
function installState(phase = "downloading") {
  return { driver: "codex", operationId: "install-1", phase, downloadedBytes: 40, totalBytes: 100,
    version: "1", installedVersion: null, canRemove: false, message: null };
}

test("provider setup preserves interactive auth details and correlates responses", async () => {
  const transport = new FakeSetupTransport();
  const client = new ProviderSetupClient(transport);
  const interaction = { type: "browser", id: "interaction-1", url: "https://login.example/authorize", requiresConsent: true, acceptsCallback: true };
  transport.handler = async () => authState(interaction);
  const started = await client.startAuth("codex", { methodId: "browser" });
  expect(started.phase).toBe("waiting");
  expect(started.interaction).toEqual(interaction);
  await client.respondAuth("codex", "flow-1", "interaction-1", { type: "browser", action: "accept" });
  expect(transport.calls).toEqual([
    { method: "provider.auth.start", input: { instanceId: "codex", methodId: "browser" } },
    { method: "provider.auth.respond", input: { instanceId: "codex", flowId: "flow-1", interactionId: "interaction-1", response: { type: "browser", action: "accept" } } },
  ]);
  expect(isSafeProviderAuthUrl("https://login.example/authorize")).toBe(true);
  expect(isSafeProviderAuthUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeProviderAuthUrl("https://secret@login.example/")).toBe(false);
  expect(isSafeProviderAuthUrl("http://login.example/authorize")).toBe(false);
  expect(isSafeProviderAuthUrl("http://127.0.0.1:1234/callback")).toBe(true);
});

test("unknown auth interactions stay unsupported and partial credentials are not offered", () => {
  expect(parseProviderAuthState(authState({ type: "future", id: "i" }), "codex").interaction).toEqual({ type: "unsupported" });
  expect(parseProviderAuthState(authState({ type: "credentials", id: "i", fields: [
    { name: "key", label: "Key", secret: true }, { name: "bad", label: "Bad" },
  ] }), "codex").interaction).toEqual({ type: "unsupported" });
  expect(parseProviderAuthState(authState({ type: "deviceCode", id: "i", url: "https://login.example", userCode: "ABCD" }), "codex").interaction)
    .toEqual({ type: "deviceCode", id: "i", url: "https://login.example", userCode: "ABCD" });
  expect(parseProviderAuthState(authState({ type: "terminal", id: "i", output: "Enter code:", outputOffset: 7 }), "codex").interaction)
    .toEqual({ type: "terminal", id: "i", output: "Enter code:", outputOffset: 7 });
});

test("install starts and cancels the reported operation without claiming completion", async () => {
  const transport = new FakeSetupTransport();
  const client = new ProviderSetupClient(transport);
  transport.handler = async () => installState();
  const started = await client.startInstall("codex");
  expect(started.phase).toBe("downloading");
  expect(started.downloadedBytes).toBe(40);
  await client.cancelInstall("codex", "install-1");
  expect(transport.calls).toEqual([
    { method: "provider.install.start", input: { instanceId: "codex" } },
    { method: "provider.install.cancel", input: { instanceId: "codex", operationId: "install-1" } },
  ]);
});

test("setup does not expose secrets from request failures or stale environments", async () => {
  const transport = new FakeSetupTransport();
  const client = new ProviderSetupClient(transport);
  transport.handler = async () => { throw new Error("callback token=private-value"); };
  let message = "";
  try { await client.completeAuth("codex", "flow-1", "http://localhost/callback?code=private-value"); }
  catch (error) { message = error instanceof Error ? error.message : ""; }
  expect(message).toBe("Provider authentication failed. Try again.");
  let resolve: (value: unknown) => void = () => {};
  transport.handler = () => new Promise((done) => { resolve = done; });
  const pending = client.startAuth("codex").catch((error: Error) => error.message);
  transport.revision++;
  resolve(authState());
  expect(await pending).toBe("The environment changed during provider setup");
});

test("credential submissions retain their correlation and timeout reports an uncertain result", async () => {
  const transport = new FakeSetupTransport();
  const client = new ProviderSetupClient(transport);
  transport.handler = async () => authState({ type: "credentials", id: "credentials-1", fields: [{ name: "key", label: "API key", secret: true }] });
  const state = await client.respondAuth("codex", "flow-1", "credentials-1", { type: "credentials", values: { key: "private-value" } });
  expect(state.phase).toBe("waiting");
  expect(transport.calls[0].method).toBe("provider.auth.respond");
  transport.handler = async () => { throw new Error("Request timed out. Its outcome may be unknown; check the thread before retrying."); };
  const message = await client.startInstall("codex").then(() => "", (error: Error) => error.message);
  expect(message).toBe("Provider setup timed out. Check its current status before retrying.");
});

test("subscriptions reject malformed data and ignore stale or disposed events", () => {
  const transport = new FakeSetupTransport();
  const client = new ProviderSetupClient(transport);
  const phases: string[] = [];
  let failure = "";
  const dispose = client.subscribeAuth("codex", (state) => phases.push(state.phase), (error) => { failure = error.message; });
  const receive = transport.receive;
  receive?.(authState());
  expect(phases).toEqual(["waiting"]);
  receive?.({ ...authState(), instanceId: "another-provider" });
  expect(failure).toBe("The environment returned an invalid provider setup state");
  expect(transport.unsubscribed).toBe(true);
  receive?.(authState());
  expect(phases).toEqual(["waiting"]);
  dispose();
  transport.unsubscribed = false;
  client.subscribeInstall("codex", (state) => phases.push(state.phase), () => {});
  const stale = transport.receive;
  transport.revision++;
  stale?.(installState());
  expect(phases).toEqual(["waiting"]);
});

test("setup surfaces the safe ProviderSetupError detail but still hides other request failures", async () => {
  const { RequestFailure } = await import("./backend/client");
  const transport = new FakeSetupTransport();
  const client = new ProviderSetupClient(transport);
  transport.handler = async () => { throw new RequestFailure("Codex CLI is not installed.", "ProviderSetupError"); };
  expect(await client.startAuth("codex").then(() => "", (error: Error) => error.message)).toBe("Codex CLI is not installed.");
  transport.handler = async () => { throw new RequestFailure("Missing scope", "EnvironmentAuthorizationError"); };
  expect(await client.startInstall("codex").then(() => "", (error: Error) => error.message)).toBe("Missing scope");
  transport.handler = async () => { throw new RequestFailure("Request failed", "ProviderSetupError"); };
  expect(await client.startInstall("codex").then(() => "", (error: Error) => error.message)).toBe("Provider installation failed. Try again.");
  transport.handler = async () => { throw new RequestFailure("internal detail", "SomethingElse"); };
  expect(await client.startAuth("codex").then(() => "", (error: Error) => error.message)).toBe("Provider authentication failed. Try again.");
});

test("a failed setup stream shows the stream's own error, else the generic environment message", () => {
  for (const [cause, expected] of [[new Error("Codex CLI is not installed"), "Codex CLI is not installed"], [new Error(""), "The environment request failed."]] as const) {
    const transport = new FakeSetupTransport();
    let failure = "";
    new ProviderSetupClient(transport).subscribeInstall("codex", () => {}, (error) => { failure = error.message; });
    transport.fail?.(cause);
    expect(failure).toBe(expected);
  }
});
