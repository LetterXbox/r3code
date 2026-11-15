import { expect, test } from "nsh/test";
import { assertTaskUnchanged, buildTaskInput, localDateTime, readScheduledTasks, scheduledActionRequest, scheduleLabel } from "./data";
import type { TaskForm } from "./data";

const task = {
  id: "task-1", title: "Review", prompt: "Check changes", enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 3, 5] },
  projectId: "project-1", threadId: "thread-1", threadMode: "continue",
  workspaceStrategy: { type: "existing_worktree", worktreePath: "/project/worktree" },
  modelSelection: { instanceId: "codex", model: "example", options: { effort: "high" } },
  runtimeMode: "approval-required", interactionMode: "default", nextRunAt: null,
  lastRunStatus: "succeeded", lastRunError: null,
};
const form: TaskForm = {
  title: " Review ", prompt: " Check changes ", enabled: true, scheduleType: "fixed_time",
  intervalMinutes: "60", timeOfDay: "10:30", weekdays: [1, 3, 5], onceAt: "", projectId: "project-1",
  modelProvider: "codex", modelId: "example", runtimeMode: "approval-required", interactionMode: "default",
};

test("scheduled task streams keep valid tasks when future or invalid entries appear", () => {
  const parsed = readScheduledTasks({ tasks: [task, { id: "incomplete" }, { ...task, id: "future", schedule: { type: "future" } }] });
  expect(parsed.length).toBe(2);
  expect(parsed[0]?.id).toBe("task-1");
  expect(parsed[1]?.schedule).toEqual({ type: "unknown" });
  expect(scheduleLabel(parsed[0]!.schedule)).toBe("Mon, Wed, Fri at 09:30");
  expect(() => readScheduledTasks({})).toThrow("The server returned an invalid task list");
});

test("editing preserves the destination, model options and weekdays", () => {
  const parsed = readScheduledTasks({ tasks: [task] })[0]!;
  expect(buildTaskInput(form, "command:one", parsed)).toEqual({
    id: "task-1", requireExisting: true, threadId: "thread-1", threadMode: "continue", commandId: "command:one",
    title: "Review", prompt: "Check changes", enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "10:30", weekdays: [1, 3, 5] }, projectId: "project-1",
    workspaceStrategy: task.workspaceStrategy, modelSelection: task.modelSelection,
    runtimeMode: "approval-required", interactionMode: "default",
  });
});

test("creation rejects invalid intervals, modes and impossible local dates", () => {
  expect(() => buildTaskInput({ ...form, scheduleType: "interval", intervalMinutes: "0" }, "command:one")).toThrow("Choose an interval");
  expect(() => buildTaskInput({ ...form, runtimeMode: "invalid" }, "command:one")).toThrow("Choose valid permissions");
  expect(() => buildTaskInput({ ...form, scheduleType: "once", onceAt: "2027-02-30T09:30" }, "command:one")).toThrow("Enter a valid local date");
  const created = buildTaskInput({ ...form, scheduleType: "interval", intervalMinutes: "15" }, "command:one");
  expect(created.schedule).toEqual({ type: "interval", everyMs: 900000 });
  expect(created.workspaceStrategy).toEqual({ type: "root" });
});

test("task actions address the selected task and invert its enabled state", () => {
  const selected = readScheduledTasks({ tasks: [task] })[0]!;
  expect(scheduledActionRequest("toggle", selected)).toEqual({ method: "scheduledTasks.setEnabled", payload: { id: "task-1", enabled: false } });
  expect(scheduledActionRequest("run", selected)).toEqual({ method: "scheduledTasks.runNow", payload: { id: "task-1" } });
  expect(scheduledActionRequest("delete", selected)).toEqual({ method: "scheduledTasks.delete", payload: { id: "task-1" } });
});

test("editing an unrelated field preserves a one-time task's exact saved instant", () => {
  const runAt = "2027-01-09T09:30:42.789Z";
  const existing = readScheduledTasks({ tasks: [{ ...task, schedule: { type: "once", runAt } }] })[0]!;
  const updated = buildTaskInput({ ...form, title: "New title", scheduleType: "once", onceAt: localDateTime(runAt) }, "command:one", existing);
  expect(updated.schedule).toEqual({ type: "once", runAt });
});

test("editing rejects a task changed or removed since the editor opened", () => {
  const existing = readScheduledTasks({ tasks: [task] })[0]!;
  assertTaskUnchanged(existing, { ...existing });
  expect(() => assertTaskUnchanged(existing, { ...existing, enabled: false })).toThrow("This task changed");
  expect(() => assertTaskUnchanged(existing, undefined)).toThrow("This task no longer exists");
});

test("editing preserves sub-minute precision and accepts contract-valid long intervals", () => {
  const everyMs = 90001;
  const existing = readScheduledTasks({ tasks: [{ ...task, schedule: { type: "interval", everyMs } }] })[0]!;
  const unchanged = buildTaskInput({ ...form, title: "New title", scheduleType: "interval", intervalMinutes: String(everyMs / 60000) }, "command:one", existing);
  expect(unchanged.schedule).toEqual({ type: "interval", everyMs });
  const fractional = buildTaskInput({ ...form, scheduleType: "interval", intervalMinutes: "1.5" }, "command:two");
  expect(fractional.schedule).toEqual({ type: "interval", everyMs: 90000 });
  const longer = buildTaskInput({ ...form, scheduleType: "interval", intervalMinutes: "600000" }, "command:three");
  expect(longer.schedule).toEqual({ type: "interval", everyMs: 36000000000 });
});
