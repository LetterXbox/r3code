// The open thread's provider-side state the composer needs and the thread subscription already
// delivers: provider sessions (their turn capabilities), provider threads and provider turns
// (token usage). Ports of deriveThreadQueueWorkflowState's steering rule (client-runtime
// state/threadWorkflows.ts) and of shouldOfferResumeCompaction / deriveLatestContextWindowSnapshot
// (state/contextWindow.ts). Imports nothing from the store, which feeds it from its event handler.
import { signal } from "nsh";

export interface ProviderSessionInfo { id: string; status: string; supportsActiveSteering: boolean; supportsSteeringByInterruptRestart: boolean }
export interface ProviderThreadInfo {
  id: string; appThreadId: string; providerSessionId: string | null; updatedAt: string | null;
  contextUsage: TokenUsage | null;
}
export interface TokenUsage { usedTokens: number; maxTokens: number | null; updatedAt: string; promptCacheTtlMs: number | null }
export interface ProviderTurnInfo { id: string; providerThreadId: string; runAttemptId: string | null; status: string; tokenUsage: TokenUsage | null }

export interface ProviderState {
  sessions: ProviderSessionInfo[];
  threads: ProviderThreadInfo[];
  turns: ProviderTurnInfo[];
  activeProviderThreadId: string | null;
}

const EMPTY: ProviderState = { sessions: [], threads: [], turns: [], activeProviderThreadId: null };
export const emptyProviderState = (): ProviderState => EMPTY;
const state = signal<ProviderState>(EMPTY);
export const providerState = () => state();

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function readUsage(value: unknown, fallbackUpdatedAt: string | null): TokenUsage | null {
  const usage = record(value);
  const used = finite(usage?.usedTokens);
  if (!usage || used === null) return null;
  const updatedAt = text(usage.updatedAt) ?? fallbackUpdatedAt;
  if (updatedAt === null) return null;
  return { usedTokens: used, maxTokens: finite(usage.maxTokens), updatedAt, promptCacheTtlMs: finite(usage.promptCacheTtlMs) };
}

function readSession(value: unknown): ProviderSessionInfo | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  const turns = record(record(item.capabilities)?.turns);
  return {
    id, status: text(item.status) ?? "",
    supportsActiveSteering: turns?.supportsActiveSteering === true,
    supportsSteeringByInterruptRestart: turns?.supportsSteeringByInterruptRestart === true,
  };
}

function readThread(value: unknown): ProviderThreadInfo | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  const updatedAt = text(item.updatedAt);
  return { id, appThreadId: text(item.appThreadId) ?? "", providerSessionId: text(item.providerSessionId), updatedAt, contextUsage: readUsage(item.contextUsage, updatedAt) };
}

function readTurn(value: unknown): ProviderTurnInfo | null {
  const item = record(value);
  const id = text(item?.id);
  if (!item || !id) return null;
  return {
    id, providerThreadId: text(item.providerThreadId) ?? "", runAttemptId: text(item.runAttemptId), status: text(item.status) ?? "",
    tokenUsage: readUsage(item.tokenUsage, null),
  };
}

function upsert<T extends { id: string }>(list: T[], next: T | null): T[] {
  if (!next) return list;
  return list.some((entry) => entry.id === next.id) ? list.map((entry) => (entry.id === next.id ? next : entry)) : [...list, next];
}

function readAll<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.flatMap((item) => { const parsed = read(item); return parsed ? [parsed] : []; }) : [];
}

/** Folds a subscription item without changing the open thread's state. */
export function foldProviderThreadItem(current: ProviderState, item: unknown): ProviderState {
  const entry = record(item);
  if (!entry) return current;
  if (entry.kind === "snapshot") {
    const projection = record(entry.projection);
    if (!projection) return current;
    return {
      sessions: readAll(projection.providerSessions, readSession),
      threads: readAll(projection.providerThreads, readThread),
      turns: readAll(projection.providerTurns, readTurn),
      activeProviderThreadId: text(record(projection.thread)?.activeProviderThreadId),
    };
  }
  if (entry.kind !== "event") return current;
  const event = record(entry.event);
  switch (event?.type) {
    case "provider-session.attached":
    case "provider-session.updated": return { ...current, sessions: upsert(current.sessions, readSession(event.payload)) };
    case "provider-session.detached": {
      const id = text(record(event.payload)?.id) ?? text(record(event.payload)?.providerSessionId);
      return id ? { ...current, sessions: current.sessions.filter((session) => session.id !== id) } : current;
    }
    case "provider-thread.updated": return { ...current, threads: upsert(current.threads, readThread(event.payload)) };
    case "provider-turn.updated": return { ...current, turns: upsert(current.turns, readTurn(event.payload)) };
    case "thread.updated":
    case "thread.created": {
      const active = text(record(event.payload)?.activeProviderThreadId);
      return active !== null ? { ...current, activeProviderThreadId: active } : current;
    }
    default: return current;
  }
}

/** Folds one item into the currently open thread's state. */
export function observeThreadItem(item: unknown): void {
  state.update((current) => foldProviderThreadItem(current, item));
}

/** Forget everything when the open thread changes. */
export function resetThreadProviderState(): void {
  state.set(EMPTY);
}
/** Puts back the state a thread had when it was left, so a resumed subscription (no new snapshot) starts from it. */
export function restoreThreadProviderState(saved: ProviderState): void { state.set(saved); }

