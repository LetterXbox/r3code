import { expect, test } from "nsh/test";
import { activityFromTurnItem } from "./ingestActivity";

// Contract-shaped turn items (orchestrationV2.ts OrchestrationV2TurnItem): the base fields plus each kind's own.
const base = (type: string, extra: Record<string, unknown>) => ({
  id: `item-${type}`, threadId: "t1", runId: "r1", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
  parentItemId: null, ordinal: 4, status: "completed", title: null, startedAt: "2026-01-01T00:00:00Z", completedAt: null,
  updatedAt: "2026-01-01T00:00:01Z", type, ...extra,
});
const activity = (type: string, extra: Record<string, unknown>) => activityFromTurnItem(base(type, extra), 7);

test("reasoning carries its text and streaming status", () => {
  const input = base("reasoning", { text: "I'm checking the server.", streaming: true, status: "running" });
  // The row carries the server's structured item by reference, beside the flattened fields.
  const { item: carried, ...item } = activityFromTurnItem(input, 7) ?? {};
  expect(carried === input).toBe(true);
  expect(item).toEqual({ id: "item-reasoning", type: "reasoning", title: "Reasoning", detail: "I'm checking the server.", status: "running", order: 7, ordinal: 4, startedAt: 1767225600000 });
});

test("a streamed update replaces the text, a completed one ends the status", () => {
  expect(activity("reasoning", { text: "I'm checking", streaming: true, status: "running" })?.detail).toBe("I'm checking");
  const done = activity("reasoning", { text: "I'm checking the server.", streaming: false, status: "completed" });
  expect(done?.detail).toBe("I'm checking the server.");
  expect(done?.status).toBe("completed");
});

test("command_execution: input and output, and a non-zero exit is a failure", () => {
  const ok = activity("command_execution", { input: "cat x", output: "hello", exitCode: 0 });
  expect(ok?.detail).toBe("cat x\n\nhello");
  expect(ok?.status).toBe("completed");
  expect(activity("command_execution", { input: "cat x", exitCode: 0, outputIndicatesFailure: true })?.status).toBe("completed");
  expect(activity("command_execution", { input: "false", exitCode: 1 })?.status).toBe("failed");
  expect(activity("command_execution", { input: "x", outputOmitted: true })?.detail).toContain("Output omitted");
});

test("file_change, file_search and web_search", () => {
  expect(activity("file_change", { fileName: "a.ts", diffStr: "+x" })?.detail).toBe("a.ts\n\n+x");
  expect(activity("file_change", { fileName: "a.ts", changes: [{ operation: "edit", path: "b.ts" }] })?.detail).toBe("a.ts\n\nb.ts");
  expect(activity("file_search", { pattern: "foo", results: [{ fileName: "a.ts", line: 3 }] })?.detail).toBe("foo\n\na.ts:3");
  expect(activity("web_search", { patterns: ["t3 code"], results: [{ title: "T3", url: "https://t3.codes" }] })?.detail).toBe("t3 code\n\nT3 - https://t3.codes");
});

test("dynamic_tool, MCP-style tools and subagents", () => {
  expect(activity("dynamic_tool", { toolName: "mcp__x__y", input: { a: 1 }, output: "ok" })?.detail).toBe('mcp__x__y\n\n{"a":1}\n\nok');
  const agent = activity("subagent", { subagentId: "n1", prompt: "look", progress: "half", result: null, status: "running" });
  expect(agent?.detail).toBe("look\n\nhalf");
  expect(agent?.status).toBe("running");
});

test("plans, todo lists, notices, errors and retries", () => {
  expect(activity("proposed_plan", { planId: "p", markdown: "# Plan", streaming: false })?.detail).toBe("# Plan");
  expect(activity("todo_list", { planId: "p", steps: [{ id: "1", text: "one", status: "completed" }, { id: "2", text: "two", status: "pending" }] })?.detail).toBe("[x] one\n\n[ ] two");
  expect(activity("system_notice", { message: "Heads up" })?.detail).toBe("Heads up");
  expect(activity("error", { failure: { class: "provider_error", message: "boom" }, retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 1000 } })?.title).toBe("Provider recovered (2/5 retries)");
});

test("lifecycle kinds: compaction, handoff, interrupts, fork, thread_created, notification, requests", () => {
  expect(activity("compaction", { driver: null, summary: "saved 12k" })?.detail).toBe("saved 12k");
  expect(activity("handoff", { summary: "moved" })?.title).toBe("Context handoff");
  expect(activity("run_interrupt_result", { message: "Stopped" })?.detail).toBe("Stopped");
  expect(activity("run_interrupt_request", { message: "Stopping" })?.type).toBe("run_interrupt_request");
  expect(activity("fork", { targetThreadId: "t2" })?.title).toBe("Fork");
  expect(activity("thread_created", { targetThreadId: "t2", targetModel: "gpt", title: "Child" })?.title).toBe("Child");
  const note = activity("notification", { source: { kind: "system" }, outcome: "completed", summary: "Task done", detail: "all good" });
  expect(note?.title).toBe("Task done");
  expect(note?.detail).toBe("Task done\n\nall good");
  expect(activity("user_input_request", { requestId: "q", questions: [{ id: "1", question: "Which?" }] })?.detail).toBe("Which?");
  expect(activity("secret_request", { label: "Key", reason: "needed", secretStatus: "pending" })?.detail).toBe("needed");
  expect(activity("link_request", { reason: "link it", linkStatus: "pending" })?.detail).toBe("link it");
});

// The reference keeps approval_request items as work-log entries (TimelineWorkGroupRows draws a pending one as
// TimelinePendingApprovalRow at its position), so approvals are no longer dropped here.
test("messages are drawn by their own surface; approvals stay in the work log with their request id", () => {
  expect(activity("user_message", { messageId: "m", text: "hi" })).toBe(null);
  expect(activity("assistant_message", { messageId: "m", text: "hi", streaming: false })).toBe(null);
  expect(activity("approval_request", { requestId: "a", requestKind: "command" })?.requestId).toBe("a");
});

test("a tool call's icon comes from the item, else from its source, in the contract's tagged shape", () => {
  const own = activity("dynamic_tool", { toolName: "mcp__gh__issue", input: {}, toolIcon: { _tag: "website", pageUrl: "https://github.com/x", faviconUrlDark: "https://x.test/d.png" }, toolSource: { key: "gh", name: "GitHub", kind: "integration", icon: { _tag: "themed-logo", logoUrl: "https://x.test/l.svg" } } });
  expect(own?.toolIcon).toEqual({ tag: "website", pageUrl: "https://github.com/x", faviconUrlDark: "https://x.test/d.png" });
  const sourced = activity("dynamic_tool", { toolName: "mcp__gh__issue", input: {}, toolSource: { key: "gh", name: "GitHub", kind: "integration", icon: { _tag: "themed-logo", logoUrl: "https://x.test/l.svg", logoUrlDark: "https://x.test/ld.svg" } } });
  expect(sourced?.toolIcon).toEqual({ tag: "themed-logo", logoUrl: "https://x.test/l.svg", logoUrlDark: "https://x.test/ld.svg" });
  expect(activity("dynamic_tool", { toolName: "mcp__gh__issue", input: {}, toolIcon: { _tag: "native-app", app: { _tag: "display-name", displayName: "Finder" } } })?.toolIcon).toEqual({ tag: "native-app", app: { _tag: "display-name", displayName: "Finder" } });
  expect(activity("dynamic_tool", { toolName: "x", input: {} })?.toolIcon).toBeUndefined();
});
