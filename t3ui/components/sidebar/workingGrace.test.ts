import { expect, test } from "nsh/test";
import type { Thread } from "../../store";
import type { ThreadSidebarMeta } from "./threadMeta";
import { createWorkingGrace, WORKING_EXIT_GRACE_MS } from "./workingGrace";

const meta = (patch: Partial<ThreadSidebarMeta>): ThreadSidebarMeta => ({
  runStatus: "idle", activityRunStatus: null, pendingRequestKind: null, pendingGuestMessageCount: 0,
  blockedOnThreadWait: false, lastErrorClass: null, lastVisitedAt: null, latestRunCompletedAt: null,
  latestRunStartedAt: null, snoozedUntil: null, settled: false, hasActionableProposedPlan: false,
  branch: null, titleRegenerating: false, ...patch,
});
const thread = (patch: Partial<ThreadSidebarMeta>, extra: Partial<Thread> = {}): Thread =>
  ({ id: "t", projectId: "p", title: "T", status: "idle", pinned: false, updatedAt: 0, meta: meta({ runtimeStatus: "running", ...patch }), ...extra });
const stopped = (patch: Partial<ThreadSidebarMeta> = {}, extra: Partial<Thread> = {}) =>
  thread({ runtimeStatus: "completed", runStatus: "completed", ...patch }, extra);

test("unchanged working placement does not request another shelf refresh", () => {
  const grace = createWorkingGrace();
  expect(grace.observe([thread({})], 1000)).toBe(true);
  expect(grace.observe([thread({}, { updatedAt: 2000 })], 2000)).toBe(false);
  expect(grace.observe([stopped({ pendingRequestKind: "approval" })], 2100)).toBe(true);
});

test("a thread that stops working keeps its Working place for the 2s grace, then returns", () => {
  const grace = createWorkingGrace();
  grace.observe([thread({})], 1000);
  expect(grace.isWorking(thread({}))).toBe(true);
  grace.observe([stopped()], 2000);
  expect(grace.isWorking(stopped())).toBe(true);
  expect(grace.nextDeadline()).toBe(2000 + WORKING_EXIT_GRACE_MS);
  expect(grace.expire(2000 + WORKING_EXIT_GRACE_MS)).toBe(true);
  expect(grace.isWorking(stopped())).toBe(false);
  expect(grace.returnedAt(stopped())).toBe(2000 + WORKING_EXIT_GRACE_MS);
});

test("turning the shelf off forgets old working and return observations", () => {
  const grace = createWorkingGrace();
  grace.observe([thread({})], 1000);
  grace.observe([stopped()], 2000);
  grace.expire(2000 + WORKING_EXIT_GRACE_MS);
  expect(grace.returnedAt(stopped())).toBe(2000 + WORKING_EXIT_GRACE_MS);
  expect(grace.clear()).toBe(true);
  expect(grace.returnedAt(stopped())).toBe(undefined);
  expect(grace.nextDeadline()).toBe(null);
});

test("an attention request, a pin, or a failure ends the hold at once", () => {
  for (const next of [
    stopped({ pendingRequestKind: "approval" }),
    stopped({ runStatus: "failed" }),
    stopped({}, { pinned: true }),
    stopped({ settled: true }),
  ]) {
    const grace = createWorkingGrace();
    grace.observe([thread({})], 1000);
    grace.observe([next], 2000);
    expect(grace.isWorking(next)).toBe(false);
  }
});

test("a thread that never worked is not held", () => {
  const grace = createWorkingGrace();
  grace.observe([stopped()], 1000);
  expect(grace.isWorking(stopped())).toBe(false);
  expect(grace.nextDeadline()).toBe(null);
});

test("a pending subagent request leaves Working", () => {
  const grace = createWorkingGrace();
  const waiting = thread({ pendingSubagentRequest: true });
  grace.observe([waiting], 1000);
  expect(grace.isWorking(waiting)).toBe(false);
});
