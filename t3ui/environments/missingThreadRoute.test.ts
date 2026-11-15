import { expect, test } from "nsh/test";
import { applyShellEventForTest, openThread, openThreadById } from "../store";
import { environmentHasAnyThreads, handleMissingThread } from "./missingThreadRoute";

const thread = (id: string) => ({ id, projectId: "p", title: id, status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

test("a missing thread goes home only when its environment lists other threads", () => {
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "P" }], threads: [] } });
  expect(environmentHasAnyThreads("gone")).toBe(false);
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "P" }], threads: [thread("a")] } });
  openThreadById("a");
  expect(openThread()?.id).toBe("a");
  expect(environmentHasAnyThreads("gone")).toBe(true);
  handleMissingThread("gone");
  expect(openThread()).toBe(undefined);
});

test("a saved environment's thread is checked on that environment: a 404 not-found says missing", async () => {
  const { probeRemoteThread } = await import("./missingThreadRoute");
  const { resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } = await import("./connectionManager");
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: () => new Promise(() => {}) });
  syncEnvironments([{ id: "saved:box", label: "box", url: "ws://box.test:4000/ws", enabled: true }]);
  const seen: string[] = [];
  const answer = (status: number, body: unknown) => (async (input: unknown) => { seen.push(String(input)); return { status, json: async () => body } as unknown as Response; }) as typeof fetch;
  expect(await probeRemoteThread("saved:box:t9", answer(404, { _tag: "EnvironmentResourceNotFoundError" }), async () => "bearer")).toBe("missing");
  expect(seen[0]?.startsWith("http://box.test:4000/api/orchestration/threads/t9/bounded?")).toBe(true);
  expect(await probeRemoteThread("saved:box:t9", answer(200, {}), async () => "bearer")).toBe("present");
  expect(await probeRemoteThread("t9", answer(404, {}), async () => "bearer")).toBe("unavailable");
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});
