import { expect, test } from "nsh/test";
import type { ActivityItem, Message } from "../../../store";
import { mergeTimeline } from "../timeline";
import { foldCompletedTurns, foldHiding, formatDuration } from "./turnFolds";
import { buildTimelineRows } from "./workLog";
import { activityFromTurnItem } from "./ingestActivity";
import { readMessage } from "../../../store";

const msg = (id: string, role: "user" | "assistant", order: number, extra: Partial<Message> = {}): Message => ({ id, role, body: id, order, ...extra });
const act = (id: string, order: number, extra: Partial<ActivityItem> = {}): ActivityItem => ({ id, type: "command_execution", title: "Command", detail: "ls", status: "completed", order, ...extra });

function fold(messages: Message[], activity: ActivityItem[], running = false, expanded: Record<string, boolean> = {}) {
  return foldCompletedTurns(buildTimelineRows(mergeTimeline(messages, activity), running), { running, expanded });
}
const kinds = (rows: ReturnType<typeof fold>) => rows.map((row) => (row.kind === "entry" ? row.id : row.kind === "fold" ? `fold:${row.label}` : `${row.kind}`));

test("formatDuration matches the web app", () => {
  expect(formatDuration(450)).toBe("450ms");
  expect(formatDuration(2400)).toBe("2.4s");
  expect(formatDuration(13_000)).toBe("13s");
  expect(formatDuration(59_500)).toBe("1m");
  expect(formatDuration(65_000)).toBe("1m 5s");
  expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
});

test("a finished turn folds its work under Worked for <duration>, leaving the prompt and the final reply", () => {
  const rows = fold(
    [msg("u1", "user", 1000), msg("a1", "assistant", 14_000)],
    [act("c1", 3000), act("c2", 9000)],
  );
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 13s", "message:a1"]);
  expect(rows[1]).toMatchObject({ kind: "fold", expanded: false });
});

test("opening the fold shows the grouped work entries in place", () => {
  const rows = fold(
    [msg("u1", "user", 1000), msg("a1", "assistant", 14_000)],
    [act("c1", 3000), act("c2", 9000)],
    false,
    { "turn-fold:message:u1": true },
  );
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 13s", "work", "message:a1"]);
  expect(rows[1]).toMatchObject({ expanded: true });
});

test("intermediate replies before the final one fold with the work", () => {
  const rows = fold(
    [msg("u1", "user", 1000), msg("a1", "assistant", 4000), msg("a2", "assistant", 20_000)],
    [act("c1", 3000), act("c2", 9000, { type: "file_change" })],
  );
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 19s", "message:a2"]);
});

test("the live turn stays expanded while earlier finished turns fold", () => {
  const rows = fold(
    [msg("u1", "user", 1000), msg("a1", "assistant", 14_000), msg("u2", "user", 20_000)],
    [act("c1", 3000), act("c3", 22_000, { status: "inProgress" })],
    true,
  );
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 13s", "message:a1", "message:u2", "working", "live"]);
});

test("a failed turn, a streaming reply and a turn with no tool work stay open", () => {
  expect(kinds(fold([msg("u1", "user", 1000), msg("a1", "assistant", 5000)], [act("c1", 3000, { status: "failed" })]))).toEqual(["message:u1", "work", "message:a1"]);
  expect(kinds(fold([msg("u1", "user", 1000), msg("a1", "assistant", 5000, { streaming: true })], [act("c1", 3000)]))).toEqual(["message:u1", "work", "message:a1"]);
  expect(kinds(fold([msg("u1", "user", 1000), msg("a1", "assistant", 5000)], []))).toEqual(["message:u1", "message:a1"]);
});

test("plans and notices are cards a fold never hides; a turn without timestamps reads Worked", () => {
  const rows = fold(
    [msg("u1", "user", 1000), msg("a1", "assistant", 9000)],
    [act("c1", 3000), act("p1", 4000, { type: "proposed_plan", detail: "# Plan" }), act("n1", 5000, { type: "system_notice", title: "Context compacted" })],
  );
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 8s", "plan", "divider", "message:a1"]);
  const bare = fold([{ id: "u1", role: "user", body: "x" }, { id: "a1", role: "assistant", body: "y" }], [{ id: "c1", type: "command_execution", title: "Command", detail: "ls", status: "completed", order: 0 }]);
  expect(bare.some((row) => row.kind === "fold" && row.label === "Worked")).toBe(true);
});

