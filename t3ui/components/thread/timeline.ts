import type { ActivityItem, Message } from "../../store";

export type TimelineEntry =
  | { kind: "message"; id: string; order: number; ordinal?: number; sequence: number; message: Message }
  | { kind: "activity"; id: string; order: number; ordinal?: number; sequence: number; activity: ActivityItem };

function timestampOrLast(value: number | undefined) {
  return value !== undefined && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

export function mergeTimeline(messages: Message[], activity: ActivityItem[], runs: readonly Record<string, unknown>[] = []): TimelineEntry[] {
  const queuedIds = new Set(runs.filter((run) => run.status === "queued" && typeof run.userMessageId === "string").map((run) => run.userMessageId));
  const foldedAnswerIds = new Set(activity.flatMap((entry) => {
    if (entry.type !== "user_input_request" || !entry.item || !("questionAnswer" in entry.item)) return [];
    const answer = entry.item.questionAnswer;
    if (!answer || typeof answer !== "object" || !("requestId" in answer) || typeof answer.requestId !== "string") return [];
    return [`async-answer:${answer.requestId}`];
  }));
  const visibleMessages = messages.filter((message) => !queuedIds.has(message.id) && !foldedAnswerIds.has(message.id));
  const rows: TimelineEntry[] = [
    ...visibleMessages.map((message, sequence) => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      order: timestampOrLast(message.order),
      ordinal: message.ordinal,
      sequence,
      message,
    })),
    ...activity.map((item, index) => ({
      kind: "activity" as const,
      id: `activity:${item.id}`,
      order: timestampOrLast(item.order),
      ordinal: item.ordinal,
      sequence: visibleMessages.length + index,
      activity: item,
    })),
  ];
  // An optimistic send has no ordinal yet and is the newest thing in the thread: it goes last, in the order it was sent.
  const isPending = (row: TimelineEntry) => row.kind === "message" && row.message.pending === true;
  const settled = rows.filter((row) => !isPending(row));
  const chronological = (a: TimelineEntry, b: TimelineEntry) => a.order - b.order || a.sequence - b.sequence;
  const numbered = settled.filter((row) => row.ordinal !== undefined)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.sequence - b.sequence);
  const unnumbered = settled.filter((row) => row.ordinal === undefined).sort(chronological);
  // message.updated can precede its numbered turn item. That temporary gap must
  // never switch the entire transcript back to timestamp ordering. Keep the server
  // order and insert only the unnumbered records using their creation times.
  // A prefix maximum permits binary search even when server timestamps move backwards.
  let latest = 0;
  const timestamps = numbered.map((row) => (latest = Math.max(latest, row.order)));
  const merged: TimelineEntry[] = [];
  let copied = 0;
  for (const row of unnumbered) {
    let low = 0;
    let high = timestamps.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (timestamps[middle] <= row.order) low = middle + 1;
      else high = middle;
    }
    while (copied < low) merged.push(numbered[copied++]);
    merged.push(row);
  }
  while (copied < numbered.length) merged.push(numbered[copied++]);
  return [...merged, ...rows.filter(isPending)];
}

export function messageEntry(entry: TimelineEntry) {
  return entry.kind === "message" ? entry.message : undefined;
}

export function activityEntry(entry: TimelineEntry) {
  return entry.kind === "activity" ? entry.activity : undefined;
}
