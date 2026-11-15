import { expect, test } from "nsh/test";
import type { Thread } from "../../store";
import { runtimeStatusFromShell, threadMetaFromShell } from "./threadMeta";
import { formatWorkingDuration, isThreadWorking, resolveThreadStatus, resolveTopStatus, statusDurationLabel, workingStartedAt } from "./threadStatus";
import { threadProviderStack } from "./threadProviders";
import { partitionActive, sortByReturn, sortWorkingBySend } from "./workingShelf";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const thread = (id: string, shell: Record<string, unknown>, extra: Partial<Thread> = {}): Thread => ({
  id, projectId: "p", title: id, status: "idle", pinned: false, updatedAt: NOW, createdAt: NOW - 10_000_000,
  meta: threadMetaFromShell({ id, status: "idle", providerInstanceId: "claudeAgent", ...shell }), ...extra,
});
const running = (id: string, shell: Record<string, unknown> = {}) =>
  thread(id, { status: "running", latestRunId: "r", activeRunId: "r", activityRunStatus: "running", ...shell });

test("runtimeStatusFromShell follows shellRuntime", () => {
  expect(runtimeStatusFromShell({}, "idle")).toBe(null);
  expect(runtimeStatusFromShell({ latestRunId: "r" }, "completed")).toBe("completed");
  expect(runtimeStatusFromShell({ latestRunId: "r", activityRunStatus: "waiting" }, "running")).toBe("waiting");
  expect(runtimeStatusFromShell({ latestRunId: "r", pendingBackgroundTasks: [{ kind: "subagent" }] }, "completed")).toBe("idle");
  expect(runtimeStatusFromShell({ latestRunId: "r", pendingBackgroundTasks: [{ kind: "command" }] }, "completed")).toBe("completed");
  expect(runtimeStatusFromShell({ latestRunId: "r", pendingBackgroundTasks: [{ kind: "command", awaited: true }] }, "failed")).toBe("failed");
});

test("a running thread is Working, a parked one Waiting, a finished one neither", () => {
  const live = running("live");
  expect(resolveThreadStatus(live)).toBe("working");
  expect(isThreadWorking(live)).toBe(true);
  const parked = thread("parked", { status: "completed", latestRunId: "r", pendingBackgroundTasks: [{ kind: "subagent" }] });
  expect(resolveThreadStatus(parked)).toBe("waiting");
  expect(isThreadWorking(parked)).toBe(true);
  const done = thread("done", { status: "completed", latestRunId: "r" });
  expect(isThreadWorking(done)).toBe(false);
  const fresh = thread("fresh", {});
  expect(isThreadWorking(fresh)).toBe(false);
  expect(isThreadWorking(running("asks", { pendingRuntimeRequest: { kind: "user_input" } }))).toBe(false);
  expect(isThreadWorking(running("approves", { pendingRuntimeRequest: { kind: "command_approval" } }))).toBe(false);
});

test("a settled plan waiting on the user leaves Working", () => {
  const plan = thread("plan", { status: "idle", latestRunId: "r", activeProviderThreadId: "pt", interactionMode: "plan", hasActionableProposedPlan: true });
  expect(isThreadWorking(plan)).toBe(false);
});

test("the setting-up and goal labels", () => {
  expect(resolveTopStatus(running("prep", { activityRunStatus: "preparing" }))?.label).toBe("Setting up");
  expect(resolveTopStatus(running("goal", { goal: { status: "active" } }))?.label).toBe("Goal");
  expect(resolveTopStatus(running("plain"))?.label).toBe("Working");
});

test("the duration counts from the activity start, or from completion while waiting", () => {
  const live = running("live", { activityRunStartedAt: iso(6 * 60_000 + 3_000) });
  expect(workingStartedAt(live)).toBe(NOW - 6 * 60_000 - 3_000);
  expect(statusDurationLabel(live, NOW)).toBe("6m");
  const sinceRequest = running("req", { latestRunStartedAt: iso(42_000) });
  expect(statusDurationLabel(sinceRequest, NOW)).toBe("42s");
  const parked = thread("parked", { status: "completed", latestRunId: "r", latestRunCompletedAt: iso(24 * 60_000), pendingBackgroundTasks: [{ kind: "background_task" }] });
  expect(statusDurationLabel(parked, NOW)).toBe("24m");
  expect(statusDurationLabel(thread("done", { status: "completed", latestRunId: "r" }), NOW)).toBe(null);
  expect(formatWorkingDuration(3_900_000)).toBe("1h 5m");
});

test("partitionActive moves running threads to Working, newest send first", () => {
  const older = running("older", { latestUserAuthoredMessageAt: iso(5000) });
  const newer = running("newer", { latestUserAuthoredMessageAt: iso(1000) });
  const idle = thread("idle", { status: "completed", latestRunId: "r", latestRunCompletedAt: iso(100) });
  const split = partitionActive([older, idle, newer], true);
  expect(split.working.map((item) => item.id)).toEqual(["newer", "older"]);
  expect(split.rest.map((item) => item.id)).toEqual(["idle"]);
  expect(partitionActive([older, idle, newer], false).working).toEqual([]);
});

test("the rest of the active list sorts by when each thread came back", () => {
  const a = thread("a", { latestRunCompletedAt: iso(9000) }, { createdAt: NOW - 90_000 });
  const b = thread("b", { latestRunCompletedAt: iso(1000) }, { createdAt: NOW - 90_000 });
  const c = thread("c", {}, { createdAt: NOW - 5_000 });
  expect(sortByReturn([a, b, c]).map((item) => item.id)).toEqual(["b", "c", "a"]);
  expect(sortWorkingBySend([a, b]).length).toBe(2);
});

test("return observations affect the inbox order while a null user-send time does not use the run time", () => {
  const absent = thread("absent", { latestRunRequestedAt: iso(2000) });
  const explicitNull = thread("null", { latestUserAuthoredMessageAt: null, latestRunRequestedAt: iso(1000) });
  expect(sortWorkingBySend([explicitNull, absent]).map((item) => item.id)).toEqual(["absent", "null"]);
  expect(sortByReturn([absent, explicitNull], (item) => item.id === "absent" ? NOW : undefined).map((item) => item.id)).toEqual(["absent", "null"]);
});

test("the provider stack ends with the current instance and keeps two earlier ones", () => {
  const stacked = thread("s", { providerInstanceId: "codex", providerInstanceHistory: ["a", "b", "c", "codex"] });
  expect(threadProviderStack(stacked)).toEqual(["b", "c", "codex"]);
  expect(threadProviderStack(thread("one", { providerInstanceId: "claudeAgent" }))).toEqual(["claudeAgent"]);
});

test("the shell's live fields reach the meta", () => {
  const meta = threadMetaFromShell({
    status: "running", activityRunStatus: "running", activityRunStartedAt: iso(1000), latestRunId: "r", activeRunId: "r",
    providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-5" }, branch: "legion-merge",
  });
  expect(meta.runtimeStatus).toBe("running");
  expect(meta.providerInstanceId).toBe("codex");
  expect(meta.model).toBe("gpt-5");
  expect(meta.branch).toBe("legion-merge");
  expect(meta.activityStartedAt).toBe(NOW - 1000);
});
