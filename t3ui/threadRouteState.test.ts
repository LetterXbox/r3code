// threadRoutes.ts resolveThreadRouteRenderState: a selected thread is "loading" until the shell snapshot arrives, and a
// thread removed while it is open leaves its view.
import { expect, test } from "nsh/test";
import { applyConfigEventForTest, applyShellEventForTest, openThread, openThreadById, openThreadRouteState, setBackendStatusForTest } from "./store";

test("the open thread is loading before the snapshot, ready after, and a removal while open leaves it", () => {
  setBackendStatusForTest("connected", "ws://route.test/ws");
  applyConfigEventForTest({ type: "snapshot", config: { environment: { environmentId: "e", label: "L", serverVersion: "1", databaseMigration: 1 } } });
  applyShellEventForTest({ kind: "snapshot-required" });
  openThreadById("t-1");
  expect(openThreadRouteState()).toBe("loading");
  const thread = (id: string) => ({ id, projectId: "p-1", title: id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p-1", title: "P", workspaceRoot: "/p" }], threads: [thread("t-1"), thread("t-2")] } });
  openThreadById("t-1");
  expect(openThreadRouteState()).toBe("ready");
  applyShellEventForTest({ kind: "thread.removed", sequence: 2, threadId: "t-1", location: "active" });
  expect(openThread()?.id).not.toBe("t-1");
  expect(openThreadRouteState()).not.toBe("loading");
  setBackendStatusForTest("disconnected");
});
