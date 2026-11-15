import { expect, test } from "nsh/test";
import { mergeTimeline } from "../timeline";
import { applyToolCallVisibility, asToolCallVisibility, liveAnswerPreview } from "./toolVisibility";
import { buildTimelineRows } from "./workLog";
import type { ActivityItem, Message } from "../../../store";

const messages: Message[] = [
  { id: "u1", role: "user", body: "go", order: 1 },
  { id: "a1", role: "assistant", body: "Working on it.", order: 5 },
  { id: "a2", role: "assistant", body: "All done.", order: 9 },
  { id: "u2", role: "user", body: "more", order: 10 },
  { id: "a3", role: "assistant", body: "**Checking the logs**\n\nLooking.", order: 14, streaming: true },
];
const act = (id: string, type: string, status: string, order: number): ActivityItem => ({ id, type, title: type, detail: "x", status, order });
const activity = [
  act("c1", "command_execution", "completed", 2),
  act("c2", "command_execution", "failed", 3),
  act("r1", "reasoning", "completed", 4),
  act("e1", "error", "failed", 6),
  act("k1", "compaction", "completed", 7),
  act("s1", "subagent", "completed", 8),
];
const entries = mergeTimeline(messages, activity);
const ids = (list: ReturnType<typeof applyToolCallVisibility>) => list.map((entry) => (entry.kind === "message" ? entry.message.id : entry.activity.id));

test("showAll keeps every row; unknown values read as showAll", () => {
  expect(asToolCallVisibility(undefined)).toBe("showAll");
  expect(ids(applyToolCallVisibility(entries, "showAll", false)).length).toBe(entries.length);
});

test("hideSuccessful drops completed tool calls and keeps failures", () => {
  const shown = ids(applyToolCallVisibility(entries, "hideSuccessful", false));
  expect(shown).not.toContain("c1");
  expect(shown).toContain("c2");
  expect(shown).toContain("r1");
});

test("hideAll drops every tool call, failed or not, and keeps reasoning, errors and replies", () => {
  const shown = ids(applyToolCallVisibility(entries, "hideAll", false));
  expect(shown).not.toContain("c1");
  expect(shown).not.toContain("c2");
  expect(shown).toContain("e1");
  expect(shown).toContain("a1");
});

test("zen shows final answers, errors and compaction only; a live reply waits", () => {
  const shown = ids(applyToolCallVisibility(entries, "zen", true));
  expect(shown).toEqual(["u1", "e1", "k1", "a2", "u2"]);
  const settled = ids(applyToolCallVisibility(entries, "zen", false));
  expect(settled).toContain("a3");
  expect(settled).not.toContain("a1");
});

test("zen previews the live answer and has no work groups", () => {
  expect(liveAnswerPreview(entries)).toBe("Checking the logs");
  const rows = buildTimelineRows(applyToolCallVisibility(entries, "zen", false), false);
  expect(rows.some((row) => row.kind === "work")).toBe(false);
});

test("a running compaction shows its live divider, not a Compacting working row; a preparing run says so", () => {
  // MessagesTimeline.logic.ts: mid-turn the working row keeps counting the turn (since: the turn's start), the compaction
  // is its divider; a `/compact` run has no working row at all, only the pending divider.
  const compaction: ActivityItem = { id: "k", type: "compaction", title: "Compacting", detail: "", status: "running", order: 2000, startedAt: 20_000 };
  const base = mergeTimeline([{ id: "u", role: "user", body: "go", order: 1000 }], [compaction]);
  const rows = buildTimelineRows(base, true, 1000);
  expect(rows.find((row) => row.kind === "working")).toMatchObject({ since: 1000 });
  expect("compacting" in rows.find((row) => row.kind === "working")!).toBe(false);
  expect(rows.find((row) => row.kind === "divider")).toMatchObject({ label: "Compacting context", compaction: true, active: true });
  const prepared = buildTimelineRows(mergeTimeline([{ id: "u", role: "user", body: "go", order: 1000 }], []), true, 1000, { preparingWorktree: true });
  expect(prepared.find((row) => row.kind === "working")).toMatchObject({ preparing: true });
  expect(prepared.some((row) => row.kind === "thinking")).toBe(false);
  const command = buildTimelineRows(mergeTimeline([{ id: "u", role: "user", body: "/compact", order: 1000 }], []), true, 1000);
  expect(command.some((row) => row.kind === "working")).toBe(false);
  expect(command.find((row) => row.kind === "divider")).toMatchObject({ label: "Compacting context", compaction: true, active: true });
});

test("zen keeps the reply to a steer mid-turn and a message the reader was sent to", () => {
  const thread: Message[] = [
    { id: "u1", role: "user", body: "go", order: 1 },
    { id: "a1", role: "assistant", body: "draft", order: 2 },
    { id: "s1", role: "user", body: "focus on tests", order: 3, inputIntent: "steer" },
    { id: "a2", role: "assistant", body: "Ok, tests first.", order: 4 },
    { id: "a3", role: "assistant", body: "still going", order: 5, streaming: true },
  ];
  const ids = (revealed: string | null) => applyToolCallVisibility(mergeTimeline(thread, []), "zen", true, revealed).map((entry) => entry.id);
  expect(ids(null)).toEqual(["message:u1", "message:s1", "message:a2"]);
  expect(ids("a1")).toEqual(["message:u1", "message:a1", "message:s1", "message:a2"]);
});
