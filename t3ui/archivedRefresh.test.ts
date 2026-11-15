import { expect, test } from "nsh/test";
import { applyShellEventForTest, archivedError, archivedThreads, refreshArchivedThreads, setRequestBackendForTest } from "./store";

test("a failed archived-thread load reads the reference's fixed copy, not the raw error", async () => {
  setRequestBackendForTest(async (method) => {
    expect(method).toBe("orchestration.getArchivedShellSnapshot");
    throw new Error("socket closed");
  });
  await refreshArchivedThreads();
  expect(archivedError()).toBe("Failed to load archived threads.");
  setRequestBackendForTest(async () => ({ threads: [] }));
  await refreshArchivedThreads();
  expect(archivedError()).toBe(null);
  setRequestBackendForTest(null);
});

test("archive changes arriving during a snapshot survive its stale response", async () => {
  const thread = (id: string) => ({ id, projectId: "p", title: id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  let resolve!: (value: unknown) => void;
  setRequestBackendForTest(() => new Promise((done) => { resolve = done; }));
  const loading = refreshArchivedThreads();
  applyShellEventForTest({ kind: "thread.updated", location: "active", thread: thread("restored") });
  applyShellEventForTest({ kind: "thread.removed", location: "archive", threadId: "deleted" });
  applyShellEventForTest({ kind: "thread.removed", location: "active", threadId: "archived-only" });
  applyShellEventForTest({ kind: "thread.updated", location: "archive", thread: thread("new") });
  resolve({ threads: [thread("restored"), thread("deleted"), thread("old"), thread("archived-only")] });
  await loading;
  expect(archivedThreads().map((item) => item.id)).toEqual(["old", "archived-only", "new"]);
  setRequestBackendForTest(null);
});
