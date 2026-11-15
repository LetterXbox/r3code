// The environments the Usage page reads, and how it asks one of them. The page sums every selected
// environment's answer (UsagePage's useUsage over environmentPresentations), so it lists the live connection
// and every enabled saved environment (Settings > Environments), and reads each one with its own session.
import { environmentConnections, environmentUsageSources, managedEnvironment, requestEnvironment } from "../../environments/connectionManager";
import { environmentStatuses, savedEnvironments, type EnvironmentStatus, type SavedEnvironment } from "../../pages/settings/environments/savedEnvironments";
import { backendUrl, requestBackend } from "../../store";
import type { UsageEnvironmentEntry } from "./usageSelection";

/** The primary connection first, then the saved environments that are switched on. */
export function buildUsageEnvironmentList(input: {
  primary: { id: string; label: string; connected: boolean } | null;
  saved: readonly SavedEnvironment[];
  statuses: Readonly<Record<string, EnvironmentStatus | undefined>>;
}): UsageEnvironmentEntry[] {
  const list: UsageEnvironmentEntry[] = input.primary ? [input.primary] : [];
  for (const environment of input.saved) {
    if (!environment.enabled) continue;
    list.push({ id: environment.id, label: environment.label, connected: input.statuses[environment.id]?.phase === "connected" });
  }
  return list;
}

export const savedUsageEnvironments = () => savedEnvironments();
export const savedUsageStatuses = () => environmentStatuses();

/** How long a saved environment gets to open a session before the page reports it as unreachable. */
export const ENVIRONMENT_CONNECT_TIMEOUT_MS = 15000;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (cause) => { clearTimeout(timer); reject(cause); });
  });
}

type UsageRequest = (id: string, method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
let override: UsageRequest | null = null;
/** Tests answer each environment's calls without a socket behind them. */
export function setUsageRequestForTest(request: UsageRequest | null) { override = request; }

/** One call on an environment: the live connection for the primary, a one-shot session for a saved one. */
export async function requestUsageEnvironment(id: string, method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
  if (override) return override(id, method, payload, options);
  const saved = savedEnvironments().find((environment) => environment.id === id);
  if (!saved) return requestBackend(method, payload, options);
  // The reference reads usage over the environment's live session. A saved environment the connection manager already holds
  // a session for is asked there; opening a fresh socket (ticket, connect, close) for every read added seconds to each one.
  // The reference reads usage over the environment's one live session (connectionManager.ts); no extra socket is opened.
  if (managedEnvironment(id) && environmentConnections()[id]?.phase === "connected") return requestEnvironment(id, method, payload, options);
  throw new Error("Connect an environment first");
}

let sourcesOverride: ((id: string) => Promise<unknown>) | null = null;
/** Tests answer a saved environment's usage limit sources without a socket behind them. */
export function setUsageSourcesForTest(read: ((id: string) => Promise<unknown>) | null) { sourcesOverride = read; }

/** How long a saved environment gets to send its usage limit sources after the stream opens (an older server sends none). */
export const SOURCES_WAIT_MS = 5000;

/**
 * The usage limit sources of a saved environment, read from that environment's one config stream
 * (connectionManager.ts, `subscribeServerConfig` with `usageLimitSources`) as state/server.ts does: no extra session.
 * Null when the id is not a saved environment.
 */
export async function readUsageLimitSources(id: string): Promise<unknown> {
  if (sourcesOverride) return sourcesOverride(id);
  const saved = savedEnvironments().find((environment) => environment.id === id);
  if (!saved) return null;
  if (environmentConnections()[id]?.phase !== "connected") throw new Error("Connect an environment first");
  return environmentUsageSources()[id] ?? [];
}

const limitsRefreshAfter = new Map<string, number>();
const limitsRefreshes = new Map<string, Promise<unknown>>();
export function resetLimitsRefreshForTest() { limitsRefreshAfter.clear(); limitsRefreshes.clear(); }

/** refreshUsageLimits (client-runtime state/usage.ts): one refresh in flight per environment; an automatic one waits five minutes after the last. */
export async function refreshLimitsOnce<A>(id: string, refresh: () => Promise<A>, automatic = false): Promise<A | undefined> {
  const pending = limitsRefreshes.get(id);
  if (pending !== undefined) return automatic ? undefined : ((await pending) as A);
  if (automatic && Date.now() < (limitsRefreshAfter.get(id) ?? 0)) return undefined;
  const current = Promise.resolve().then(refresh).finally(() => {
    limitsRefreshes.delete(id);
    limitsRefreshAfter.set(id, Date.now() + 5 * 60_000);
  });
  limitsRefreshes.set(id, current);
  return await current;
}

export const primaryUsageUrl = () => backendUrl() || "local";

export function usageReadFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.startsWith("Request timed out") ? "The server is still scanning usage. Try refreshing again later." : message;
}

/** Reads every target at once; an environment that fails is reported by id and the others still answer. */
export async function readEnvironments<T>(
  targets: readonly { id: string }[],
  read: (id: string) => Promise<T>,
): Promise<{ answers: { id: string; value: T }[]; failures: Record<string, string> }> {
  const outcomes = await Promise.all(targets.map(async ({ id }) => {
    try { return { id, value: await read(id), failure: null as string | null }; } catch (cause) { return { id, value: undefined, failure: usageReadFailure(cause) }; }
  }));
  const answers: { id: string; value: T }[] = [];
  const failures: Record<string, string> = {};
  for (const outcome of outcomes) {
    if (outcome.failure !== null) failures[outcome.id] = outcome.failure;
    else answers.push({ id: outcome.id, value: outcome.value as T });
  }
  return { answers, failures };
}
