import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { applyConfigEventForTest, onServerConfigEvent, setBackendStatusForTest } from "./store";
import { useWorktreeSetupSnapshot } from "./components/thread/timeline/worktreeSetup";

// One config stream: readers listen on the store's subscribeServerConfig instead of opening their own.
test("config stream listeners get every event the store's own config stream receives, until they stop", () => {
  const seen: unknown[] = [];
  const stop = onServerConfigEvent((event) => seen.push(event.type));
  applyConfigEventForTest({ type: "snapshot", config: {} });
  applyConfigEventForTest({ type: "keybindingsUpdated", payload: {} });
  stop();
  applyConfigEventForTest({ type: "snapshot", config: {} });
  expect(seen).toEqual(["snapshot", "keybindingsUpdated"]);
});

// A reconnect closes every stream on the old socket; a live subscription must be made again on the new one.
test("the worktree setup stream subscribes again after a reconnect", () => {
  setBackendStatusForTest("connected");
  let subscribed = 0;
  let stopped = 0;
  const thread = signal<string | null>("t1");
  useWorktreeSetupSnapshot(thread, () => true, () => { subscribed += 1; return () => { stopped += 1; }; });
  expect(subscribed).toBe(1);
  setBackendStatusForTest("connecting");
  setBackendStatusForTest("connected");
  expect(subscribed).toBe(3);
  expect(stopped).toBe(2);
  setBackendStatusForTest("disconnected");
});

// shell.ts: a reconnect resumes the shell stream after the last applied sequence instead of asking for a new snapshot.
test("the shell resumes from its cursor on reconnect to the same environment", async () => {
  const { applyShellEventForTest, shellSubscribeInput } = await import("./store");
  setBackendStatusForTest("connected", "ws://shell.test/ws");
  // shell.ts canResumeFrom reads the server identity from the session's config; held rows resume with httpSnapshotFallback.
  applyConfigEventForTest({ type: "snapshot", config: { environment: { environmentId: "e", label: "L", serverVersion: "1", databaseMigration: 1 } } });
  applyShellEventForTest({ kind: "snapshot-required" });
  expect(shellSubscribeInput("ws://shell.test/ws")).toEqual({ requestCompletionMarker: true });
  applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 40, projects: [], threads: [] } });
  applyShellEventForTest({ kind: "project.removed", sequence: 42, projectId: "p-gone" });
  expect(shellSubscribeInput("ws://shell.test/ws")).toEqual({ afterSequence: 42, httpSnapshotFallback: true, requestCompletionMarker: true });
  expect(shellSubscribeInput("ws://other.test/ws")).toEqual({ requestCompletionMarker: true });
  setBackendStatusForTest("disconnected");
});

// The web reads server.getConfig once per session: every reader shares one request per connection, and a config
// snapshot from the stream answers the next readers without a request.
test("server.getConfig is one shared request per connection", async () => {
  const { requestBackend, setFakeClientForTest } = await import("./store");
  const fake = setFakeClientForTest();
  setBackendStatusForTest("connected");
  await Promise.all([requestBackend("server.getConfig", {}), requestBackend("server.getConfig", {}), requestBackend("server.getConfig", {})]);
  expect(fake.requestMethods()).toEqual(["server.getConfig"]);
  applyConfigEventForTest({ type: "snapshot", config: { marker: 1 } });
  expect(await requestBackend("server.getConfig", {})).toEqual({ marker: 1 });
  applyConfigEventForTest({ type: "settingsUpdated", payload: {} });
  await requestBackend("server.getConfig", {});
  expect(fake.requestMethods()).toEqual(["server.getConfig", "server.getConfig"]);
  setBackendStatusForTest("disconnected");
});

// operations/commands.ts persistAttachments: images held as files go up as data URLs in one assets.persistChatAttachments.
test("inline image attachments are persisted with assets.persistChatAttachments at send", async () => {
  const { persistInlineAttachments } = await import("./store");
  const calls: { method: string; payload: any }[] = [];
  const file = { arrayBuffer: async () => new Uint8Array([104, 105]).buffer } as unknown as File;
  const result = await persistInlineAttachments("thread-1", "message:1", [
    { id: "a", name: "kept.png", mimeType: "image/png", sizeBytes: 3, kind: "image", status: "uploaded", uploadedId: "stored-0" },
    { id: "b", name: "new.png", mimeType: "image/png", sizeBytes: 2, kind: "image", status: "ready", file },
  ] as never, async (method, payload) => { calls.push({ method, payload }); return { attachments: [{ type: "image", id: "stored-1", name: "new.png", mimeType: "image/png", sizeBytes: 2 }] }; });
  expect(calls.map((call) => call.method)).toEqual(["assets.persistChatAttachments"]);
  expect(calls[0]!.payload).toEqual({ threadId: "thread-1", messageId: "message:1", attachments: [{ type: "image", id: "b", name: "new.png", mimeType: "image/png", sizeBytes: 2, dataUrl: "data:image/png;base64,aGk=" }] });
  expect(result.map((item) => item.id)).toEqual(["stored-0", "stored-1"]);
});

// connection/supervisor.ts: coming back to the app probes the socket with server.probe; no answer replaces it.
test("server.probe: an answer keeps the socket, a timeout abandons it so the store reconnects", async () => {
  const { probeConnection } = await import("./store");
  const { RequestFailure } = await import("./backend/client");
  setBackendStatusForTest("connected");
  const make = (outcome: () => Promise<unknown>) => {
    const record = { methods: [] as string[], abandoned: 0 };
    const client = { request: (method: string) => { record.methods.push(method); return outcome(); }, abandon: () => { record.abandoned += 1; } };
    return { record, client: client as never };
  };
  const alive = make(async () => ({}));
  expect(await probeConnection(alive.client)).toBe("alive");
  expect(alive.record.methods).toEqual(["server.probe"]);
  const refused = make(async () => { throw new RequestFailure("denied", "EnvironmentAuthorizationError"); });
  expect(await probeConnection(refused.client)).toBe("alive");
  const silent = make(async () => { throw new Error("Request timed out."); });
  expect(await probeConnection(silent.client)).toBe("replaced");
  expect(silent.record.abandoned).toBe(1);
  setBackendStatusForTest("disconnected");
});
