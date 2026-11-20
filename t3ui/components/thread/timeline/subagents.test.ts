import { expect, test } from "nsh/test";
import { activityFromTurnItem } from "./ingestActivity";
import { formatSubagentDisplayTitle, formatSubagentElapsed, groupSubagentItems, overlaySubagent, responseSubagents, subagentGroupSummary, subagentGroupTiming, subagentRowDetail, subagentTrailingStatus, summarizeSubagentStatuses } from "./subagents";
import { buildTimelineRows, summarizeWorkGroup } from "./workLog";

test("a reply names only the agents whose results reached its preceding input block", () => {
  const items = [
    { id: "older", type: "notification", source: { childThreadId: "unrelated" } },
    { id: "previous-answer", type: "assistant_message" },
    { id: "notice", type: "notification", source: { childThreadId: "local", taskIds: ["remote-task"] } },
    { id: "delivery", type: "user_message", messageId: "delivery-message", senderThreadId: "local" },
    { id: "question", type: "user_message", messageId: "question-message", senderThreadId: "parent" },
    { id: "tool", type: "dynamic_tool" },
    { id: "target", type: "assistant_message" },
  ];
  const agents = [
    { id: "local-task", title: "Local helper", childThreadId: "local" },
    { id: "remote-task", remoteChild: { environmentId: "remote", threadId: "remote-child", title: "Remote helper" } },
    { id: "delivered-task", title: "Result sender", childThreadId: "delivered-child" },
  ];
  expect(responseSubagents(items, agents, "target", (id) => id === "delivery-message" ? ["delivered-task"] : [])).toEqual([
    { threadId: "local", title: "Local helper" },
    { threadId: "delivered-child", title: "Result sender" },
    { environmentId: "remote", threadId: "remote-child", title: "Remote helper" },
  ]);
  expect(responseSubagents(items, agents, "missing", () => [])).toEqual([]);
});

const item = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `i${n}`, type: "subagent", subagentId: `a${n}`, origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent",
  childThreadId: `c${n}`, prompt: "p", title: `Agent ${n}`, status, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, runId: "r", providerTurnId: "t", result: null, ...extra,
});

test("a subagent turn item carries its child's fields into the activity row", () => {
  const activity = activityFromTurnItem(item(1, "running", { progress: "Running ls" }), 1)!;
  expect(activity.subagent).toMatchObject({ subagentId: "a1", childThreadId: "c1", status: "running", progress: "Running ls", title: "Agent 1", driver: "claudeAgent" });
});

test("the live subagent record wins over the item", () => {
  const fields = activityFromTurnItem(item(1, "running"), 1)!.subagent!;
  const live = overlaySubagent(fields, { id: "a1", status: "completed", result: "done", completedAt: "2026-01-01T00:00:19.000Z", startedAt: "2026-01-01T00:00:00.000Z" });
  expect(live.status).toBe("completed");
  expect(live.result).toBe("done");
  expect(formatSubagentElapsed(live, 0)).toBe("19s");
});

test("status counts, group summary and timing", () => {
  expect(summarizeSubagentStatuses(["running", "pending", "completed", "completed", "completed", "completed"])).toBe("2 working · 4 done");
  expect(summarizeSubagentStatuses(["failed", "cancelled", "idle"])).toBe("1 failed · 1 stopped · 1 idle");
  expect(subagentGroupSummary([{ status: "failed" }, { status: "completed" }])).toEqual({ active: false, failed: true });
  const timing = subagentGroupTiming([{ status: "completed", startedAt: 10_000, completedAt: 40_000 }, { status: "completed", startedAt: 5_000, completedAt: 90_000 }]);
  expect(timing).toEqual({ status: "completed", startedAt: 5_000, completedAt: 90_000 });
  expect(formatSubagentElapsed(subagentGroupTiming([{ status: "running", startedAt: 0, completedAt: null }]), 72_000)).toBe("1m 12s");
});

test("a row's detail is the result once settled, else the progress, and hides the generic end notice", () => {
  expect(subagentRowDetail({ status: "completed", progress: "p", result: "The **result**" })).toBe("The **result**");
  expect(subagentRowDetail({ status: "running", progress: "Running find", result: "old" })).toBe("Running find");
  expect(subagentRowDetail({ status: "completed", progress: null, result: "Child task ended with status completed" })).toBeNull();
  expect(subagentTrailingStatus({ status: "running", progress: "Running find", result: null })).toBe("Running");
  expect(subagentTrailingStatus({ status: "running", progress: null, result: null })).toBeNull();
  expect(subagentTrailingStatus({ status: "completed", progress: null, result: "ok" })).toBeNull();
});

