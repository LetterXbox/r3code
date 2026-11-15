import { expect, test } from "nsh/test";
import { threadSyncLabel } from "./ThreadSyncLine";
import {
  applyConfigEventForTest, applyShellEventForTest, applyThreadEventForTest, markThreadSubscribingForTest, openThreadById, setBackendStatusForTest, setRequestBackendForTest, threadSyncPhase,
} from "../../../store";

const iso = () => new Date().toISOString();

test("the sync line copy is the reference's", () => {
  expect(threadSyncLabel("loading")).toBe("Loading messages...");
  expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
});

test("an open server thread is loading until its detail snapshot arrives", () => {
  setRequestBackendForTest(async () => ({}));
  setBackendStatusForTest("connected");
  applyConfigEventForTest({ type: "snapshot", config: { providers: [] } });
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-1", title: "p", workspaceRoot: "/w", createdAt: iso(), updatedAt: iso() }],
    threads: [{ id: "thread:sync", projectId: "project-1", title: "T", status: "idle", createdAt: iso(), updatedAt: iso() }],
  } });
  openThreadById("thread:sync");
  // Nothing is loading until a subscription for it is live.
  expect(threadSyncPhase()).toBe(null);
  markThreadSubscribingForTest("thread:sync");
  expect(threadSyncPhase()).toBe("loading");
  applyThreadEventForTest("thread:sync", { kind: "snapshot", projection: { messages: [], runs: [], turnItems: [] } });
  expect(threadSyncPhase()).toBe(null);
});

test("a resubscribe of the loaded thread (after a send) does not read as loading, and a failed subscription stops loading", () => {
  markThreadSubscribingForTest("thread:sync");
  expect(threadSyncPhase()).toBe(null);
  markThreadSubscribingForTest(null);
  expect(threadSyncPhase()).toBe(null);
});
