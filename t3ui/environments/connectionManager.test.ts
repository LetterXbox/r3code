import { expect, test } from "nsh/test";
import type { SocketConnection } from "../backend/client";
import { setRpcResultDecodingForTest } from "../backend/rpcConcurrency";
import {
  type EnvironmentShell, connectionStatusText, environmentConnections, foldShellEvent, parseScopedKey, remoteShell, requestEnvironment,
  resetEnvironmentsForTest, routePayload, scopedKey, scopeResult, scopeShellRecord, setEnvironmentTransportForTest, syncEnvironments,
} from "./connectionManager";

test("remote subagent notifications and records name the same scoped child thread", () => {
  const projection = {
    kind: "snapshot", projection: {
      subagents: [{ id: "agent", childThreadId: "child" }],
      turnItems: [{ id: "notice", threadId: "parent", type: "notification", source: { kind: "subagent", childThreadId: "child" } }],
    },
  };
  expect(scopeResult("saved:1", projection)).toEqual({
    kind: "snapshot", projection: {
      subagents: [{ id: "agent", childThreadId: "saved:1:child" }],
      turnItems: [{ id: "notice", threadId: "saved:1:parent", type: "notification", source: { kind: "subagent", childThreadId: "saved:1:child" } }],
    },
  });
});

test("shell record memoization keeps the environment in its identity", () => {
  const source = { id: "child", projectId: "project", lineage: { parentThreadId: "parent" } };
  const first = scopeShellRecord("saved:a", source);
  const second = scopeShellRecord("saved:b", source);
  expect(first.id).toBe("saved:a:child");
  expect(second.id).toBe("saved:b:child");
  expect((second.lineage as { parentThreadId: string }).parentThreadId).toBe("saved:b:parent");
  expect(scopeShellRecord("saved:a", source) === first).toBe(true);
});

test("array IDs route to their environment and reject cross-environment requests", () => {
  syncEnvironments([
    { id: "saved:a", label: "A", url: "ws://a/ws", enabled: false },
    { id: "saved:b", label: "B", url: "ws://b/ws", enabled: false },
  ]);
  expect(routePayload({ threadIds: ["saved:a:one", "saved:a:two"] })).toEqual({ environmentId: "saved:a", payload: { threadIds: ["one", "two"] } });
  let rejected = false;
  try { routePayload({ threadIds: ["saved:a:one", "saved:b:two"] }); } catch { rejected = true; }
  expect(rejected).toBe(true);
  resetEnvironmentsForTest();
});

test("stale or unloaded saved:<envId>:<localId> keys never fall through to the primary server", async () => {
  resetEnvironmentsForTest();
  const composite = "saved:183b12f0-92c5-46a4-b4a7-907f6e33df40:import:claudeAgent:a9617cca-b65e-4cc7-bceb-d1791f07638e";
  expect(parseScopedKey(composite)).toEqual({
    environmentId: "saved:183b12f0-92c5-46a4-b4a7-907f6e33df40",
    localId: "import:claudeAgent:a9617cca-b65e-4cc7-bceb-d1791f07638e",
  });
  const routed = routePayload({ threadId: composite });
  expect(routed).toEqual({
    environmentId: "saved:183b12f0-92c5-46a4-b4a7-907f6e33df40",
    payload: { threadId: "import:claudeAgent:a9617cca-b65e-4cc7-bceb-d1791f07638e" },
  });
  await expect(requestEnvironment(routed!.environmentId, "orchestration.getThreadProjection", routed!.payload)).rejects.toThrow(/Connect an environment first/);
});

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
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

test("connectionStatusText matches the reference copy", () => {
  expect(connectionStatusText({ phase: "reconnecting", error: "boom" })).toBe("Failed to connect. Reconnecting... Reason: boom");
  expect(connectionStatusText({ phase: "offline", error: null })).toBe("Offline");
  expect(connectionStatusText({ phase: "error", error: null })).toBe("Connection failed");
});

