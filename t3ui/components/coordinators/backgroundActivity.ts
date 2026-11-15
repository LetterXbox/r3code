// lib/backgroundActivityReporter.ts: tells each connected environment, every 25 s and whenever the window's state changes,
// that this client is present (`server.reportClientActivity`): visible, focused, recently interacted, and which
// background work it wants kept fresh (provider status always; VCS status for each `subscribeVcsStatus` stream that
// includes the remote; diagnostics while `subscribeResourceTelemetry` runs). The server uses these leases to decide
// what to keep polling. The host reports no global pointer/key events, so "interaction" is the window becoming active.
import { effect, lifecycle, Storage, untracked } from "nsh";
import { backendStatus, requestBackend, setSubscriptionObserver } from "../../store";
import { environmentId as primaryEnvironmentId } from "../sidebar/serverFacts";
import { environmentConnections, requestEnvironment } from "../../environments/connectionManager";

export const REPORT_INTERVAL_MS = 25_000;
export const REPORT_TIMEOUT_MS = 15_000;
export const LEASE_TTL_MS = 45_000;
const CLIENT_ID_STORAGE_KEY = "t3.backgroundActivity.clientId";

export type BackgroundScope =
  | { type: "provider-status"; instanceId?: string }
  | { type: "vcs-status"; cwd: string }
  | { type: "diagnostics" };

/** scopeForSubscription. */
export function scopeForSubscription(method: string, payload: unknown): BackgroundScope | null {
  if (method === "subscribeResourceTelemetry") return { type: "diagnostics" };
  if (method !== "subscribeVcsStatus") return null;
  const input = (payload && typeof payload === "object" ? payload : {}) as { cwd?: unknown; includeRemote?: unknown };
  if (input.includeRemote === false) return null;
  return typeof input.cwd === "string" ? { type: "vcs-status", cwd: input.cwd } : null;
}

const scopeKey = (scope: BackgroundScope) => JSON.stringify(scope.type === "vcs-status" ? [scope.type, scope.cwd] : [scope.type]);
const retained = new Map<string, { scope: BackgroundScope; refCount: number }>();
let onScopesChanged: (() => void) | null = null;

/** retainBackgroundScope: ref-counted, so two views of one folder keep one scope. */
export function retainScope(scope: BackgroundScope): () => void {
  const key = scopeKey(scope);
  const existing = retained.get(key);
  if (existing) existing.refCount += 1;
  else { retained.set(key, { scope, refCount: 1 }); onScopesChanged?.(); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = retained.get(key);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount <= 0) { retained.delete(key); onScopesChanged?.(); }
  };
}

export const retainedScopes = (): BackgroundScope[] => [...retained.values()].map((entry) => entry.scope);

/** createActivityReport. */
export function createActivityReport(input: { environmentId: string | null; clientId: string; appState: "active" | "inactive" | "background"; lastInteractionAt: number; now: number; scopes: readonly BackgroundScope[] }) {
  const visible = input.appState !== "background";
  return {
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    clientId: input.clientId,
    clientKind: "desktop-renderer" as const,
    visible,
    focused: input.appState === "active",
    recentlyInteracted: input.lastInteractionAt <= input.now && input.now - input.lastInteractionAt <= LEASE_TTL_MS,
    appState: visible ? ("active" as const) : ("background" as const),
    scopes: [{ type: "provider-status" as const }, ...input.scopes],
    ttlMs: LEASE_TTL_MS,
    observedAt: new Date(input.now).toISOString(),
  };
}

async function readClientId(): Promise<string> {
  try {
    const existing = await Storage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    await Storage.setItem(CLIENT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "ephemeral-browser-client";
  }
}

const withTimeout = (promise: Promise<unknown>) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, REPORT_TIMEOUT_MS))]).catch(() => undefined);

export function installBackgroundActivityReporter() {
  setSubscriptionObserver((method, payload) => {
    const scope = scopeForSubscription(method, payload);
    return scope ? retainScope(scope) : () => {};
  });
  let clientId: string | null = null;
  let lastInteractionAt = Date.now();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const report = () => {
    if (clientId === null) return;
    const now = Date.now();
    const appState = untracked(() => lifecycle());
    const scopes = retainedScopes();
    if (untracked(() => backendStatus()) === "connected") {
      void withTimeout(requestBackend("server.reportClientActivity", createActivityReport({ environmentId: untracked(() => primaryEnvironmentId()), clientId, appState, lastInteractionAt, now, scopes })));
    }
    for (const [id, connection] of Object.entries(untracked(() => environmentConnections()))) {
      if (connection.phase !== "connected") continue;
      // A saved environment's own streams are not observed here: it gets the baseline scope only.
      void withTimeout(requestEnvironment(id, "server.reportClientActivity", createActivityReport({ environmentId: null, clientId, appState, lastInteractionAt, now, scopes: [] })));
    }
  };
  const requestReport = () => { clearTimeout(debounce); debounce = setTimeout(report, 250); };
  onScopesChanged = requestReport;
  void readClientId().then((id) => { clientId = id; requestReport(); });
  effect(() => {
    const state = lifecycle();
    if (state === "active") lastInteractionAt = Date.now();
    void backendStatus();
    void environmentConnections();
    untracked(requestReport);
  });
  setInterval(requestReport, REPORT_INTERVAL_MS);
}
