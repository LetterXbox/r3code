import { expect, test } from "nsh/test";
import type { Message } from "../../../store";
import { activeRun, createStableMessageList, deriveWorking, itemTextOmitted, mergeItemMessage, mergeTranscriptItem, messageFromTurnItem, runlessSubagentWork } from "./ingest";

test("visible message lists keep their identity across unrelated updates but not thread switches", () => {
  const stable = createStableMessageList();
  const message = { id: "m", role: "user" as const, body: "hello", order: 1 };
  const first = stable("a", [message]);
  expect(stable("a", [message]) === first).toBe(true);
  expect(stable("b", [message]) === first).toBe(false);
});

test("unchanged turn items do not publish a new transcript map", () => {
  const message = { id: "m", role: "user" as const, body: "hello", order: 1, streaming: false, attachments: [] };
  const other = [{ ...message, id: "other" }];
  const all = { a: [message], b: other };
  expect(mergeTranscriptItem(all, "a", { ...message }, false) === all).toBe(true);
  const changed = mergeTranscriptItem(all, "a", { ...message, body: "hello again" }, false);
  expect(changed === all).toBe(false);
  expect(changed.b === other).toBe(true);
});

test("a turn item can supply attachment context after the message record arrives", () => {
  const record = { id: "message", role: "user" as const, body: "See image", order: 1, streaming: false, attachments: [] };
  const context = { version: 1, records: [{ kind: "image", contextId: "image_1", label: "image.png", attachmentId: "asset" }] };
  const merged = mergeItemMessage([record], { ...record, context }, false);
  expect(merged[0]!.context).toEqual(context);
  expect(merged[0] === record).toBe(false);
});
import { buildTimelineRows } from "./workLog";

// Payloads copy the contract shapes (packages/contracts orchestrationV2.ts): OrchestrationV2TurnItem
// base fields + user_message / assistant_message, OrchestrationV2ConversationMessage, OrchestrationV2Run.
const base = { threadId: "thread-1", runId: "run-1", nodeId: "node-1", providerThreadId: null, providerTurnId: null, nativeItemRef: null,
  parentItemId: null, title: null, completedAt: null, updatedAt: "2026-06-20T00:00:02.000Z" };
const userItem = { ...base, id: "item-u", type: "user_message", ordinal: 1, status: "completed", startedAt: "2026-06-20T00:00:00.000Z",
  messageId: "msg-u", inputIntent: "turn_start", text: "hello", attachments: [] };
const assistantItem = (text: string, streaming: boolean) => ({ ...base, id: "item-a", type: "assistant_message", ordinal: 3,
  status: streaming ? "running" : "completed", startedAt: "2026-06-20T00:00:03.000Z", messageId: "msg-a", text, streaming });
const run = (status: string, extra: Record<string, unknown> = {}) => ({ id: "run-1", threadId: "thread-1", ordinal: 1, status,
  requestedAt: "2026-06-20T00:00:00.000Z", startedAt: "2026-06-20T00:00:01.000Z", completedAt: null, ...extra });

test("provider subagent work follows its latest runless root node", () => {
  const thread = { creationSource: "provider", lineage: { relationshipToParent: "subagent" } };
  const node = { kind: "root_turn", runId: null, status: "running", startedAt: "2026-06-20T00:00:01.000Z" };
  expect(runlessSubagentWork(thread, [node])).toEqual({ working: true, startedAt: Date.parse(node.startedAt) });
  expect(runlessSubagentWork(thread, [node, { ...node, status: "completed" }])?.working).toBe(false);
  expect(runlessSubagentWork(thread, [{ ...node, runId: "run-1" }])).toBe(null);
  expect(runlessSubagentWork({ ...thread, creationSource: "web" }, [node])).toBe(null);
});

test("an assistant reply that arrives only as streamed turn items shows and grows", () => {
  let list: Message[] = [];
  const feed = (item: unknown) => {
    const message = messageFromTurnItem(item);
    if (message) list = mergeItemMessage(list, message, itemTextOmitted(item));
  };
  feed(userItem);
  expect(list.map((entry) => `${entry.role}:${entry.body}`)).toEqual(["user:hello"]);
  feed(assistantItem("Hi", true));
  feed(assistantItem("Hi there", true));
  expect(list.map((entry) => `${entry.role}:${entry.body}:${entry.streaming}`)).toEqual(["user:hello:false", "assistant:Hi there:true"]);
  feed(assistantItem("Hi there!", false));
  expect(list[1].body).toBe("Hi there!");
  expect(list[1].streaming).toBe(false);
});

