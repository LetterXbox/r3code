import { expect, test } from "nsh/test";
import { noticeChildThreadId, threadReadLabel, threadReadTargetId, withVisibleControlCharacters } from "./TimelineRows";
import {
  settleSupersededReasoning, attachCreatedThreadSummaries, withoutStoppedCompactionInterrupts, withoutSubagentDelegationRows,
  buildTimelineRows, diffStat, formatElapsed, formatWorkingTimer, proposedPlanBody, proposedPlanTitle, splitCommandDetail,
  itemFailed, itemUsesDestructiveLabel, summarizeWorkGroup, workIconName, workRowLabel, type WorkItem,
} from "./workLog";
import type { TimelineEntry } from "../timeline";

const item = (id: string, type: string, detail = "", status = "completed"): WorkItem => ({ id, type, title: type, detail, status });
const activity = (it: WorkItem, order: number): TimelineEntry => ({ kind: "activity", id: `activity:${it.id}`, order, sequence: order, activity: { ...it, order } });
const message = (id: string, role: "user" | "assistant", order: number): TimelineEntry => ({ kind: "message", id: `message:${id}`, order, sequence: order, message: { id, role, body: id, order } });

test("failed commands remain identifiable without coloring their label as a severe error", () => {
  const failedCommand = item("command", "command_execution", "npm test", "failed");
  expect(itemFailed(failedCommand)).toBe(true);
  expect(itemUsesDestructiveLabel(failedCommand)).toBe(false);
  expect(itemUsesDestructiveLabel(item("error", "error", "failure", "failed"))).toBe(true);
});

test("command detail splits into the command and its output", () => {
  expect(splitCommandDetail("npm test\n\nAll passed\nok")).toEqual({ command: "npm test", output: "All passed\nok" });
  expect(splitCommandDetail("pwd")).toEqual({ command: "pwd", output: "" });
});

test("diff stat counts added and removed lines, not file headers", () => {
  expect(diffStat("--- a/x\n+++ b/x\n@@\n-old\n+new\n+more\n ctx")).toEqual({ added: 2, removed: 1 });
  expect(diffStat("just text")).toBeNull();
});

test("row labels follow the web app's phrasing", () => {
  expect(workRowLabel(item("1", "command_execution", "npm test\n\nok"))).toBe("npm test");
  expect(workRowLabel(item("2", "file_change", "src/a.ts\n\n+x"))).toBe("Edited src/a.ts");
  expect(workRowLabel(item("3", "file_change", "src/a.ts", "inProgress"))).toBe("Editing src/a.ts");
  expect(workRowLabel(item("4", "reasoning"))).toBe("Thought");
  expect(workRowLabel(item("5", "web_search"))).toBe("Searched the web");
  expect(workIconName("command_execution")).toBe("terminal");
  expect(workIconName("unknown")).toBe("wrench");
});

test("a group summary names its two leading actions and counts the rest", () => {
  const two = summarizeWorkGroup([item("1", "command_execution"), item("2", "command_execution"), item("3", "file_change")]);
  expect(two.summary).toBe("Ran 2 commands and changed 1 file");
  expect(two.hasFailure).toBe(false);
  expect(summarizeWorkGroup([item("1", "reasoning"), item("2", "reasoning")]).summary).toBe("Thought (×2)");
  const many = summarizeWorkGroup([item("1", "command_execution"), item("2", "file_change"), item("3", "web_search"), item("4", "dynamic_tool")]);
  expect(many.summary).toBe("Ran 1 command, changed 1 file, and performed 2 other actions");
  expect(summarizeWorkGroup([item("1", "command_execution", "", "failed")]).hasFailure).toBe(true);
  expect(summarizeWorkGroup([item("1", "command_execution", "", "failed"), item("2", "command_execution")]).hasFailure).toBe(false);
  expect(summarizeWorkGroup([item("1", "command_execution"), { ...item("2", "dynamic_tool"), toolName: "mcp__t3_code__t3_thread_read" }]).summary).toBe("Ran 1 command and read 1 thread");
});

test("a work summary counts a repeatedly edited file once", () => {
  const entries = [item("1", "command_execution"), item("2", "command_execution"), item("3", "file_change", "src/a.ts\n\n+first"), item("4", "file_change", "src/a.ts\n\n+second")];
  expect(summarizeWorkGroup(entries).summary).toBe("Ran 2 commands and changed 1 file");
});

test("elapsed time reads as 12s, 3m 05s and 1h 02m", () => {
  expect(formatElapsed(12_900)).toBe("12s");
  expect(formatElapsed(185_000)).toBe("3m 05s");
  expect(formatElapsed(3_720_000)).toBe("1h 02m");
  expect(formatElapsed(-5)).toBe("0s");
});

