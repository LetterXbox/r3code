import { expect, test } from "nsh/test";
import { needsItemDetail } from "./itemDetail";
import type { WorkItem } from "./workLog";

const item = (input: unknown, threadId = "thread-1"): WorkItem => ({
  id: "tool-1", type: "dynamic_tool", title: "Tool", detail: "summary", status: "completed", threadId,
  item: { id: "tool-1", type: "dynamic_tool", input } as WorkItem["item"],
});

test("summarized tool input requests full detail even when output was not omitted", () => {
  expect(needsItemDetail(item({ truncated: true, summary: "Partial input" }))).toBe(true);
  expect(needsItemDetail(item({ command: "full input" }))).toBe(false);
  expect(needsItemDetail(item({ truncated: true, summary: "Partial input" }, ""))).toBe(false);
});
