// threadActivityAnnouncement.ts + ThreadActivityAnnouncer.tsx: what a screen reader hears when the open thread's turn
// changes state. The first snapshot of a thread is a silent baseline, so opening or switching threads never replays
// what already happened. The web writes into a polite live region; NSH speaks it with `announce`.
export type ThreadActivityStatus = "working" | "approval" | "input" | "idle";

export const THREAD_STATUS_TEXT = { approval: "Needs approval", input: "Needs your input", done: "Done", failed: "Failed", stopped: "Stopped" } as const;

export interface ThreadActivitySnapshot { status: ThreadActivityStatus; requestId: string | null; runId: string | null; runStatus: string | null }
export interface ThreadAnnouncementMemory { snapshot: ThreadActivitySnapshot; turnRunId: string | "unknown" | null; settledRunId: string | null; idleRunId: string | null }

const ACTIVE_RUN_STATUSES = new Set<string | null>(["preparing", "starting", "running", "waiting"]);
const STARTING_RUN_STATUSES = new Set<string | null>(["queued", "preparing", "starting"]);

export function runOutcomeText(status: string | null): string | null {
  switch (status) {
    case "completed": return THREAD_STATUS_TEXT.done;
    case "failed": return THREAD_STATUS_TEXT.failed;
    case "interrupted": case "cancelled": return THREAD_STATUS_TEXT.stopped;
    default: return null;
  }
}

export function nextThreadAnnouncement(previous: ThreadAnnouncementMemory | null, next: ThreadActivitySnapshot): { memory: ThreadAnnouncementMemory; announcement: string | null } {
  const idle = next.status === "idle";
  const idleRunId = idle && !STARTING_RUN_STATUSES.has(next.runStatus) ? next.runId : (previous?.idleRunId ?? null);
  const newRunId = !idle && ACTIVE_RUN_STATUSES.has(next.runStatus) && next.runId !== idleRunId ? next.runId : null;
  if (previous === null) {
    return {
      memory: { snapshot: next, turnRunId: idle ? null : (newRunId ?? "unknown"), settledRunId: runOutcomeText(next.runStatus) === null ? null : next.runId, idleRunId },
      announcement: null,
    };
  }
  const memory = { ...previous, snapshot: next, idleRunId };
  const { turnRunId } = previous;
  if (!idle) {
    const turnStarted = turnRunId === null || (newRunId !== null && turnRunId !== "unknown" && newRunId !== turnRunId);
    const nextTurnRunId = turnStarted || turnRunId === "unknown" ? (newRunId ?? "unknown") : turnRunId;
    const announcement = next.status === "approval"
      ? previous.snapshot.status === "approval" && previous.snapshot.requestId === next.requestId ? null : THREAD_STATUS_TEXT.approval
      : next.status === "input"
        ? previous.snapshot.status === "input" && previous.snapshot.requestId === next.requestId ? null : THREAD_STATUS_TEXT.input
        : turnStarted ? "Working" : null;
    return { memory: { ...memory, turnRunId: nextTurnRunId }, announcement };
  }
  const outcome = runOutcomeText(next.runStatus);
  if (turnRunId === null) return { memory: { ...memory, settledRunId: outcome === null ? previous.settledRunId : next.runId }, announcement: null };
  if (next.runStatus === "rolled_back") return { memory: { ...memory, turnRunId: null, settledRunId: next.runId }, announcement: null };
  if (outcome === null) return { memory, announcement: null };
  if (next.runId === previous.settledRunId) return { memory: { ...memory, turnRunId: null }, announcement: null };
  if (turnRunId === "unknown" && next.runId === previous.idleRunId) return { memory: { ...memory, settledRunId: next.runId }, announcement: null };
  return { memory: { ...memory, turnRunId: null, settledRunId: next.runId }, announcement: outcome };
}

/** ThreadActivityAnnouncer: one announcer per thread view; a new thread key resets to a silent baseline. */
export function createThreadActivityAnnouncer(say: (message: string) => void) {
  let state: { threadKey: string; memory: ThreadAnnouncementMemory } | null = null;
  return (threadKey: string | null, snapshot: ThreadActivitySnapshot) => {
    if (threadKey === null) { state = null; return; }
    const previous = state?.threadKey === threadKey ? state.memory : null;
    const { memory, announcement } = nextThreadAnnouncement(previous, snapshot);
    state = { threadKey, memory };
    if (previous !== null && announcement !== null) say(announcement);
  };
}
