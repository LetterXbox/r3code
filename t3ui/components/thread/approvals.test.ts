import { expect, test } from "nsh/test";
import { applyRuntimeRequestForTest, threadApprovals } from "../../store";

test("an approval with an empty prompt is kept so it can still be answered", () => {
  applyRuntimeRequestForTest(
    { id: "req-empty", status: "pending", kind: "file-change", responseCapability: { type: "live" } },
    { id: "item-empty", type: "approval_request", requestId: "req-empty", requestKind: "file-change" },
  );
  applyRuntimeRequestForTest(
    { id: "req-full", status: "pending", kind: "command", responseCapability: { type: "live" } },
    { id: "item-full", type: "approval_request", requestId: "req-full", requestKind: "command", prompt: "npm test" },
  );
  const approvals = threadApprovals();
  const empty = approvals.find((approval) => approval.id === "req-empty");
  expect(empty?.detail).toBe("");
  expect(empty?.options.map((option) => option.decision)).toEqual(["accept", "decline"]);
  expect(approvals.find((approval) => approval.id === "req-full")?.detail).toBe("npm test");
});
