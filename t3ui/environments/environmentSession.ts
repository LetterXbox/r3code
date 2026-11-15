// The connection model shared by the primary session (store.ts) and every saved environment (connectionManager.ts),
// so both follow packages/client-runtime/src/connection/supervisor.ts, rpc/session.ts and state/shell.ts the same way.
// No imports from store.ts or connectionManager.ts (both import this).
import { record, SOCKET_OPEN_TIMEOUT_MS } from "../backend/client";
export { SOCKET_OPEN_TIMEOUT_MS };

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
const SESSION_LOSS_RETRY_DELAY_MS = 250;
const BACKOFF_RESET_AFTER_MS = 30_000;

/** supervisor.ts retryDelayMs, verbatim. */
export function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

/**
 * supervisor.ts's retry ladder: jittered growth to 300 s; the first loss of an established session retries after a
 * jittered 250 ms; the ladder resets only after a session stayed connected 30 s.
 */
export class ReconnectLadder {
  failureCount = 0;
  private connectedAt: number | null = null;
  constructor(private readonly now: () => number = Date.now, private readonly random: () => number = Math.random) {}
  /** The session is established (its config snapshot arrived). */
  established() { this.connectedAt = this.now(); }
  /** Delay before the next attempt after a failure or a lost session. */
  nextDelay(): number {
    const connectedAt = this.connectedAt;
    this.connectedAt = null;
    const established = connectedAt !== null;
    if (established && this.now() - connectedAt >= BACKOFF_RESET_AFTER_MS) this.failureCount = 0;
    const firstLoss = established && this.failureCount === 0;
    this.failureCount += 1;
    return firstLoss
      ? Math.round(SESSION_LOSS_RETRY_DELAY_MS * (0.5 + this.random() / 2))
      : retryDelayMs(this.failureCount - 1, this.random());
  }
  reset() { this.failureCount = 0; this.connectedAt = null; }
}

/** rpc/client.ts expected-failure retry: 250 ms doubling to 30 s. */
export const streamRetryDelay = (failures: number) => Math.min(30000, 250 * 2 ** Math.min(failures, 7));

/** subscribeServerConfig input every environment's one config stream sends (connection/runtime.ts layerWithOptions). */
// rpc/session.ts onDemandSnapshots adds workspaceSnapshotsOnDemand to every config stream input.
export const SERVER_CONFIG_STREAM_INPUT = { environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true } as const;

/** shell.ts ShellOriginIdentity, read from the environment's config snapshot. */
export interface ShellIdentity { serverVersion: unknown; databaseMigration: unknown; omitIdleSubagents: boolean; omitOlderSettled: boolean }
export function shellIdentityOf(config: Record<string, unknown> | null | undefined): ShellIdentity | null {
  const environment = record(config?.environment);
  if (!config || !environment) return null;
  const omitIdleSubagents = config.shellThreadFamilies === true;
  return { serverVersion: environment.serverVersion, databaseMigration: environment.databaseMigration ?? null, omitIdleSubagents, omitOlderSettled: config.shellOlderSettled === true && omitIdleSubagents };
}
export function shellOmission(identity: ShellIdentity | null): Record<string, true> {
  return { ...(identity?.omitIdleSubagents ? { omitIdleSubagents: true } : {}), ...(identity?.omitOlderSettled ? { omitOlderSettled: true } : {}) };
}
const SHELL_RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** One environment's shell cursor and origin (shell.ts), so a reconnect resumes instead of reloading. */
export interface ShellResumeState {
  cursor: number | null;
  origin: (ShellIdentity & { snapshotAt: number }) | null;
}
export function canResumeShellFrom(state: ShellResumeState, identity: ShellIdentity | null, now = Date.now()): boolean {
  const origin = state.origin;
  if (state.cursor === null || !origin || !identity) return false;
  const age = now - origin.snapshotAt;
  return origin.serverVersion === identity.serverVersion && origin.databaseMigration === identity.databaseMigration
    && origin.omitIdleSubagents === identity.omitIdleSubagents && origin.omitOlderSettled === identity.omitOlderSettled && age >= 0 && age < SHELL_RESUME_MAX_AGE_MS;
}