test("foldShellEvent replaces an updated thread in place and keeps order", () => {
  const shell: EnvironmentShell = { projects: [], threads: [], archived: [], loaded: false };
  foldShellEvent(shell, { kind: "snapshot", snapshot: { projects: [{ id: "p" }], threads: [{ id: "a" }, { id: "b" }] } });
  const before = shell.threads;
  foldShellEvent(shell, { kind: "thread.updated", location: "active", thread: { id: "a", title: "new" } });
  expect(shell.threads === before).toBe(true);
  expect(shell.threads.map((item) => item.id).join(",")).toBe("a,b");
  foldShellEvent(shell, { kind: "thread.updated", location: "archive", thread: { id: "b" } });
  expect(shell.threads.length).toBe(1);
  expect(shell.archived.length).toBe(1);
  expect(shell.loaded).toBe(true);
});

test("a saved environment gets its own session, shell and request routing", async () => {
  const socket = new FakeSocket();
  setEnvironmentTransportForTest({ ticket: async (url) => `${url}?wsTicket=t`, open: async () => socket });
  syncEnvironments([{ id: "saved:1", label: "box", url: "ws://box/ws", enabled: true }]);
  await until(() => environmentConnections()["saved:1"]?.phase === "connected");
  await until(() => socket.sent.some((text) => text.includes("subscribeServerConfig")));
  // rpc/session.ts: the config stream comes first (with the runtime flags); the shell follows its snapshot.
  expect(JSON.parse(socket.sent.find((text) => text.includes("subscribeServerConfig"))!).payload).toEqual({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true });
  socket.frame({ _tag: "Chunk", requestId: "1", values: [{ type: "snapshot", config: { environment: { label: "box", serverVersion: "1" } } }] });
  await until(() => socket.sent.some((text) => text.includes("orchestration.subscribeShell")));
  // No extra server.getConfig: the config stream's snapshot is the config.
  expect(socket.sent.some((text) => text.includes("server.getConfig"))).toBe(false);
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "P" }], threads: [{ id: "t1" }] } }] });
  await until(() => remoteShell("saved:1")?.loaded === true);
  expect(remoteShell("saved:1")?.threads[0].id).toBe("t1");
  const key = scopedKey("saved:1", "t1");
  expect(parseScopedKey(key)?.localId).toBe("t1");
  expect(parseScopedKey("t1")).toBe(null);
  // Routing only: the placeholder reply skips the contract decode (RPC_DECODE_ENFORCE_DEFAULT would reject "ok").
  setRpcResultDecodingForTest(false);
  const reply = requestEnvironment("saved:1", "server.getConfig", {});
  await until(() => socket.sent.some((text) => text.includes("server.getConfig")));
  socket.frame({ _tag: "Exit", requestId: String(JSON.parse([...socket.sent].reverse().find((text) => text.includes("server.getConfig")) ?? "{}").id), exit: { _tag: "Success", value: "ok" } });
  try { expect(await reply).toBe("ok"); } finally { setRpcResultDecodingForTest(true); }
  syncEnvironments([{ id: "saved:1", label: "box", url: "ws://box/ws", enabled: false }]);
  expect(environmentConnections()["saved:1"]?.phase).toBe("offline");
  syncEnvironments([]);
  expect(environmentConnections()["saved:1"]).toBe(undefined);
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});

test("a remote environment's cached config follows its config stream", async () => {
  const { foldConfigEvent } = await import("./connectionManager");
  const base = foldConfigEvent(null, { type: "snapshot", config: { settings: { sidebarAutoSettleAfterDays: 7 }, environment: { label: "Box" } } });
  expect(base).toEqual({ settings: { sidebarAutoSettleAfterDays: 7 }, environment: { label: "Box" } });
  expect(foldConfigEvent(base, { type: "settingsUpdated", payload: { settings: { sidebarAutoSettleAfterDays: 11 } } })).toEqual({ settings: { sidebarAutoSettleAfterDays: 11 }, environment: { label: "Box" } });
  expect(foldConfigEvent(null, { type: "settingsUpdated", payload: {} })).toBe(null);
  expect(foldConfigEvent(base, { type: "other" })).toBe(null);
});
