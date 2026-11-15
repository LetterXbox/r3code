import { expect, test } from "nsh/test";
import { pendingApprovalForItem } from "./TimelineRows";

const approval = { id: "req-1", title: "Run npm test", detail: "npm test", options: [] };
const row = (type: string, requestId?: string) => ({ id: `item-${type}`, type, title: type, detail: "", status: "pending", ...(requestId ? { requestId } : {}) });

test("an approval_request row whose request is pending draws the approval at its position (TimelineWorkGroupRows)", () => {
  expect(pendingApprovalForItem(row("approval_request", "req-1") as never, [approval])?.id).toBe("req-1");
  expect(pendingApprovalForItem(row("approval_request", "req-2") as never, [approval])).toBe(null);
  expect(pendingApprovalForItem(row("command_execution", "req-1") as never, [approval])).toBe(null);
});