test("consecutive tool activity folds into one group between messages", () => {
  const rows = buildTimelineRows([
    message("q", "user", 1000),
    activity(item("a", "command_execution"), 2000),
    activity(item("b", "file_change"), 3000),
    message("r", "assistant", 4000),
    activity(item("c", "command_execution", "", "inProgress"), 5000),
  ], true);
  expect(rows.map((row) => row.kind)).toEqual(["entry", "working", "work", "entry", "live"]);
  const first = rows[2];
  expect(first.kind === "work" && first.items.length).toBe(2);
  expect(first.kind === "work" && first.active).toBe(false);
  const last = rows[4];
  expect(last.kind === "live" && last.active).toBe(true);
  const working = rows[1];
  expect(working.kind === "working" && working.since).toBe(1000);
});

test("plans, errors and notices break a group into their own rows", () => {
  const rows = buildTimelineRows([
    activity(item("a", "command_execution"), 1),
    activity(item("p", "proposed_plan", "# Plan\n\nDo it"), 2),
    activity(item("e", "error", "boom\nstack"), 3),
    activity(item("n", "compaction"), 4),
  ], false);
  expect(rows.map((row) => row.kind)).toEqual(["work", "plan", "divider", "divider"]);
  const error = rows[2];
  expect(error.kind === "divider" && error.tone).toBe("danger");
  expect(error.kind === "divider" && error.detail).toBe("boom");
});

test("plan title is the first heading and the body drops it", () => {
  expect(proposedPlanTitle("intro\n## Ship it\nbody")).toBe("Ship it");
  expect(proposedPlanTitle("no heading")).toBeNull();
  expect(proposedPlanBody("# Ship it\n\nbody")).toBe("body");
});

test("tool icons follow the web's work entry marks", () => {
  expect(workIconName("file_change")).toBe("square-pen");
  expect(workIconName("file_search")).toBe("search");
  expect(workIconName("web_search")).toBe("globe");
  expect(workIconName("subagent")).toBe("bot");
  expect(workIconName("todo_list")).toBe("list-todo");
  expect(workIconName("approval_request")).toBe("message-circle");
  expect(workIconName("dynamic_tool")).toBe("wrench");
});

test("a group takes its action's mark, or the hammer for a mix", () => {
  expect(summarizeWorkGroup([item("1", "command_execution"), item("2", "command_execution")]).icon).toBe("terminal");
  expect(summarizeWorkGroup([item("1", "file_change")]).icon).toBe("square-pen");
  expect(summarizeWorkGroup([item("1", "reasoning")]).icon).toBe("brain");
  expect(summarizeWorkGroup([item("1", "command_execution"), item("2", "file_change")]).icon).toBe("hammer");
});

test("a checkpoint item draws no row, and the working row counts from the run's start", () => {
  const rows = buildTimelineRows([
    message("q", "user", 1000),
    activity(item("a", "command_execution"), 2000),
    activity(item("k", "checkpoint"), 3000),
  ], true, 1500);
  expect(rows.map((row) => row.kind)).toEqual(["entry", "working", "live"]);
  const working = rows[1];
  expect(working.kind === "working" && working.since).toBe(1500);
});

test("the working timer reads 12s, then 1m 5s", () => {
  expect(formatWorkingTimer(4_900)).toBe("4s");
  expect(formatWorkingTimer(65_000)).toBe("1m 5s");
  expect(formatWorkingTimer(3_720_000)).toBe("1h 2m");
});

test("a secret request is a standalone row that closes the tool group around it, and a tool group is not folded into it", () => {
  const secret: WorkItem = { ...item("s1", "secret_request", "why", "completed"), secret: { threadId: "t", label: "Token", reason: "why", status: "pending" } };
  const rows = buildTimelineRows([activity(item("c1", "command_execution", "ls"), 1), activity(secret, 2), activity(item("c2", "command_execution", "pwd"), 3)], false);
  expect(rows.map((row) => row.kind)).toEqual(["work", "secret", "work"]);
});

test("a compaction mid-turn keeps the Working row and shows only its live divider", () => {
  const rows = buildTimelineRows([
    message("q", "user", 1000),
    activity(item("c", "compaction", "", "inProgress"), 2000),
  ], true, 1500);
  const working = rows.find((row) => row.kind === "working");
  expect(working?.kind === "working" && working.compacting).toBeFalsy();
  expect(working?.kind === "working" && working.since).toBe(1500);
  const divider = rows.find((row) => row.kind === "divider");
  expect(divider?.kind === "divider" && [divider.label, divider.compaction, divider.active]).toEqual(["Compacting context", true, true]);
});

