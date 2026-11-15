import { expect, test } from "nsh/test";
import { failureLabel, retryableRunId } from "./ErrorRow";
import { buildTimelineRows } from "./workLog";
import { activityFromTurnItem } from "./ingestActivity";

test("a failed error item is a failure row with usage-limit copy and a Retry for workspace preparation", () => {
  const wire = { id: "e1", threadId: "t1", runId: "r1", type: "error", status: "failed", failure: { class: "provider_error", code: "workspace_preparation_failed", message: "boom" } };
  const rows = buildTimelineRows([{ kind: "activity", id: "e1", activity: activityFromTurnItem(wire, 1)! }] as never, false);
  expect(rows[0].kind).toBe("failure");
  expect(retryableRunId(wire, [{ id: "r1", status: "failed", workspacePreparation: {} }])).toBe("r1");
  expect(retryableRunId(wire, [{ id: "r1", status: "failed" }])).toBe(null);
  expect(failureLabel({ failure: { class: "usage_limit" } }, "x")).toEqual({ label: "Usage limit reached.", warning: true });
  expect(failureLabel({ failure: { class: "usage_limit", resetAt: new Date().toISOString() } }, "x").label.startsWith("Usage limit reached. Retry after ")).toBe(true);
});