export interface ActiveRunInfo { id: string; status: string; activeAttemptId: string | null; providerThreadId: string | null }

export function readActiveRun(records: readonly Record<string, unknown>[], runId: string | null): ActiveRunInfo | null {
  if (runId === null) return null;
  const run = records.find((item) => item.id === runId);
  return run ? { id: runId, status: text(run.status) ?? "", activeAttemptId: text(run.activeAttemptId), providerThreadId: text(run.providerThreadId) } : null;
}

/** resolveThreadProviderSession. */
export function resolveProviderSession(data: ProviderState, activeRun: ActiveRunInfo | null, appThreadId: string): ProviderSessionInfo | null {
  const providerThreadId = activeRun?.providerThreadId ?? data.activeProviderThreadId;
  const active = providerThreadId === null ? null : (data.threads.find((thread) => thread.id === providerThreadId) ?? null);
  const attached = active ?? data.threads.find((thread) => thread.appThreadId === appThreadId && thread.providerSessionId !== null) ?? null;
  const sessionId = attached?.providerSessionId ?? null;
  if (sessionId !== null) return data.sessions.find((session) => session.id === sessionId) ?? null;
  return [...data.sessions].reverse().find((session) => session.status !== "stopped" && session.status !== "error") ?? null;
}

/** isCompactionCommandMessage: a lone `/compact` prompt is the compaction itself. */
export function isCompactionCommand(message: { body: string; attachments?: readonly unknown[] } | undefined): boolean {
  return message !== undefined && message.body.trim().toLowerCase() === "/compact" && (message.attachments?.length ?? 0) === 0;
}

const TERMINAL_TURN = new Set(["completed", "failed", "interrupted", "cancelled"]);

/**
 * The run still reads as active, but its provider turn has already ended (the server is projecting the run's
 * completion). Mirrors the server's own "steering is too late" check in the message.dispatch handler: a turn of the
 * run's active attempt is in a terminal status and none is running. A run whose turn has not started yet (the gap
 * before the first provider-turn event) is NOT ended.
 */
export function providerTurnEnded(data: ProviderState, activeRun: ActiveRunInfo | null): boolean {
  if (activeRun === null || (activeRun.status !== "running" && activeRun.status !== "waiting") || activeRun.activeAttemptId === null) return false;
  const turns = data.turns.filter((turn) => turn.runAttemptId === activeRun.activeAttemptId);
  return turns.length > 0 && !turns.some((turn) => turn.status === "running") && turns.some((turn) => TERMINAL_TURN.has(turn.status));
}

export interface SteerState { canPromoteToSteer: boolean; promoteSkipsCompaction: boolean }

/** deriveThreadQueueWorkflowState: promoting a queued message steers the running turn only when its provider can take steering. */
export function deriveSteerState(input: {
  data: ProviderState; activeRun: ActiveRunInfo | null; appThreadId: string; activeMessage: { body: string; attachments?: readonly unknown[] } | undefined;
}): SteerState {
  const { data, activeRun } = input;
  const promoteSkipsCompaction = isCompactionCommand(input.activeMessage);
  const session = resolveProviderSession(data, activeRun, input.appThreadId);
  const hasSteerableProviderTurn = activeRun?.status === "running" && activeRun.activeAttemptId !== null
    && data.turns.some((turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running");
  return {
    promoteSkipsCompaction,
    canPromoteToSteer: promoteSkipsCompaction || (hasSteerableProviderTurn && (session?.supportsActiveSteering === true || session?.supportsSteeringByInterruptRestart === true)),
  };
}

/** latestProviderTurnTokenUsage over the active provider thread's turns, else the thread's own report. */
export function latestTokenUsage(data: ProviderState): TokenUsage | null {
  const active = data.activeProviderThreadId;
  let latest: TokenUsage | null = null;
  for (const turn of data.turns) {
    if (active !== null && turn.providerThreadId !== active) continue;
    const usage = turn.tokenUsage;
    if (usage === null) continue;
    if (latest === null || Date.parse(usage.updatedAt) >= Date.parse(latest.updatedAt)) latest = usage;
  }
  if (latest !== null) return latest;
  return data.threads.find((thread) => thread.id === active)?.contextUsage ?? null;
}

// Claude's 1h cache plus slack, and the smallest context worth compacting (shared claudeCompaction.ts).
const RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;
export const COMPACTION_SUGGESTION_MIN_TOKENS = 200_000;

/** shouldOfferResumeCompaction. */
export function shouldOfferResumeCompaction(input: { provider: string | null | undefined; usage: TokenUsage | null; now: number }): boolean {
  if (input.provider !== "claudeAgent" || input.usage === null || input.usage.usedTokens < COMPACTION_SUGGESTION_MIN_TOKENS) return false;
  const updatedAt = Date.parse(input.usage.updatedAt);
  return Number.isFinite(updatedAt) && input.now - updatedAt >= (input.usage.promptCacheTtlMs ?? RESUME_COMPACTION_FALLBACK_MS);
}

/** formatContextWindowTokens (lib/contextWindow.ts). */
export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 999_500) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** COMPACT_COMMAND_PATTERN: a typed `/compact` is already the compaction. */
export const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;
