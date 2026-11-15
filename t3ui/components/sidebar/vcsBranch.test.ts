import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { branchMismatch, createVcsBranchWatcher, readBranchEvent } from "./vcsBranch";

test("rows on one checkout share one subscribeVcsBranch stream; it closes with the last row", () => {
  const calls: unknown[] = [];
  let push: (value: unknown) => void = () => {};
  let stopped = 0;
  const watcher = createVcsBranchWatcher({
    subscribe: (method, payload, onValue) => { calls.push([method, payload]); push = onValue; return () => { stopped += 1; }; },
    request: async () => undefined, branchStatus: () => true, connected: () => true, active: () => true,
  });
  const a = watcher.retain("/repo");
  const b = watcher.retain("/repo");
  expect(calls).toEqual([["subscribeVcsBranch", { cwd: "/repo" }]]);
  push({ refName: "feature" });
  expect(a.branch()).toBe("feature");
  a.release();
  expect(stopped).toBe(0);
  b.release();
  expect(stopped).toBe(1);
});

test("an older server falls back to the local half of subscribeVcsStatus", () => {
  const calls: unknown[] = [];
  const watcher = createVcsBranchWatcher({
    subscribe: (method, payload) => { calls.push([method, payload]); return () => {}; },
    request: async () => undefined, branchStatus: () => false, connected: () => true, active: () => true,
  });
  watcher.retain("/repo");
  expect(calls).toEqual([["subscribeVcsStatus", { cwd: "/repo", includeRemote: false }]]);
  expect(readBranchEvent({ _tag: "localUpdated", local: { refName: "main" } }, false)).toBe("main");
  expect(readBranchEvent({ _tag: "remoteUpdated", remote: {} }, false)).toBe(undefined);
});

test("coming back to the app asks vcs.refreshBranch for each retained checkout; reconnect resubscribes", async () => {
  const requests: unknown[] = [];
  let subscribes = 0;
  const active = signal(true);
  const connected = signal(true);
  const watcher = createVcsBranchWatcher({
    subscribe: () => { subscribes += 1; return () => {}; },
    request: async (method, payload) => { requests.push([method, payload]); },
    branchStatus: () => true, connected: () => connected(), active: () => active(), wakeDebounceMs: 1,
  });
  watcher.retain("/repo");
  active.set(false);
  active.set(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(requests).toEqual([["vcs.refreshBranch", { cwd: "/repo" }]]);
  connected.set(false);
  connected.set(true);
  expect(subscribes).toBe(2);
});

test("the mismatch is resolveLocalCheckoutBranchMismatch's", () => {
  expect(branchMismatch({ worktreePath: null, threadBranch: "a", currentBranch: "b" })).toEqual({ threadBranch: "a", currentBranch: "b" });
  expect(branchMismatch({ worktreePath: "/w", threadBranch: "a", currentBranch: "b" })).toBe(null);
  expect(branchMismatch({ worktreePath: null, threadBranch: "a", currentBranch: "a" })).toBe(null);
});
