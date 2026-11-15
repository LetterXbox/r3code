import { expect, test } from "nsh/test";
import { notifiedSubagent, subagentFromRecord, subagentNotificationEvent, subagentResumedSince } from "./subagents";

test("subagentResumedSince: active agents supersede outcomes; settled ones must start after the notice", () => {
  expect(subagentResumedSince({ status: "running", startedAt: 1 }, 100)).toBe(true);
  expect(subagentResumedSince({ status: "completed", startedAt: 50 }, 100)).toBe(false);
  expect(subagentResumedSince({ status: "completed", startedAt: 150 }, 100)).toBe(true);
  expect(subagentResumedSince({ status: "completed", startedAt: null }, 100)).toBe(false);
});

test("a notification shows its outcome label and time on the child's row", () => {
  expect(subagentNotificationEvent({ status: "completed", startedAt: 10 }, "completed", 100, "10:00")).toEqual({ status: "completed", label: "Finished", timestamp: "10:00" });
  expect(subagentNotificationEvent({ status: "failed", startedAt: 10 }, "failed", 100, "t")?.label).toBe("Failed");
  expect(subagentNotificationEvent({ status: "cancelled", startedAt: 10 }, "cancelled", 100, "t")?.label).toBe("Stopped");
  expect(subagentNotificationEvent({ status: "running", startedAt: 10 }, "updated", 100, "t")).toEqual({ status: null, label: "Updated", timestamp: "t" });
  expect(subagentNotificationEvent({ status: "running", startedAt: 10 }, "completed", 100, "t")).toBe(undefined);
});

test("the notified child is found by task ids for delegated tasks, by child thread otherwise", () => {
  const records = [{ id: "a", childThreadId: "c1", title: "Explore", status: "completed", driver: "claudeAgent" }, { id: "b", childThreadId: "c1", status: "completed" }];
  expect(notifiedSubagent(records, "c1", undefined)?.id).toBe("a");
  expect(notifiedSubagent(records, "c1", ["b"])?.id).toBe("b");
  expect(subagentFromRecord(records[0])?.title).toBe("Explore");
});