let shellFetch: typeof fetch = (input, init) => fetch(input, init);
export function setSharedShellFetchForTests(next: typeof fetch | null) { shellFetch = next ?? ((input, init) => fetch(input, init)); }
const SHELL_SNAPSHOT_TIMEOUT_MS = 20000;
/** shellSnapshotHttp.ts fetchEnvironmentShellSnapshot: GET /api/orchestration/shell, or null (the socket snapshot is used). */
export async function fetchShellSnapshotWith(fetcher: typeof fetch | null, endpoint: string, bearer: string, identity: ShellIdentity | null): Promise<Record<string, unknown> | null> {
  const run = fetcher ?? shellFetch;
  try {
    const url = new URL(endpoint);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    const query = new URLSearchParams({ ...(identity?.omitIdleSubagents ? { omitIdleSubagents: "1" } : {}), ...(identity?.omitOlderSettled ? { omitOlderSettled: "1" } : {}) }).toString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SHELL_SNAPSHOT_TIMEOUT_MS); });
    const load = (async () => {
      const response = await run(`${url.origin}/api/orchestration/shell${query ? `?${query}` : ""}`, {
        method: "GET",
        headers: { authorization: `Bearer ${bearer}`, "x-t3-orchestration-protocol": "2" },
      });
      if (response.status !== 200) return null;
      const body = record(await response.json());
      return body && typeof body.snapshotSequence === "number" && Array.isArray(body.threads) && Array.isArray(body.projects) ? body : null;
    })();
    const result = await Promise.race([load, timeout]);
    clearTimeout(timer);
    if (!result) console.warn("Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.");
    return result;
  } catch (error) {
    console.warn("Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.", error);
    return null;
  }
}

/**
 * shell.ts makeSubscribeInput: resume from the cursor when the origin matches; else the HTTP snapshot first (applied via
 * `apply`) and subscribe after its cursor; else ask the socket for the snapshot.
 */
