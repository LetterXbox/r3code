import { expect, test } from "nsh/test";
import { commandProgramName, deriveLiveRow, liveThoughtLine, liveWorkLabel, toolLifecycleStatus } from "./liveTurn";
import { buildTimelineRows, itemActive, type WorkItem } from "./workLog";
import { mergeTimeline } from "../timeline";
import { messageFromTurnItem } from "./ingest";

const base = { title: "", detail: "", status: "completed" };
const cmd = (id: string, command: string, status: string): WorkItem => ({ ...base, id, type: "command_execution", title: "Command", detail: command, status });
const think = (id: string, text: string, status: string): WorkItem => ({ ...base, id, type: "reasoning", title: "Reasoning", detail: text, status });

test("turn-item statuses map to the work log's lifecycle", () => {
  expect(toolLifecycleStatus("running")).toBe("inProgress");
  expect(toolLifecycleStatus("waiting")).toBe("inProgress");
  expect(toolLifecycleStatus("pending")).toBe("inProgress");
  expect(toolLifecycleStatus("completed")).toBe("completed");
  expect(toolLifecycleStatus("failed")).toBe("failed");
  expect(toolLifecycleStatus("cancelled")).toBe("stopped");
  expect(toolLifecycleStatus("interrupted")).toBe("stopped");
  expect(toolLifecycleStatus("idle")).toBe("idle");
});

test("commandProgramName reads the program through wrappers", () => {
  expect(commandProgramName("cat README.md")).toBe("cat");
  expect(commandProgramName("/bin/zsh -lc 'cat /tmp/x | head'")).toBe("cat");
  expect(commandProgramName("cd /repo && git status")).toBe("git");
  expect(commandProgramName("FOO=1 sudo -n npm test")).toBe("npm");
  expect(commandProgramName("")).toBe(null);
});

test("live file changes display their path", () => {
  const item: WorkItem = { ...base, id: "file", type: "file_change", title: "File change", detail: "t3ui/Sidebar.tsx\n\n+change", status: "running" };
  expect(liveWorkLabel(item, true)).toBe("t3ui/Sidebar.tsx");
});

test("live labels: Running while active, Ran when done, Failed / Stopped otherwise", () => {
  expect(liveWorkLabel(cmd("c", "cat x", "running"), true, "cat x")).toBe("Running cat");
  expect(liveWorkLabel(cmd("c", "cat x", "completed"), false, "cat x")).toBe("Ran cat");
  expect(liveWorkLabel(cmd("c", "cat x", "completed"), true, "cat x")).toBe("Running cat");
  expect(liveWorkLabel(cmd("c", "cat x", "failed"), true, "cat x")).toBe("Failed cat");
  expect(liveWorkLabel(cmd("c", "cat x", "cancelled"), false, "cat x")).toBe("Stopped cat");
  expect(liveWorkLabel(think("r", "", "running"), true)).toBe("Thinking");
  expect(liveWorkLabel(think("r", "", "completed"), false)).toBe("Thought");
});

test("liveThoughtLine takes the bold heading or the first sentence", () => {
  expect(liveThoughtLine("**Checking the server**\n\nLong body.")).toBe("Checking the server");
  expect(liveThoughtLine("I'm checking whether it ran at 18:13, against dist. Then more.")).toBe("I'm checking whether it ran at 18:13, against dist.");
});

test("the live row takes the running tool and the latest thought", () => {
  const items = [think("r1", "Looking.", "completed"), cmd("c1", "cat x", "running")];
  const { row } = deriveLiveRow("work:r1", items, itemActive);
  expect(row?.entry.id).toBe("c1");
  expect(row?.thought?.id).toBe("r1");
  expect(row?.active).toBe(true);
  expect(row?.id).toBe("live-activity");
});

test("a failed latest tool leaves the folded group and no live row", () => {
  const { row, failed } = deriveLiveRow("work:c1", [cmd("c1", "false", "failed")], itemActive);
  expect(row).toBe(null);
  expect(failed).toBe(true);
});

test("a running turn lists the prompt, the working row, then the live row", () => {
  const entries = mergeTimeline(
    [{ id: "u", role: "user", body: "go", order: 1000, streaming: false }],
    [
      { id: "r1", type: "reasoning", title: "Reasoning", detail: "Looking.", status: "running", order: 1100 },
      { id: "c1", type: "command_execution", title: "Command", detail: "cat x", status: "running", order: 1200 },
    ],
  );
  const rows = buildTimelineRows(entries, true, 1000);
  expect(rows.map((row) => row.kind)).toEqual(["entry", "working", "live"]);
});

test("a running turn with no tool activity shows the Thinking row", () => {
  const entries = mergeTimeline([{ id: "u", role: "user", body: "go", order: 1000, streaming: false }], []);
  expect(buildTimelineRows(entries, true, 1000).map((row) => row.kind)).toEqual(["entry", "working", "thinking"]);
});

test("runless subagent activity follows its working header", () => {
  const entries = mergeTimeline([], [
    { id: "cmd", type: "command_execution", title: "Command", detail: "ls", status: "completed", order: 1000 },
    { id: "thought", type: "reasoning", title: "Reasoning", detail: "Computing glove transforms", status: "running", order: 2000 },
  ]);
  const rows = buildTimelineRows(entries, true, 1000);
  expect(rows.map((row) => row.kind)).toEqual(["working", "live"]);
  const live = rows[1];
  expect(live?.kind === "live" ? live.thought?.detail : null).toBe("Computing glove transforms");
});

test("lifecycle items become dividers with the web's copy", () => {
  const entries = mergeTimeline([], [
    { id: "i", type: "run_interrupt_result", title: "Run interrupt result", detail: "", status: "completed", order: 1 },
    { id: "q", type: "run_interrupt_request", title: "x", detail: "", status: "completed", order: 2 },
    { id: "f", type: "fork", title: "Fork", detail: "", status: "completed", order: 3 },
  ]);
  const rows = buildTimelineRows(entries, false);
  expect(rows.map((row) => (row.kind === "divider" ? row.label : row.kind))).toEqual(["Run interrupted", "Forked from conversation"]);
});

test("every turn-item kind the server sends survives ingestion as an activity or a message", () => {
  const user = messageFromTurnItem({ type: "user_message", id: "a", messageId: "m1", text: "hi", status: "completed", inputIntent: "turn", startedAt: null, updatedAt: "2026-01-01T00:00:00Z" });
  expect(user?.body).toBe("hi");
});