test("the message record keeps its creation time and attachments, the turn item supplies the text", () => {
  const record: Message = { id: "msg-a", role: "assistant", body: "Hi", order: 111, streaming: true, attachments: [{ id: "a", name: "n", mimeType: "text/plain", sizeBytes: 1, type: "file" }] };
  const merged = mergeItemMessage([record], messageFromTurnItem(assistantItem("Hi there", true))!, false);
  expect(merged[0]).toMatchObject({ body: "Hi there", order: 111, streaming: true });
  expect(merged[0].attachments?.length).toBe(1);
});

test("a deduped turn item keeps the text the message record already delivered", () => {
  const record: Message = { id: "msg-a", role: "assistant", body: "Full text", order: 5, streaming: false };
  const omitted = { ...assistantItem("", false), textOmitted: true };
  const merged = mergeItemMessage([record], messageFromTurnItem(omitted)!, itemTextOmitted(omitted));
  expect(merged[0].body).toBe("Full text");
});

test("a queued user message retains its text for the queue and later promotion", () => {
  expect(messageFromTurnItem({ ...userItem, inputIntent: "queued_turn", status: "pending" })?.body).toBe("hello");
  expect(messageFromTurnItem({ ...base, id: "x", type: "command_execution" })).toBe(null);
});

test("working follows the run lifecycle and stops when the run completes", () => {
  const t = (iso: string) => Date.parse(iso);
  expect(deriveWorking([run("starting")], false, false)).toEqual({ working: true, startedAt: t("2026-06-20T00:00:01.000Z") });
  expect(deriveWorking([run("running", { workStartedAt: "2026-06-20T00:00:02.000Z" })], false, false).startedAt).toBe(t("2026-06-20T00:00:02.000Z"));
  // The shell row can lag behind: a completed run ends the working row.
  expect(deriveWorking([run("completed", { completedAt: "2026-06-20T00:00:09.000Z" })], true, false).working).toBe(false);
  expect(deriveWorking([run("failed")], true, false).working).toBe(false);
  expect(deriveWorking([run("waiting")], false, true).working).toBe(false);
  expect(deriveWorking([], true, false).working).toBe(true);
  expect(deriveWorking([], true, true).working).toBe(false);
  expect(activeRun([run("completed"), { ...run("running"), id: "run-2", ordinal: 2 }])?.id).toBe("run-2");
});

test("a run whose provider turn already ended is not working, so no Working or Thinking row follows", () => {
  const runs = [{ id: "r1", status: "running", ordinal: 1, startedAt: "2026-01-01T00:00:00.000Z", activeAttemptId: "att1" }];
  expect(deriveWorking(runs, true, false).working).toBe(true);
  const providerTurnEnded = (run: Record<string, unknown>) => run.id === "r1";
  expect(deriveWorking(runs, true, false, providerTurnEnded)).toEqual({ working: false, startedAt: null });
  const entries = [{ kind: "message" as const, id: "m1", order: 1, sequence: 0, message: { id: "m1", role: "user" as const, body: "hi", order: 1 } }];
  expect(buildTimelineRows(entries, deriveWorking(runs, true, false, providerTurnEnded).working).map((row) => row.kind)).toEqual(["entry"]);
  expect(buildTimelineRows(entries, deriveWorking(runs, true, false).working).map((row) => row.kind)).toEqual(["entry", "working", "thinking"]);
});

test("a turn item's status and update time reach the message for the status chip and its timestamp", () => {
  const message = messageFromTurnItem(assistantItem("Hi", true))!;
  expect(message.status).toBe("running");
  expect(message.updatedAt).toBe(Date.parse("2026-06-20T00:00:02.000Z"));
  const done = messageFromTurnItem({ ...assistantItem("Hi", false), updatedAt: "2026-06-20T00:00:09.000Z" })!;
  const merged = mergeItemMessage([message], done, false);
  expect(merged[0].status).toBe("completed");
  expect(merged[0].updatedAt).toBe(Date.parse("2026-06-20T00:00:09.000Z"));
});

test("turn-item ordering survives message-first delivery and unchanged text", () => {
  const message: Message = { id: "msg-a", role: "assistant", body: "Hi", order: 111, streaming: true, attachments: [] };
  const item = messageFromTurnItem(assistantItem("Hi", true))!;
  const merged = mergeItemMessage([message], item, false);
  expect(merged[0].ordinal).toBe(3);
  expect(mergeItemMessage(merged, { ...item }, false)[0].ordinal).toBe(3);
});
