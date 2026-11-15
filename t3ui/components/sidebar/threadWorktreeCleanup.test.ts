import { expect, test } from "nsh/test";
import {
  archiveBlockedReason, formatWorktreePathForDisplay, orphanedWorktreePath, removeWorktreeAfterDelete, shouldAskToDeleteWorktree, THREAD_ACTION_ERRORS, worktreeDeleteQuestion,
} from "./threadWorktreeCleanup";

const threads = [
  { id: "a", path: "/repo/.worktrees/feature" },
  { id: "b", path: "/repo/.worktrees/feature/" },
  { id: "c", path: "/repo/.worktrees/other" },
  { id: "d" },
];

test("a worktree shared with another thread, with or without a trailing slash, is not orphaned", () => {
  expect(orphanedWorktreePath(threads, "a")).toBeNull();
  expect(orphanedWorktreePath(threads, "b")).toBeNull();
  expect(orphanedWorktreePath(threads, "c")).toBe("/repo/.worktrees/other");
  expect(orphanedWorktreePath(threads, "d")).toBeNull();
  expect(orphanedWorktreePath(threads, "missing")).toBeNull();
});

test("threads deleted together do not count as sharing", () => {
  expect(orphanedWorktreePath(threads, "a", new Set(["b"]))).toBe("/repo/.worktrees/feature");
});

test("the question names the worktree's folder and asks Delete the worktree too?", () => {
  expect(formatWorktreePathForDisplay("/repo/.worktrees/feature/")).toBe("feature");
  expect(worktreeDeleteQuestion("/repo/.worktrees/feature")).toBe("This thread is the only one linked to this worktree:\nfeature\n\nDelete the worktree too?");
});

test("the question is asked only for an orphaned worktree of a real project on a connection that may remove it, without automatic cleanup", () => {
  const facts = { worktreePath: "/w", projectCwd: "/repo", isScratchProject: false, canWriteSourceControl: true, automaticCleanup: false };
  expect(shouldAskToDeleteWorktree(facts)).toBe(true);
  expect(shouldAskToDeleteWorktree({ ...facts, worktreePath: null })).toBe(false);
  expect(shouldAskToDeleteWorktree({ ...facts, projectCwd: null })).toBe(false);
  expect(shouldAskToDeleteWorktree({ ...facts, isScratchProject: true })).toBe(false);
  expect(shouldAskToDeleteWorktree({ ...facts, canWriteSourceControl: false })).toBe(false);
  expect(shouldAskToDeleteWorktree({ ...facts, automaticCleanup: true })).toBe(false);
});

test("removal force-removes from the project folder then refreshes its status", async () => {
  const calls: unknown[] = [];
  const failure = await removeWorktreeAfterDelete({ projectCwd: "/repo", worktreePath: "/repo/.worktrees/feature", canWriteSourceControl: true }, async (method, payload) => { calls.push([method, payload]); return undefined; });
  expect(failure).toBeNull();
  expect(calls).toEqual([["vcs.removeWorktree", { cwd: "/repo", path: "/repo/.worktrees/feature", force: true }], ["vcs.refreshStatus", { cwd: "/repo" }]]);
});

test("a failed removal is Failed to delete worktree with the reason, and no refresh follows", async () => {
  const calls: string[] = [];
  const failure = await removeWorktreeAfterDelete({ projectCwd: "/repo", worktreePath: "/repo/.worktrees/feature", canWriteSourceControl: true }, async (method) => { calls.push(method); throw new Error("worktree is locked"); });
  expect(failure).toEqual({ title: "Failed to delete worktree", description: "Could not remove feature. worktree is locked" });
  expect(calls).toEqual(["vcs.removeWorktree"]);
});

test("a failed refresh after a removal says the worktree was deleted", async () => {
  const failure = await removeWorktreeAfterDelete({ projectCwd: "/repo", worktreePath: "/w/feature", canWriteSourceControl: true }, async (method) => { if (method === "vcs.refreshStatus") throw new Error("status timed out"); return undefined; });
  expect(failure).toEqual({ title: "Worktree deleted, but Git status refresh failed", description: "status timed out" });
});

test("a connection that lost write access cannot remove the worktree", async () => {
  const calls: string[] = [];
  const failure = await removeWorktreeAfterDelete({ projectCwd: "/repo", worktreePath: "/w/feature", canWriteSourceControl: false }, async (method) => { calls.push(method); return undefined; });
  expect(failure?.description).toBe("Could not remove feature. This connection can no longer remove worktrees.");
  expect(calls).toEqual([]);
});

test("a thread whose run is preparing, starting or running cannot be archived", () => {
  expect(archiveBlockedReason({ status: "idle", meta: { activityRunStatus: "running" } })).toBe(THREAD_ACTION_ERRORS.archiveBlocked);
  expect(archiveBlockedReason({ status: "idle", meta: { activityRunStatus: "starting" } })).toBe("Cannot archive while the provider is active.");
  expect(archiveBlockedReason({ status: "running" })).not.toBeNull();
  expect(archiveBlockedReason({ status: "idle", meta: { activityRunStatus: null } })).toBeNull();
});

test("the capability messages are the reference's", () => {
  expect(THREAD_ACTION_ERRORS.settleUnsupported).toBe("This environment's server does not support settling yet. Update the server to use Settle.");
  expect(THREAD_ACTION_ERRORS.snoozeUnsupported).toBe("This environment's server does not support snoozing yet. Update the server to use Snooze.");
  expect(THREAD_ACTION_ERRORS.snoozeBlocked).toBe("This thread is waiting on you. Respond to the pending request before snoozing it.");
  expect(THREAD_ACTION_ERRORS.pinUnsupported).toBe("This environment's server does not support pinning yet. Update the server to use Pin.");
});
