// The open thread's projection state the banners need and the store keeps private: the provider sessions' extension
// statuses (Pi's status line), and the runs and interrupt turn items that say whether a Stop is pending or unanswered
// (presentRunStop in client-runtime state/threadExecution.ts). Fed with each `orchestration.subscribeThread` item.
import { signal } from "nsh";

export interface SessionRecord { id: string; providerInstanceId: string; status: string; extensionStatuses: { key: string; text: string }[] }
export interface ProviderThreadRecord { id: string; providerSessionId: string | null; providerInstanceId: string }
export interface RunRecord { id: string; ordinal: number; status: string }
export interface InterruptItem { runId: string; type: "run_interrupt_request" | "run_interrupt_result"; startedAt: string | null; updatedAt: string | null; unresponsiveAt: string | null }

export interface ThreadSessionState {
  threadId: string | null;
  modelInstanceId: string | null;
  activeProviderThreadId: string | null;
  sessions: SessionRecord[];
  providerThreads: ProviderThreadRecord[];
  runs: RunRecord[];
  interrupts: InterruptItem[];
  /** Background tasks' turn items by task id (`nativeItemRef.nativeId || id`): when each started and what a subagent reports. */
  tasks: Record<string, TaskItem>;
}
export interface TaskItem { startedAt: string | null; progress: string | null }

const EMPTY: ThreadSessionState = { threadId: null, modelInstanceId: null, activeProviderThreadId: null, sessions: [], providerThreads: [], runs: [], interrupts: [], tasks: {} };
export const emptyBannerThreadState = (): ThreadSessionState => EMPTY;
const state = signal<ThreadSessionState>(EMPTY);
export const threadSessionState = () => state();
/** Puts back the state a thread had when it was left, so a resumed subscription (no new snapshot) starts from it. */
export function restoreBannerThreadState(saved: ThreadSessionState): void { state.set(saved); }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function readSession(value: unknown): SessionRecord | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  const statuses = Array.isArray(item.extensionStatuses) ? item.extensionStatuses.flatMap((entry) => {
    const status = record(entry);
    const key = text(status?.key);
    const label = text(status?.text);
    return key && label ? [{ key, text: label }] : [];
  }) : [];
  return { id, providerInstanceId: text(item.providerInstanceId) ?? "", status: text(item.status) ?? "", extensionStatuses: statuses };
}
function readProviderThread(value: unknown): ProviderThreadRecord | null {
  const item = record(value);
  const id = text(item?.id);
  return item && id ? { id, providerSessionId: text(item.providerSessionId), providerInstanceId: text(item.providerInstanceId) ?? "" } : null;
}
function readRun(value: unknown): RunRecord | null {
  const item = record(value);
  const id = text(item?.id);
  return item && id && typeof item.ordinal === "number" ? { id, ordinal: item.ordinal, status: text(item.status) ?? "" } : null;
}
function readInterrupt(value: unknown): InterruptItem | null {
  const item = record(value);
  const runId = text(item?.runId);
  if (!item || !runId || (item.type !== "run_interrupt_request" && item.type !== "run_interrupt_result")) return null;
  return { runId, type: item.type, startedAt: text(item.startedAt), updatedAt: text(item.updatedAt), unresponsiveAt: text(item.unresponsiveAt) };
}

function taskEntry(value: unknown): [string, TaskItem] | null {
  const item = record(value);
  if (!item || (item.type !== "command_execution" && item.type !== "subagent")) return null;
  const key = text(record(item.nativeItemRef)?.nativeId) ?? text(item.id);
  if (!key) return null;
  return [key, { startedAt: text(item.startedAt), progress: item.type === "subagent" ? text(item.progress)?.replace(/\s+/g, " ").trim() ?? null : null }];
}

function upsert<T extends { id: string }>(list: T[], next: T | null): T[] {
  if (!next) return list;
  return list.some((entry) => entry.id === next.id) ? list.map((entry) => (entry.id === next.id ? next : entry)) : [...list, next];
}
function all<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.flatMap((item) => { const parsed = read(item); return parsed ? [parsed] : []; }) : [];
}
function upsertInterrupt(list: InterruptItem[], next: InterruptItem | null): InterruptItem[] {
  if (!next) return list;
  const at = list.findIndex((entry) => entry.runId === next.runId && entry.type === next.type);
  return at < 0 ? [...list, next] : list.map((entry, index) => (index === at ? next : entry));
}