test("titles lose the Subagent prefix and root paths read as names", () => {
  expect(formatSubagentDisplayTitle("Subagent: Fix it")).toBe("Fix it");
  expect(formatSubagentDisplayTitle("/root/team/theme_audit")).toBe("Theme Audit");
});

test("consecutive subagent items of one run form one timeline row, between tool groups", () => {
  const entries = [item(1, "completed"), item(2, "running"), item(3, "completed", { providerTurnId: "other" })].map((raw, index) => {
    const activity = activityFromTurnItem(raw, index + 1)!;
    return { kind: "activity" as const, id: `activity:${activity.id}`, order: index + 1, sequence: index, activity };
  });
  const rows = buildTimelineRows(entries, false);
  expect(rows.map((row) => row.kind)).toEqual(["subagents", "subagents"]);
  expect(groupSubagentItems(entries.map((entry) => entry.activity)).map((group) => group.length)).toEqual([2, 1]);
});

test("a group of integration tool calls is summarised by the integration", () => {
  const tool = (id: string, name: string) => ({ id, type: "dynamic_tool", title: "Tool", detail: "x", status: "completed", toolSource: { key: name, name, kind: "integration" as const } });
  expect(summarizeWorkGroup([tool("1", "kimi-cu"), tool("2", "kimi-cu")]).summary).toBe("Used kimi-cu integration");
  expect(summarizeWorkGroup([tool("1", "a"), tool("2", "b"), { id: "3", type: "command_execution", title: "Command", detail: "ls", status: "completed" }]).summary).toBe("Used a and b integrations and ran 1 command");
});

test("T3 MCP tool calls read in the present tense while running and the past once done", async () => {
  const { t3McpToolLabel, t3McpToolId } = await import("./t3McpTools");
  expect(t3McpToolLabel("mcp__t3-code__link_pull_request", { number: 12 }, "inProgress")).toBe("Linking PR #12");
  expect(t3McpToolLabel("mcp__t3-code__link_pull_request", {}, "completed")).toBe("Linked a pull request");
  expect(t3McpToolLabel("mcp__t3-code__preview_act", { action: "click" }, "completed")).toBe("Clicked in the preview browser");
  expect(t3McpToolLabel("mcp__t3-code__t3_thread_read", {}, "failed")).toBe("Failed to read a T3 thread");
  expect(t3McpToolLabel("mcp__kimi-cu__click", {}, "completed")).toBeNull();
  expect(t3McpToolId("t3-code-direct.t3_queue")).toBe("t3_queue");
});

test("provider errors: retries in progress, recovered, exhausted, and a usage limit read as the web app words them", () => {
  const error = (extra: Record<string, unknown>) => activityFromTurnItem({ id: "e", type: "error", status: "running", failure: { class: "provider", message: "Overloaded" }, ...extra }, 1)!;
  const running = error({ retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 1500 } });
  expect([running.title, running.detail, running.tone]).toEqual(["Retrying provider (2/5)", "Overloaded Retrying in 1.5s.", "neutral"]);
  expect(error({ status: "completed", retry: { attempt: 2, maxAttempts: null, retryDelayMs: null } }).title).toBe("Provider recovered (2 retries)");
  expect(error({ status: "failed", retry: { attempt: 5, maxAttempts: 5, retryDelayMs: null } }).title).toBe("Provider error after 5/5 retries");
  const limit = error({ status: "failed", failure: { class: "usage_limit", message: "Try again at 5pm" } });
  expect([limit.title, limit.detail, limit.tone]).toEqual(["Usage limit reached", "Try again at 5pm", "neutral"]);
  const plain = error({ status: "failed", title: "Auth failed" });
  expect([plain.title, plain.tone]).toEqual(["Auth failed", "danger"]);
});

test("the hover card preview collapses whitespace and cuts at 280 characters", async () => {
  const { subagentDetailPreview } = await import("./subagents");
  expect(subagentDetailPreview({ status: "running", progress: "Running\n  ls", result: null })).toBe("Running ls");
  expect(subagentDetailPreview({ status: "completed", progress: "p", result: "x".repeat(300) })?.length).toBe(281);
  expect(subagentDetailPreview({ status: "completed", progress: null, result: null })).toBeNull();
});

test("a subagent item delegated to a linked environment keeps where its thread runs", async () => {
  const { subagentFromTurnItem } = await import("./subagents");
  const fields = subagentFromTurnItem({ type: "subagent", subagentId: "n1", childThreadId: null, remoteChild: { environmentId: "env-b", threadId: "rt", label: "Build box" } });
  expect([fields?.remoteLabel, fields?.remote]).toEqual(["Build box", { environmentId: "env-b", threadId: "rt" }]);
  expect(subagentFromTurnItem({ type: "subagent", subagentId: "n2" })?.remote).toBe(null);
});
