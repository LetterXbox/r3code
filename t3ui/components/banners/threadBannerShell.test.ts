import { expect, test } from "nsh/test";
import { shellThread } from "./bannerFixtures";
import { readBackgroundTasks, readGoal, threadBannerFromShell } from "./threadBannerShell";
import { observeBannerThreadItem, presentRunStop, providerExtensionStatuses, resetBannerThreadState, threadSessionState } from "./threadSessionState";

test("a quiet shell thread carries nothing for the banners", () => {
  expect(threadBannerFromShell(shellThread({ branch: null }))).toBeUndefined();
});

test("the shell's failure, recovery, goal and background tasks are read as the contract sends them", () => {
  const shell = threadBannerFromShell(shellThread({
    status: "failed", lastError: "limit", lastErrorClass: "usage_limit", lastErrorCode: "subscription_sharing_usage_limit_exceeded", usageLimitResetAt: "2026-11-11T15:00:00.000Z",
    limitRecovery: { runId: "run-1", resetAt: "2026-11-11T15:00:00.000Z", autoResume: true }, snoozedUntil: "2026-11-11T15:00:00.000Z",
    latestRunStopRequested: true, settledOverride: "settled", pendingRuntimeRequest: { kind: "user_input" },
    goal: { objective: "Ship", status: "usage_limited", tokensUsed: 5, tokenBudget: null, timeUsedSeconds: 90, checks: 2, lastCheck: "ok" },
    pendingBackgroundTasks: [{ taskId: "a", kind: "subagent", description: "Review", childThreadId: "child-1" }, { taskId: "b", kind: "weird" }, { kind: "command" }],
  }))!;
  expect(shell).toMatchObject({
    status: "failed", lastErrorClass: "usage_limit", lastErrorCode: "subscription_sharing_usage_limit_exceeded", usageLimitResetAt: "2026-11-11T15:00:00.000Z",
    limitRecovery: { runId: "run-1", autoResume: true }, latestRunStopRequested: true, settledOverride: "settled", hasPendingUserInput: true, pendingRequestKind: "user_input",
    latestRunId: "run-1", latestRunStoppedAt: "2026-11-11T10:05:00.000Z", branch: "main", worktreePath: null, providerInstanceId: "claudeAgent",
  });
  expect(shell.goal).toEqual({ objective: "Ship", status: "usage_limited", tokensUsed: 5, tokenBudget: null, timeUsedSeconds: 90, checks: 2, lastCheck: "ok" });
  expect(shell.pendingBackgroundTasks).toEqual([{ taskId: "a", kind: "subagent", description: "Review", childThreadId: "child-1" }, { taskId: "b", kind: "background_task" }]);
});

test("a goal needs an objective and a known status; a task kind that is not a subagent drops its child thread", () => {
  expect(readGoal({ objective: "", status: "active" })).toBeNull();
  expect(readGoal({ objective: "x", status: "nope" })).toBeNull();
  expect(readGoal(null)).toBeNull();
  expect(readBackgroundTasks([{ taskId: "a", kind: "command", childThreadId: "c" }])).toEqual([{ taskId: "a", kind: "command" }]);
  expect(readBackgroundTasks("nope")).toEqual([]);
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  kind: "snapshot",
  projection: {
    thread: { modelSelection: { instanceId: "pi" }, activeProviderThreadId: "pt-1" },
    providerSessions: [{ id: "s-1", providerInstanceId: "pi", status: "running", extensionStatuses: [{ key: "idx", text: "Indexing" }] }, { id: "s-0", providerInstanceId: "claudeAgent", status: "running", extensionStatuses: [{ key: "x", text: "Other" }] }],
    providerThreads: [{ id: "pt-1", providerSessionId: "s-1", providerInstanceId: "pi" }],
    runs: [{ id: "run-1", ordinal: 1, status: "running" }],
    turnItems: [{ type: "run_interrupt_request", runId: "run-1", startedAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z" }],
    ...overrides,
  },
});

test("the session state keeps the selected provider's extension statuses and the run's Stop", () => {
  resetBannerThreadState();
  observeBannerThreadItem("thread-1", snapshot());
  expect(providerExtensionStatuses(threadSessionState())).toEqual([{ key: "idx", text: "Indexing" }]);
  expect(presentRunStop(threadSessionState())).toEqual({ state: "stopping", runId: "run-1", requestedAt: "2026-11-11T10:00:00.000Z", background: false });
});

test("events move the Stop to unresponsive and then clear it with the result", () => {
  resetBannerThreadState();
  observeBannerThreadItem("thread-1", snapshot());
  observeBannerThreadItem("thread-1", { kind: "event", event: { type: "turn-item.updated", payload: { type: "run_interrupt_request", runId: "run-1", startedAt: "2026-11-11T10:00:00.000Z", unresponsiveAt: "2026-11-11T10:00:20.000Z" } } });
  expect(presentRunStop(threadSessionState())?.state).toBe("unresponsive");
  observeBannerThreadItem("thread-1", { kind: "event", event: { type: "turn-item.updated", payload: { type: "run_interrupt_result", runId: "run-1" } } });
  expect(presentRunStop(threadSessionState())).toBeNull();
});

test("a Stop on a finished run counts only while unanswered, as background-work Stop", () => {
  resetBannerThreadState();
  observeBannerThreadItem("thread-1", snapshot({ runs: [{ id: "run-1", ordinal: 1, status: "completed" }] }));
  expect(presentRunStop(threadSessionState())).toBeNull();
  observeBannerThreadItem("thread-1", { kind: "event", event: { type: "turn-item.updated", payload: { type: "run_interrupt_request", runId: "run-1", unresponsiveAt: "2026-11-11T10:00:20.000Z" } } });
  expect(presentRunStop(threadSessionState())).toMatchObject({ state: "unresponsive", background: true });
});

test("a stopped session and another thread's events supply nothing", () => {
  resetBannerThreadState();
  observeBannerThreadItem("thread-1", snapshot());
  observeBannerThreadItem("thread-2", { kind: "event", event: { type: "provider-session.updated", payload: { id: "s-1", providerInstanceId: "pi", status: "stopped" } } });
  expect(providerExtensionStatuses(threadSessionState())).toHaveLength(1);
  observeBannerThreadItem("thread-1", { kind: "event", event: { type: "provider-session.updated", payload: { id: "s-1", providerInstanceId: "pi", status: "stopped", extensionStatuses: [] } } });
  expect(providerExtensionStatuses(threadSessionState())).toEqual([]);
  resetBannerThreadState();
  expect(threadSessionState().threadId).toBeNull();
});

test("background tasks keep when they started and what a subagent reports, keyed by the native id", () => {
  resetBannerThreadState();
  observeBannerThreadItem("thread-1", snapshot({ turnItems: [
    { type: "command_execution", id: "i1", nativeItemRef: { nativeId: "task-a" }, startedAt: "2026-11-11T10:00:00.000Z" },
    { type: "subagent", id: "task-b", startedAt: "2026-11-11T10:01:00.000Z", progress: "Reading   files\n now" },
  ] }));
  expect(threadSessionState().tasks).toEqual({ "task-a": { startedAt: "2026-11-11T10:00:00.000Z", progress: null }, "task-b": { startedAt: "2026-11-11T10:01:00.000Z", progress: "Reading files now" } });
  observeBannerThreadItem("thread-1", { kind: "event", event: { type: "turn-item.updated", payload: { type: "subagent", id: "task-b", startedAt: "2026-11-11T10:01:00.000Z", progress: "Done" } } });
  expect(threadSessionState().tasks["task-b"]!.progress).toBe("Done");
});
