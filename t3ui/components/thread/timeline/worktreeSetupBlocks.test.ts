import { expect, test } from "nsh/test";
import { readWorktreeSetupSnapshot, worktreeSetupBlocksSend } from "./worktreeSetup";

const snap = (phase: string, agent: string) => readWorktreeSetupSnapshot({
  threadId: "t1", phase, startedAt: "2026-01-01T00:00:00Z", endedAt: null, branch: null, baseRef: null, worktreePath: null, setupScript: null, error: null, sequence: 1,
  stages: [{ id: "agent", status: agent, startedAt: null, endedAt: null, percent: null, detail: null, tail: [] }],
});

test("a send is blocked while setup runs before the agent starts", () => {
  expect(worktreeSetupBlocksSend({ sendQueuesBehindSetup: false, visible: snap("running", "pending"), preparingWorktree: false })).toBe(true);
});
test("after the agent hand-off, or once setup ends, sends are not blocked", () => {
  expect(worktreeSetupBlocksSend({ sendQueuesBehindSetup: false, visible: snap("running", "done"), preparingWorktree: false })).toBe(false);
  expect(worktreeSetupBlocksSend({ sendQueuesBehindSetup: false, visible: snap("done", "pending"), preparingWorktree: true })).toBe(false);
});
test("sends queue behind a preparing or starting run instead of blocking", () => {
  expect(worktreeSetupBlocksSend({ sendQueuesBehindSetup: true, visible: snap("running", "pending"), preparingWorktree: true })).toBe(false);
});
test("without a snapshot the local preparing flag decides", () => {
  expect(worktreeSetupBlocksSend({ sendQueuesBehindSetup: false, visible: null, preparingWorktree: true })).toBe(true);
  expect(worktreeSetupBlocksSend({ sendQueuesBehindSetup: false, visible: null, preparingWorktree: false })).toBe(false);
});

test("the last snapshot is held after its stream ends, older sequences never replace it, and a thread switch drops it (useWorktreeSetup heldSnapshot)", async () => {
  const { signal } = await import("nsh");
  const { useWorktreeSetupSnapshot } = await import("./worktreeSetup");
  const raw = (sequence: number, phase = "running") => ({ threadId: "t1", phase, startedAt: "2026-01-01T00:00:00Z", endedAt: null, branch: null, baseRef: null, worktreePath: null, setupScript: null, error: null, sequence, stages: [] });
  let push: ((value: unknown) => void) | null = null;
  const subscribe = ((_method: string, _payload: unknown, onValue: (value: unknown) => void) => { push = onValue; return () => { push = null; }; }) as never;
  const thread = signal<string | null>("t1");
  const active = signal(true);
  const snapshot = useWorktreeSetupSnapshot(() => thread(), () => active(), subscribe);
  push!(raw(2));
  push!(raw(1, "done"));
  expect(snapshot()?.sequence).toBe(2);
  active.set(false);
  expect(push).toBe(null);
  expect(snapshot()?.sequence).toBe(2);
  thread.set("t2");
  expect(snapshot()).toBe(null);
});