test("a /compact run has no Working row, only the live divider", () => {
  const prompt: TimelineEntry = { kind: "message", id: "message:p", order: 1000, sequence: 1000, message: { id: "p", role: "user", body: "/compact", order: 1000 } };
  const rows = buildTimelineRows([prompt], true, 1500);
  expect(rows.map((row) => row.kind)).toEqual(["entry", "divider"]);
});

test("a running compaction shows no Thinking row", () => {
  const rows = buildTimelineRows([
    message("q", "user", 1000),
    activity(item("c", "compaction", "", "inProgress"), 2000),
  ], true, 1500);
  expect(rows.some((row) => row.kind === "thinking")).toBe(false);
});

test("an interrupted run's divider carries the stop mark and the server's message; a fork divider opens the thread it names", () => {
  const raw: Record<string, Record<string, unknown>> = {
    stop: { id: "stop", type: "run_interrupt_result", message: "Stopped by you at step 3" },
    fromRun: { id: "fromRun", type: "fork", source: { type: "run", threadId: "thread-source" } },
    toFork: { id: "toFork", type: "fork", source: { type: "thread" }, targetThreadId: "thread-fork" },
  };
  const rows = buildTimelineRows([
    activity(item("stop", "run_interrupt_result"), 1),
    activity(item("fromRun", "fork"), 2),
    activity(item("toFork", "fork"), 3),
  ], false, null, { lifecycle: (id) => raw[id] });
  const dividers = rows.flatMap((row) => (row.kind === "divider" ? [row] : []));
  expect(dividers[0]).toMatchObject({ label: "Run interrupted", detail: "Stopped by you at step 3", icon: "circle-stop", wrapDetail: true });
  expect(dividers[1]).toMatchObject({ label: "Forked from conversation", icon: "git-fork", action: { label: "Open source conversation", threadId: "thread-source" } });
  expect(dividers[2]).toMatchObject({ label: "Conversation fork", action: { label: "Open fork", threadId: "thread-fork" } });
});

test("without the server's item a fork divider keeps its plain label and no action", () => {
  const rows = buildTimelineRows([activity(item("f", "fork"), 1)], false);
  const divider = rows.find((row) => row.kind === "divider");
  expect(divider?.kind === "divider" && divider.label).toBe("Forked from conversation");
  expect(divider?.kind === "divider" && divider.action).toBe(undefined);
});

test("a finished compaction reads its token counts; a failed one says so with its summary, a stopped one that it stopped", () => {
  const raw: Record<string, Record<string, unknown>> = {
    done: { id: "done", type: "compaction", status: "completed", beforeTokenCount: 120_000, afterTokenCount: 40_000 },
    bare: { id: "bare", type: "compaction", status: "completed" },
    bad: { id: "bad", type: "compaction", status: "failed", summary: " Provider refused " },
    stop: { id: "stop", type: "compaction", status: "interrupted" },
  };
  const rows = buildTimelineRows(["done", "bare", "bad", "stop"].map((id, index) => activity(item(id, "compaction", "", raw[id].status === "failed" ? "failed" : raw[id].status === "interrupted" ? "interrupted" : "completed"), index + 1)), false, null, { lifecycle: (id) => raw[id] });
  const dividers = rows.flatMap((row) => (row.kind === "divider" ? [row] : []));
  expect(dividers.map((row) => row.label)).toEqual(["Context compacted 120K → 40K tokens", "Context compacted", "Context compaction failed", "Context compaction stopped"]);
  expect(dividers[2]).toMatchObject({ detail: "Provider refused", tone: "danger", icon: "circle-alert" });
  expect(dividers[0]).toMatchObject({ compaction: true, tone: "neutral" });
});

test("a created-thread divider carries Open chat for its target thread; a subagent notification names its child thread", () => {
  const created = { ...item("made", "thread_created"), item: { id: "made", type: "thread_created", targetThreadId: "thread-new" } as never };
  const rows = buildTimelineRows([activity(created, 1)], false);
  const divider = rows[0] as { kind: string; action?: { label: string; threadId: string } };
  expect(divider.kind).toBe("divider");
  expect(divider.action).toEqual({ label: "Open chat", threadId: "thread-new" });
  const bare = buildTimelineRows([activity(item("bare", "thread_created"), 1)], false)[0] as { action?: unknown };
  expect(bare.action).toBe(undefined);
  expect(noticeChildThreadId({ ...item("n", "notification"), item: { source: { kind: "subagent", childThreadId: "child-1" } } as never })).toBe("child-1");
  expect(noticeChildThreadId({ ...item("n", "notification"), item: { source: { kind: "delegated_task", childThreadId: "child-2" } } as never })).toBe("child-2");
  expect(noticeChildThreadId({ ...item("n", "notification"), item: { source: { kind: "command" } } as never })).toBe(undefined);
});

