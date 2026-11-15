import { expect, test } from "nsh/test";
import { buildTimelineRows, type WorkItem } from "./workLog";
import type { TimelineEntry } from "../timeline";
import { claudeResumeCompactionAge, idleCompactionOf } from "./idleCompaction";

const compaction = (id: string, runId: string, status = "completed"): WorkItem => ({ id, type: "compaction", title: "compaction", detail: "", status, item: { id, type: "compaction", runId } as never });
const activity = (it: WorkItem, order: number): TimelineEntry => ({ kind: "activity", id: `activity:${it.id}`, order, sequence: order, activity: { ...it, order } });
const userMessage = (id: string, body: string, order: number, extra: Record<string, unknown> = {}): TimelineEntry => ({ kind: "message", id: `message:${id}`, order, sequence: order, message: { id, role: "user", body, order, ...extra } as never });
const lifecycle = (before: number, after: number) => () => ({ status: "completed", beforeTokenCount: before, afterTokenCount: after });
const QUESTION = "This session is 2h 5m old and uses 412,300 tokens. Compact it before continuing?";

test("idleCompactionOf reads the field, falls back to agent/server for older servers, ignores user /compact", () => {
  expect(idleCompactionOf({ body: "/compact", idleCompaction: "onReturn" })).toBe("onReturn");
  expect(idleCompactionOf({ body: "/compact", createdBy: "agent", creationSource: "server" })).toBe("beforeCacheExpires");
  expect(idleCompactionOf({ body: "/compact" })).toBe(undefined);
  expect(idleCompactionOf({ body: "/compact", attachments: [{}], idleCompaction: "onReturn" })).toBe(undefined);
});

test("claudeResumeCompactionAge needs the compact answer to the resume question", () => {
  expect(claudeResumeCompactionAge({ answers: { q1: "Compact and continue" }, questionTextById: { q1: QUESTION }, attachmentsByQuestionId: {} })).toBe("2h 5m");
  expect(claudeResumeCompactionAge({ answers: { q1: "Don't ask again" }, questionTextById: { q1: QUESTION }, attachmentsByQuestionId: {} })).toBe(null);
  expect(claudeResumeCompactionAge({ answers: { [QUESTION]: ["Compact and continue"] }, attachmentsByQuestionId: {} })).toBe("2h 5m");
});

test("idle compactions title their divider; a resume compaction says how long the session was idle and folds its question", () => {
  const question: WorkItem = { id: "q", type: "user_input_request", title: "Question", detail: "", status: "completed", item: { id: "q", type: "user_input_request", runId: "run-3", questionAnswer: { answers: { q1: "Compact and continue" }, questionTextById: { q1: QUESTION }, attachmentsByQuestionId: {} } } as never };
  const rows = buildTimelineRows([
    userMessage("a", "/compact", 1, { runId: "run-1", idleCompaction: "beforeCacheExpires" }),
    activity(compaction("c1", "run-1"), 2),
    userMessage("b", "/compact", 3, { runId: "run-2", idleCompaction: "onReturn" }),
    activity(compaction("c2", "run-2"), 4),
    userMessage("c", "continue please", 5, { runId: "run-3" }),
    activity(question, 6),
    activity(compaction("c3", "run-3"), 7),
    userMessage("d", "/compact", 8, { runId: "run-4" }),
    activity(compaction("c4", "run-4"), 9),
  ], false, null, { lifecycle: lifecycle(120_000, 40_000) });
  const labels = rows.flatMap((row) => (row.kind === "divider" ? [row.label] : []));
  expect(labels).toEqual([
    "Context automatically compacted before cache expiry 120K → 40K tokens",
    "Context compacted before sending 120K → 40K tokens",
    "Context compacted after 2h 5m idle 120K → 40K tokens",
    "Context compacted 120K → 40K tokens",
  ]);
  expect(rows.some((row) => row.kind === "work" && row.items.some((item) => item.id === "q"))).toBe(false);
});

test("a running idle compaction uses the reference's live label", () => {
  const rows = buildTimelineRows([
    userMessage("a", "/compact", 1, { runId: "run-1", idleCompaction: "beforeCacheExpires" }),
    activity(compaction("c1", "run-1", "inProgress"), 2),
  ], true, 1);
  const divider = rows.find((row) => row.kind === "divider" && row.id === "activity:c1");
  expect(divider?.kind === "divider" ? divider.label : null).toBe("Compacting before the cache expires…");
});
