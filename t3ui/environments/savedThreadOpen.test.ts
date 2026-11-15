import { expect, test } from "nsh/test";
import type { SocketConnection } from "../backend/client";
import { openThreadById, refreshMergedShell, setBoundedThreadFetchForTests } from "../store";
import { savedEnvironmentStatus } from "../pages/settings/environments/savedEnvironments";
import { projectEnvironmentDescription } from "./EnvironmentBadges";
import { remoteShell, resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } from "./connectionManager";

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
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

const thread = (id: string, projectId: string) => ({ id, projectId, title: id, status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

test("a saved environment's thread opens like the primary's: bounded flags, then the bounded HTTP path on a failed cold open", async () => {
  const socket = new FakeSocket();
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: async () => socket });
  const fetched: string[] = [];
  setBoundedThreadFetchForTests(async (input) => { fetched.push(String(input)); return new Response(JSON.stringify({ _tag: "EnvironmentResourceNotFoundError" }), { status: 404 }); }, { url: "ws://box/ws", bearer: "b" });
  syncEnvironments([{ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true }]);
  await until(() => socket.requests("subscribeServerConfig").length > 0);
  socket.frame({ _tag: "Chunk", requestId: socket.requests("subscribeServerConfig")[0].id, values: [{ type: "snapshot", config: { threadSnapshotPagination: true, environment: { label: "box", serverVersion: "1" } } }] });
  await until(() => socket.requests("orchestration.subscribeShell").length > 0);
  socket.frame({ _tag: "Chunk", requestId: socket.requests("orchestration.subscribeShell")[0].id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "Remote" }], threads: [thread("a", "p")] } }] });
  await until(() => remoteShell("saved:box")?.loaded === true);
  refreshMergedShell();

  openThreadById("saved:box:a");
  await until(() => socket.requests("orchestration.subscribeThread").length > 0);
  const open = socket.requests("orchestration.subscribeThread")[0];
  expect(open.payload.threadId).toBe("a");
  expect(open.payload.acceptBoundedSnapshot).toBe(true);
  expect(open.payload.acceptCompactTurnItems).toBe(true);
  expect(open.payload.acceptDedupedBodies).toBe(true);

  socket.frame({ _tag: "Exit", requestId: open.id, exit: { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "SomeError", message: "boom" } } } });
  await until(() => fetched.length > 0);
  expect(fetched[0].startsWith("http://box/api/orchestration/threads/a/bounded?")).toBe(true);

  setBoundedThreadFetchForTests(null);
  syncEnvironments([]);
  resetEnvironmentsForTest();
});