export async function prepareShellInput(state: ShellResumeState, identity: ShellIdentity | null, http: (() => Promise<Record<string, unknown> | null>) | null, apply: (snapshot: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const omission = shellOmission(identity);
  if (canResumeShellFrom(state, identity)) return { afterSequence: state.cursor, httpSnapshotFallback: true, ...omission, requestCompletionMarker: true };
  const snapshot = http ? await http() : null;
  if (snapshot && apply(snapshot)) return { afterSequence: snapshot.snapshotSequence, ...omission, requestCompletionMarker: true };
  return { ...omission, requestCompletionMarker: true };
}

/** Records an authoritative snapshot's cursor and origin, and advances the cursor on later events. */
export function noteShellEvent(state: ShellResumeState, value: unknown, identity: ShellIdentity | null) {
  const event = record(value);
  if (!event) return;
  if (event.kind === "snapshot-required") { state.origin = null; return; }
  if (event.kind === "snapshot") {
    const snapshot = record(event.snapshot);
    if (snapshot && !Array.isArray(event.resolvedRepositoryIdentityRoots) && typeof snapshot.snapshotSequence === "number") {
      state.cursor = snapshot.snapshotSequence;
      state.origin = identity ? { ...identity, snapshotAt: Date.now() } : null;
    }
    return;
  }
  if (typeof event.sequence === "number" && (state.cursor === null || event.sequence > state.cursor)) state.cursor = event.sequence;
}

/** Minimal client surface the shared stream runner needs. */
export interface StreamClient {
  subscribe(method: string, payload: unknown, receive: (value: unknown) => void, reject: (error: Error) => void, onEnd?: () => void): () => void;
}

/**
 * shell.ts subscribeDynamicWithSession: the shell stream retries by itself (250 ms doubling to 30 s, reset by an item),
 * rebuilding its input each time; a failure never closes the socket. A normal end resubscribes at once.
 * Returns a reload (snapshot-required) and a stop.
 */
export function runShellStream(options: {
  client: StreamClient;
  live: () => boolean;
  prepare: () => Promise<Record<string, unknown>>;
  receive: (value: unknown) => void;
  onError?: (error: Error) => void;
  stopRetrying?: (error: Error) => boolean;
}): { reload: () => void; stop: () => void } {
  let failures = 0;
  let stop: (() => void) | null = null;
  let attempt = 0;
  const run = async () => {
    const mine = ++attempt;
    const input = await options.prepare();
    if (!options.live() || mine !== attempt) return;
    stop = options.client.subscribe("orchestration.subscribeShell", input, (value) => {
      if (mine !== attempt) return;
      failures = 0;
      options.receive(value);
    }, (error) => {
      if (!options.live() || mine !== attempt) return;
      stop = null;
      options.onError?.(error);
      if (options.stopRetrying?.(error)) return;
      const delay = streamRetryDelay(failures++);
      setTimeout(() => { if (options.live() && mine === attempt) void run(); }, delay);
    }, () => {
      // A normal end resubscribes; repeated ends back off like failures (an item in between resets it).
      if (!options.live() || mine !== attempt) return;
      stop = null;
      const delay = failures === 0 ? 0 : streamRetryDelay(failures - 1);
      failures += 1;
      setTimeout(() => { if (options.live() && mine === attempt) void run(); }, delay);
    });
  };
  const reload = () => {
    if (!options.live()) return;
    const previous = stop;
    stop = null;
    attempt += 1;
    previous?.();
    void run();
  };
  void run();
  return { reload, stop: () => { attempt += 1; stop?.(); stop = null; } };
}

/**
 * state/server.ts configConcurrency "serial": settings, keybinding, provider and scheduled-task edits run one at a time
 * per environment, in call order.
 */
const configLanes = new Map<string, Promise<unknown>>();
export const SERIAL_CONFIG_METHODS = new Set([
  // cr state/server.ts, the commands that take configConcurrency (exact WS_METHODS).
  "server.updateSettings", "server.updateProvider", "server.upsertKeybinding", "server.removeKeybinding",
  "scheduledTasks.upsert", "scheduledTasks.setEnabled",
]);
export function isSerialConfigMethod(method: string) { return SERIAL_CONFIG_METHODS.has(method); }
export function runInConfigLane<T>(environmentKey: string, task: () => Promise<T>): Promise<T> {
  const previous = configLanes.get(environmentKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const settled = next.catch(() => undefined);
  configLanes.set(environmentKey, settled);
  void settled.then(() => { if (configLanes.get(environmentKey) === settled) configLanes.delete(environmentKey); });
  return next;
}

/**
 * rpc/client.ts for a long-lived stream: an expected failure or a normal end resubscribes after 250 ms doubling to 30 s
 * (an item resets it); an authorization failure stops. The connection's own loss is handled by the caller's effect.
 */
export function retryingStream(
  subscribe: (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void, onEnd?: () => void) => () => void,
  method: string, payload: unknown, onValue: (value: unknown) => void,
  options: { stopOn?: (error: Error) => boolean } = {},
): () => void {
  let stopped = false;
  let failures = 0;
  let stop: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    stop = null;
    if (stopped) return;
    timer = setTimeout(run, streamRetryDelay(failures++));
  };
  const run = () => {
    if (stopped) return;
    stop = subscribe(method, payload, (value) => { failures = 0; onValue(value); }, (error) => {
      if (stopped) return;
      if (/Connect an environment first/.test(error.message) || options.stopOn?.(error) || /authoriz/i.test((error as { tag?: string }).tag ?? "")) { stop = null; return; }
      again();
    }, () => { if (!stopped) again(); });
  };
  run();
  return () => { stopped = true; clearTimeout(timer); stop?.(); stop = null; };
}