test("a t3_thread_read call links the thread it read: Read thread “<title>”", () => {
  const read = { ...item("r", "dynamic_tool"), item: { type: "dynamic_tool", toolName: "mcp__t3-code__t3_thread_read", input: { threadId: " thread-9 " } } as never };
  expect(threadReadTargetId(read)).toBe("thread-9");
  expect(threadReadTargetId({ ...item("x", "dynamic_tool"), item: { type: "dynamic_tool", toolName: "mcp__t3-code__t3_thread_send", input: { threadId: "a" } } as never })).toBe(null);
  expect(threadReadLabel("Read a T3 thread", { threadId: "thread-9", title: "Plan" })).toEqual({ threadId: "thread-9", title: "Plan", prefix: "Read thread" });
  expect(threadReadLabel("Reading a T3 thread", { threadId: "t", title: "P" })?.prefix).toBe("Reading thread");
  expect(threadReadLabel("Read a T3 thread", null)).toBe(null);
});

test("shell commands show control characters as Control Pictures", () => {
  expect(withVisibleControlCharacters("echo \u001b[31mred\u0007\u007f")).toBe("echo ␛[31mred␇␡");
  expect(withVisibleControlCharacters("a\tb\nc")).toBe("a\tb\nc");
});

test("a gitignore fence highlights as ini (MarkdownCodeBlock.logic's alias)", async () => {
  const { resolveLanguage } = await import("../markdown/highlight");
  expect(resolveLanguage("gitignore")).toBe("toml");
});

test("a reasoning item still running before later entries settles; the last one keeps running", () => {
  const thinking = activity({ ...item("r1", "reasoning", "", "running") }, 1);
  const later = activity(item("c1", "command_execution"), 2);
  const live = activity({ ...item("r2", "reasoning", "", "running") }, 3);
  const settled = settleSupersededReasoning([thinking, later, live]);
  expect((settled[0] as { activity: { status: string } }).activity.status).toBe("completed");
  expect((settled[2] as { activity: { status: string } }).activity.status).toBe("running");
});

test("a delegate_task call whose child has its own subagent card in the run is not drawn twice", () => {
  const delegate = activity({ ...item("d1", "dynamic_tool"), item: { id: "d1", type: "dynamic_tool", status: "completed", runId: "run-1", toolName: "mcp__t3-code__delegate_task", output: { content: [{ type: "text", text: JSON.stringify({ taskId: "child-1" }) }] } } as never }, 1);
  const card = activity({ ...item("s1", "subagent"), item: { id: "s1", type: "subagent", origin: "app_owned", runId: "run-1", subagentId: "child-1" } as never }, 2);
  const orphan = activity({ ...item("d2", "dynamic_tool"), item: { id: "d2", type: "dynamic_tool", status: "completed", runId: "run-1", toolName: "mcp__t3-code__delegate_task", output: { content: [{ type: "text", text: JSON.stringify({ taskId: "child-2" }) }] } } as never }, 3);
  expect(withoutSubagentDelegationRows([delegate, card, orphan]).map((entry) => entry.id)).toEqual(["activity:s1", "activity:d2"]);
});

test("a stopped /compact run shows only its compaction divider, not its interrupt result too", () => {
  const prompt: TimelineEntry = { kind: "message", id: "message:c", order: 1, sequence: 1, message: { id: "c", role: "user", body: "/compact", order: 1, runId: "run-c" } };
  const compaction = activity({ ...item("k", "compaction"), item: { id: "k", type: "compaction", runId: "run-c" } as never }, 2);
  const interrupt = activity({ ...item("i", "run_interrupt_result"), item: { id: "i", type: "run_interrupt_result", runId: "run-c" } as never }, 3);
  const other = activity({ ...item("j", "run_interrupt_result"), item: { id: "j", type: "run_interrupt_result", runId: "run-x" } as never }, 4);
  expect(withoutStoppedCompactionInterrupts([prompt, compaction, interrupt, other]).map((entry) => entry.id)).toEqual(["message:c", "activity:k", "activity:j"]);
});

test("a thread the run created is summarised again under the run's reply; a copy after the reply is dropped", () => {
  const created = { ...item("tc", "thread_created"), item: { id: "tc", type: "thread_created", targetThreadId: "t-new", runId: "run-1" } as never };
  const reply: TimelineEntry = { kind: "message", id: "message:a", order: 3, sequence: 3, message: { id: "a", role: "assistant", body: "done", order: 3, runId: "run-1" } };
  const rows = buildTimelineRows([activity(created, 1), reply], false);
  expect(attachCreatedThreadSummaries(rows).map((row) => row.id)).toEqual(["activity:tc", "message:a", "summary:activity:tc"]);
  const after = buildTimelineRows([reply, activity(created, 4)], false);
  expect(attachCreatedThreadSummaries(after).map((row) => row.id)).toEqual(["message:a", "summary:activity:tc"]);
});