test("foldHiding names the fold a hidden row sits under", () => {
  const entries = [
    { kind: "message" as const, id: "m1", order: 1000, sequence: 0, message: { id: "m1", role: "user" as const, body: "go", order: 1000 } },
    { kind: "activity" as const, id: "act1", order: 2000, sequence: 1, activity: { id: "c1", type: "command_execution", title: "Command", detail: "ls", status: "completed", order: 2000 } },
    { kind: "message" as const, id: "m2", order: 3000, sequence: 2, message: { id: "m2", role: "assistant" as const, body: "done", order: 3000 } },
  ];
  const rows = buildTimelineRows(entries, false);
  const work = rows.find((row) => row.kind === "work")!;
  expect(foldHiding(rows, work.id, false)).toBe("turn-fold:m1");
  expect(foldHiding(rows, "m2", false)).toBeNull();
  expect(foldHiding(rows, "missing", false)).toBeNull();
});

// The server's restart continuation (RestartContinuation.ts): a notification turn item, plus the same message as a record with `notification`.
const restartItem = (id: string, at: string) => ({
  id, threadId: "t1", runId: "r2", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 5, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at, type: "notification",
  source: { kind: "system" }, outcome: "updated", summary: "R3 Code restarted and resumed this turn", detail: "Continue where you left off.",
});
const noticeActivity = (id: string, at: string, order: number): ActivityItem => {
  const item = activityFromTurnItem(restartItem(id, at), order);
  if (!item) throw new Error("no activity");
  return item;
};

test("a restart notification is its own row, titled with the summary, and starts a response", () => {
  const item = noticeActivity("n1", "2026-01-01T00:00:10Z", 10_000);
  expect(item).toMatchObject({ type: "notification", title: "R3 Code restarted and resumed this turn", notice: { source: "system", outcome: "updated" } });
  const rows = fold([msg("u1", "user", 1000)], [item, act("c1", 12_000)]);
  expect(kinds(rows)).toEqual(["message:u1", "notice", "fold:Worked for 2s"]);
});

test("two restart notices in a row stay as rows and never read Worked for 1ms", () => {
  const rows = fold([msg("u1", "user", 1000)], [noticeActivity("n1", "2026-01-01T00:00:10Z", 10_000), noticeActivity("n2", "2026-01-01T00:00:11Z", 11_000)]);
  expect(kinds(rows)).toEqual(["message:u1", "notice", "notice"]);
});

test("an interrupted turn is never folded", () => {
  const interrupted = act("i1", 5000, { type: "run_interrupt_result", title: "Run interrupted", detail: "Stopped by user" });
  const rows = fold([msg("u1", "user", 1000), msg("a1", "assistant", 9000)], [act("c1", 3000), interrupted]);
  expect(rows.some((row) => row.kind === "fold")).toBe(false);
});

test("a message record that carries a notification is not a transcript bubble", () => {
  expect(readMessage({ id: "m1", role: "user", text: "Continue where you left off.", createdAt: "2026-01-01T00:00:10Z", notification: { source: { kind: "system" }, outcome: "updated", summary: "R3 Code restarted and resumed this turn" } })).toBeNull();
  expect(readMessage({ id: "m2", role: "user", text: "hi", createdAt: "2026-01-01T00:00:10Z" })).toMatchObject({ id: "m2", body: "hi" });
});

test("a steer splits the run: the top fold keeps the whole run's time, work after the steer folds under Continued for", () => {
  const messages = [
    msg("u1", "user", 1000),
    msg("s1", "user", 10_000, { inputIntent: "steer" }),
    msg("a1", "assistant", 40_000),
  ];
  const rows = fold(messages, [act("c1", 3000), act("c2", 12_000), act("c3", 20_000)]);
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 39s", "message:s1", "fold:Continued for 30s", "message:a1"]);
  expect(rows[1]).toMatchObject({ kind: "fold", id: "turn-fold:message:u1", createdAt: 1000 });
  expect(rows[3]).toMatchObject({ kind: "fold", id: "turn-fold:message:s1", createdAt: 10_000 });
});