/** Folds a subscription item without changing the open thread's state. */
export function foldBannerThreadItem(threadId: string, current: ThreadSessionState, item: unknown): ThreadSessionState {
  const entry = record(item);
  if (!entry) return current;
  if (entry.kind === "snapshot") {
    const projection = record(entry.projection);
    if (!projection) return current;
    const thread = record(projection.thread);
    const turnItems = Array.isArray(projection.turnItems)
      ? projection.turnItems
      : Array.isArray(projection.visibleTurnItems) ? projection.visibleTurnItems.map((row) => record(row)?.item) : [];
    return {
      threadId,
      modelInstanceId: text(record(thread?.modelSelection)?.instanceId),
      activeProviderThreadId: text(thread?.activeProviderThreadId),
      sessions: all(projection.providerSessions, readSession),
      providerThreads: all(projection.providerThreads, readProviderThread),
      runs: all(projection.runs, readRun),
      interrupts: all(turnItems, readInterrupt),
      tasks: Object.fromEntries(turnItems.flatMap((row) => { const entry = taskEntry(row); return entry ? [entry] : []; })),
    };
  }
  if (entry.kind !== "event" || current.threadId !== threadId) return current;
  const event = record(entry.event);
  switch (event?.type) {
    case "provider-session.attached":
    case "provider-session.updated": return { ...current, sessions: upsert(current.sessions, readSession(event.payload)) };
    case "provider-session.detached": {
      const id = text(record(event.payload)?.id) ?? text(record(event.payload)?.providerSessionId);
      return id ? { ...current, sessions: current.sessions.filter((session) => session.id !== id) } : current;
    }
    case "provider-thread.updated": return { ...current, providerThreads: upsert(current.providerThreads, readProviderThread(event.payload)) };
    case "run.created":
    case "run.updated": return { ...current, runs: upsert(current.runs, readRun(event.payload)) };
    case "turn-item.updated": {
      const task = taskEntry(event.payload);
      return { ...current, interrupts: upsertInterrupt(current.interrupts, readInterrupt(event.payload)), tasks: task ? { ...current.tasks, [task[0]]: task[1] } : current.tasks };
    }
    case "thread.updated":
    case "thread.created": {
      const payload = record(event.payload);
      const active = text(payload?.activeProviderThreadId);
      const instance = text(record(payload?.modelSelection)?.instanceId);
      return active !== null || instance !== null ? { ...current, ...(active !== null ? { activeProviderThreadId: active } : {}), ...(instance !== null ? { modelInstanceId: instance } : {}) } : current;
    }
    default: return current;
  }
}

/** Folds one item into the currently open thread's banner state. */
export function observeBannerThreadItem(threadId: string, item: unknown): void {
  state.update((current) => foldBannerThreadItem(threadId, current, item));
}

export function resetBannerThreadState(): void {
  state.set(EMPTY);
}

/** deriveProviderExtensionStatuses: only the selected provider's current, unstopped session supplies a status. */
export function providerExtensionStatuses(s: ThreadSessionState): { key: string; text: string }[] {
  const instanceId = s.modelInstanceId;
  const active = s.providerThreads.find((thread) => thread.id === s.activeProviderThreadId);
  if (active && active.providerInstanceId !== instanceId) return [];
  const session = [...s.sessions].reverse().find((candidate) => candidate.providerInstanceId === instanceId && (!active || candidate.id === active.providerSessionId));
  return !session || session.status === "stopped" ? [] : session.extensionStatuses;
}

export interface RunStop { state: "stopping" | "unresponsive"; runId: string; requestedAt: string; background: boolean }

const INTERRUPTIBLE = new Set(["preparing", "starting", "running"]);

/** presentRunStop: a Stop the provider has not finished yet. */
export function presentRunStop(s: Pick<ThreadSessionState, "runs" | "interrupts">): RunStop | null {
  let active: RunRecord | null = null;
  let latest: RunRecord | null = null;
  for (const candidate of s.runs) {
    // Queued follow-ups never ran, so they hold no Stop of their own.
    if (candidate.status !== "queued" && candidate.ordinal > (latest?.ordinal ?? -1)) latest = candidate;
    if (INTERRUPTIBLE.has(candidate.status) && candidate.ordinal > (active?.ordinal ?? -1)) active = candidate;
  }
  const run = active ?? latest;
  if (!run) return null;
  let request: InterruptItem | undefined;
  for (const item of s.interrupts) {
    if (item.runId !== run.id) continue;
    if (item.type === "run_interrupt_result") return null;
    request = item;
  }
  if (!request || (!active && !request.unresponsiveAt)) return null;
  return {
    state: request.unresponsiveAt ? "unresponsive" : "stopping",
    runId: run.id,
    requestedAt: request.startedAt ?? request.updatedAt ?? new Date(0).toISOString(),
    background: !active,
  };
}
