// rpc/requestLatencyState.ts and SlowRpcRequestToastCoordinator.tsx: a request that waits longer than 15 s for its answer (2 min for
// updates and refreshes that wait on installs or the network) is listed in one warning toast, "Some requests are slow", which
// closes when the last of them answers. Subscriptions and background reports nobody waits on are not tracked.
import { effect, signal, untracked } from "nsh";
import { closeToast, showToast } from "../toast/toastState";

export const SLOW_RPC_ACK_THRESHOLD_MS = 15_000;
export const LONG_RUNNING_RPC_ACK_THRESHOLD_MS = 120_000;
const MAX_TRACKED_RPC_ACK_REQUESTS = 256;

export interface SlowRpcAckRequest { requestId: string; startedAt: string; startedAtMs: number; tag: string; thresholdMs: number }

// WS_METHODS the web leaves out: background reports and the sign-in wait, which lasts as long as the user takes on the forge.
const UNTRACKED = new Set(["server.getUsageSummary", "server.reportClientActivity", "sourceControl.signInWait"]);
const LONG_RUNNING = new Set(["server.updateProvider", "server.refreshProviders", "server.updateServer", "vcs.refreshStatus"]);

export function shouldTrackRpcAck(method: string): boolean {
  return !method.includes("subscribe") && !method.startsWith("pullRequests.") && !UNTRACKED.has(method);
}

export function rpcAckThresholdMs(method: string, base = SLOW_RPC_ACK_THRESHOLD_MS): number {
  return LONG_RUNNING.has(method) ? Math.max(base, LONG_RUNNING_RPC_ACK_THRESHOLD_MS) : base;
}

const slow = signal<readonly SlowRpcAckRequest[]>([]);
const pending = new Map<string, { request: SlowRpcAckRequest; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;
let thresholdBase = SLOW_RPC_ACK_THRESHOLD_MS;

export const slowRpcRequests = () => slow();

/** Tests only: shortens the warning threshold. */
export function setSlowRpcThresholdForTest(ms: number) { thresholdBase = ms; }

export function trackRpcRequestSent(requestId: string, method: string, tag = method): void {
  if (!shouldTrackRpcAck(method)) return;
  acknowledgeRpcRequest(requestId);
  while (pending.size >= MAX_TRACKED_RPC_ACK_REQUESTS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    acknowledgeRpcRequest(oldest);
  }
  const startedAtMs = Date.now();
  const request: SlowRpcAckRequest = { requestId, startedAt: new Date(startedAtMs).toISOString(), startedAtMs, tag, thresholdMs: rpcAckThresholdMs(method, thresholdBase) };
  const timer = setTimeout(() => {
    pending.delete(requestId);
    slow.update((all) => [...all, request].slice(-MAX_TRACKED_RPC_ACK_REQUESTS));
  }, request.thresholdMs);
  pending.set(requestId, { request, timer });
}

export function acknowledgeRpcRequest(requestId: string): void {
  const entry = pending.get(requestId);
  if (entry) { clearTimeout(entry.timer); pending.delete(requestId); }
  if (slow().some((request) => request.requestId === requestId)) slow.update((all) => all.filter((request) => request.requestId !== requestId));
}

/** Wraps a request's promise: tracked from the send, acknowledged when it settles either way. */
export function trackRpcPromise<T>(method: string, promise: Promise<T>): Promise<T> {
  const requestId = `rpc:${++sequence}`;
  trackRpcRequestSent(requestId, method);
  const done = () => acknowledgeRpcRequest(requestId);
  promise.then(done, done);
  return promise;
}

export function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const thresholdSeconds = Math.round(Math.min(...requests.map((request) => request.thresholdMs)) / 1000);
  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

export const SLOW_RPC_TOAST_ID = "slow-rpc-requests";

/** The one warning toast, as the web's `nextToast`. */
export function slowRpcToast(requests: ReadonlyArray<SlowRpcAckRequest>) {
  return {
    id: SLOW_RPC_TOAST_ID,
    type: "warning" as const,
    title: "Some requests are slow",
    description: describeSlowRequests(requests),
    timeoutMs: 0,
    expandable: {
      labels: { expand: "Show requests", collapse: "Hide requests" },
      rows: requests.map((request) => ({ title: request.tag, detail: `Started ${new Date(request.startedAt).toLocaleTimeString()}` })),
    },
  };
}

let installed = false;

export function installSlowRpcToasts() {
  if (installed) return;
  installed = true;
  effect(() => {
    const requests = slow();
    untracked(() => {
      if (requests.length === 0) closeToast(SLOW_RPC_TOAST_ID);
      else showToast(slowRpcToast(requests));
    });
  });
}