test("each steer segment opens on its own", () => {
  const messages = [msg("u1", "user", 1000), msg("s1", "user", 10_000, { inputIntent: "promoted_queued_to_steer" }), msg("a1", "assistant", 40_000)];
  const activity = [act("c1", 3000), act("c2", 12_000)];
  const rows = fold(messages, activity, false, { "turn-fold:message:s1": true });
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 39s", "message:s1", "fold:Continued for 30s", "work", "message:a1"]);
});

test("a steer segment with no work to hide gets no fold, and a steer never starts a new turn", () => {
  const messages = [msg("u1", "user", 1000), msg("s1", "user", 5000, { inputIntent: "steer" }), msg("a1", "assistant", 9000)];
  const rows = fold(messages, [act("c1", 3000)]);
  expect(kinds(rows)).toEqual(["message:u1", "fold:Worked for 8s", "message:s1", "message:a1"]);
});

test("an interrupted latest run reads You stopped after <duration>, from the run's own times when it has them", () => {
  const built = buildTimelineRows(mergeTimeline([msg("u1", "user", 1000), msg("a1", "assistant", 14_000)], [act("c1", 3000)]), false);
  const stopped = foldCompletedTurns(built, { running: false, expanded: {}, latestRun: { status: "interrupted", startedAt: 1000, completedAt: 8000 } });
  expect(stopped.find((row) => row.kind === "fold")).toMatchObject({ label: "You stopped after 7s" });
  const noTimes = foldCompletedTurns(buildTimelineRows(mergeTimeline([msg("u1", "user", 0), msg("a1", "assistant", 0)], [act("c1", 0)]), false), { running: false, expanded: {}, latestRun: { status: "interrupted", startedAt: null, completedAt: null } });
  expect(noTimes.find((row) => row.kind === "fold")).toMatchObject({ label: "You stopped this response" });
  const completed = foldCompletedTurns(built, { running: false, expanded: {}, latestRun: { status: "completed", startedAt: 1000, completedAt: 8000 } });
  expect(completed.find((row) => row.kind === "fold")).toMatchObject({ label: "Worked for 7s" });
});

test("only the latest turn takes the interrupted label", () => {
  const messages = [msg("u1", "user", 1000), msg("a1", "assistant", 5000), msg("u2", "user", 20_000), msg("a2", "assistant", 30_000)];
  const rows = foldCompletedTurns(buildTimelineRows(mergeTimeline(messages, [act("c1", 2000), act("c2", 22_000)]), false), { running: false, expanded: {}, latestRun: { status: "interrupted", startedAt: null, completedAt: null } });
  expect(rows.filter((row) => row.kind === "fold").map((row) => (row as { label: string }).label)).toEqual(["Worked for 4s", "You stopped after 10s"]);
});

test("a completed server run folds failed commands and keeps both steer messages between their own work summaries", () => {
  const runId = "run:completed-with-steers";
  const messages = [msg("prompt", "user", 1000, { runId }), msg("progress", "assistant", 4000, { runId }),
    msg("steer-1", "user", 10_000, { runId, inputIntent: "steer" }), msg("progress-2", "assistant", 15_000, { runId }),
    msg("steer-2", "user", 20_000, { runId, inputIntent: "promoted_queued_to_steer" }), msg("final", "assistant", 30_000, { runId })];
  const rows = foldCompletedTurns(buildTimelineRows(mergeTimeline(messages, [act("failed-command", 3000, { status: "failed" }), act("tool-2", 12_000), act("tool-3", 25_000)]), false), {
    running: false, expanded: {}, runStates: new Map([[runId, { status: "completed", startedAt: 1000, completedAt: 31_000 }]]),
  });
  expect(kinds(rows)).toEqual(["message:prompt", "fold:Worked for 30s", "message:steer-1", "fold:Continued for 5s", "message:steer-2", "fold:Continued for 10s", "message:final"]);
});
