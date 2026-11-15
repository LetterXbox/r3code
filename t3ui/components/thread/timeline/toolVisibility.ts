// The "Tool calls in chat" setting (contracts settings.ts ToolCallVisibility), ported from the web app's
// MessagesTimeline.logic.ts timelineRowEntries and client-runtime work-log/presentation.ts
// workEntryHiddenByToolCallVisibility:
//   showAll         every row (the default).
//   hideSuccessful  the commands, edits, searches and tool calls that completed without failing are dropped; failures stay.
//   hideAll         those rows are dropped whatever their outcome.
//   zen             only final answers: an assistant message shows once it is the last reply of its response and the
//                   response is not still being answered; everything but approvals, questions, errors, compaction,
//                   notices and lifecycle cards is dropped, no turn folds, and the Thinking row previews the live answer.
// Approvals and questions are drawn by their own panels, so they are never filtered here.
import type { TimelineEntry } from "../timeline";
import { itemFailed } from "./workLog";
import { liveThoughtLine } from "./liveTurn";
import { isSteerIntent } from "./userMessagePresentation";

export type ToolCallVisibility = "showAll" | "hideSuccessful" | "hideAll" | "zen";

export function asToolCallVisibility(value: unknown): ToolCallVisibility {
  return value === "hideSuccessful" || value === "hideAll" || value === "zen" ? value : "showAll";
}

const HIDEABLE = new Set(["command_execution", "file_change", "file_search", "web_search", "dynamic_tool"]);
/** Items a zen timeline keeps: what needs the reader, and the cards that mark where the thread changed. */
const ZEN_KEPT = new Set(["compaction", "notification", "fork", "handoff", "thread_created", "run_interrupt_result", "user_input_request", "secret_request", "link_request", "proposed_plan", "checkpoint"]);

const isUser = (entry: TimelineEntry) => entry.kind === "message" && entry.message.role === "user";
/** timelineEntryStartsResponse: a user message that is not a steer, or a notification. */
const startsResponse = (entry: TimelineEntry) => (isUser(entry) && entry.kind === "message" && !isSteerIntent(entry.message.inputIntent)) || (entry.kind === "activity" && entry.activity.type === "notification");
const isAssistant = (entry: TimelineEntry) => entry.kind === "message" && entry.message.role === "assistant";

/** deriveTerminalAssistantMessageIds: the last assistant reply after each user message. */
function terminalAssistantIds(entries: readonly TimelineEntry[]): Set<string> {
  const last = new Map<number, string>();
  let response = 0;
  for (const entry of entries) {
    if (isUser(entry)) response += 1;
    else if (entry.kind === "message" && isAssistant(entry)) last.set(response, entry.message.id);
  }
  return new Set(last.values());
}

/** The entries the setting shows. `working` is a live turn; its answer is previewed, not shown, until it lands. */
/** deriveInFlightSteerAnswerIds: the first reply after a steer answers it, so zen shows it even mid-turn. */
export function inFlightSteerAnswerIds(entries: readonly TimelineEntry[]): Set<string> {
  const ids = new Set<string>();
  let awaitingReply = false;
  let candidate: string | null = null;
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.type === "reasoning") continue;
    const reply = entry.kind === "message" && entry.message.role === "assistant" ? entry : null;
    if (candidate !== null && reply !== null) ids.add(candidate);
    candidate = null;
    if (entry.kind === "message" && entry.message.role === "user" && isSteerIntent(entry.message.inputIntent)) awaitingReply = true;
    else if (entry.kind === "message" && entry.message.role === "user") awaitingReply = false;
    else if (reply !== null && awaitingReply) { candidate = reply.message.id; awaitingReply = false; }
  }
  return ids;
}

export function applyToolCallVisibility(entries: readonly TimelineEntry[], visibility: ToolCallVisibility, working: boolean, /** A message the reader was sent to (a citation's source): zen shows it. */ revealedMessageId: string | null = null): TimelineEntry[] {
  if (visibility === "showAll") return [...entries];
  if (visibility !== "zen") {
    return entries.filter((entry) => {
      if (entry.kind !== "activity" || !HIDEABLE.has(entry.activity.type)) return true;
      return visibility === "hideSuccessful" && !(entry.activity.status === "completed" && !itemFailed(entry.activity));
    });
  }
  const terminal = terminalAssistantIds(entries);
  let boundary = -1;
  entries.forEach((entry, index) => { if (startsResponse(entry)) boundary = index; });
  const answeringFrom = working ? boundary + 1 : entries.length;
  const steerAnswers = inFlightSteerAnswerIds(entries);
  return entries.filter((entry, index) => {
    if (entry.kind === "message") return entry.message.role !== "assistant" || entry.message.id === revealedMessageId || steerAnswers.has(entry.message.id) || (terminal.has(entry.message.id) && index < answeringFrom);
    const { type, status } = entry.activity;
    if (type === "error") return status !== "completed";
    return ZEN_KEPT.has(type);
  });
}

/** liveAnswerPreview: the latest line of the answer or thought in progress, shown in place of "Thinking" under zen. */
export function liveAnswerPreview(entries: readonly TimelineEntry[]): string | null {
  let boundary = -1;
  entries.forEach((entry, index) => { if (startsResponse(entry)) boundary = index; });
  for (let index = entries.length - 1; index > boundary; index -= 1) {
    const entry = entries[index];
    const text = entry.kind === "message" && entry.message.role === "assistant" ? entry.message.body : entry.kind === "activity" && entry.activity.type === "reasoning" ? entry.activity.detail : "";
    const line = liveThoughtLine(text);
    if (line !== "") return line;
  }
  return null;
}
