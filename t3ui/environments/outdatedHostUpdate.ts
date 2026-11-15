// connection/outdatedHostUpdate.ts updateOutdatedHost + state/outdatedServerUpdate.ts, for the primary environment: a
// server on another orchestration protocol blocks the normal session (store.ts connectionBlocked), so the update opens a
// bare socket WITHOUT the orchestrationProtocol parameter (prepareForUpdate) and calls only the self-update RPCs, whose
// wire shape has not changed. It then polls the descriptor until the server answers on a compatible protocol.
import { BackendClient, record } from "../backend/client";
import { issueSocketUrl } from "../backend/auth";
import { performServerUpdate } from "./ServerUpdateAction";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
const RESTART_TIMEOUT_MS = 4 * 60_000;

export interface OutdatedHostDeps {
  /** Opens the bare socket; request/subscribe on it, close when done. */
  open: (endpoint: string, bearer: string) => Promise<{ request: (method: string, payload: unknown) => Promise<unknown>; subscribe: (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void; close: () => void }>;
  descriptor: (endpoint: string) => Promise<Record<string, unknown> | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const isCompatibleDescriptor = (descriptor: Record<string, unknown> | null) =>
  descriptor !== null && (typeof descriptor.orchestrationProtocolVersion === "number" ? descriptor.orchestrationProtocolVersion : 1) === ORCHESTRATION_PROTOCOL_VERSION;

export async function updateOutdatedHost(
  input: { endpoint: string; bearer: string; descriptor: Record<string, unknown>; targetVersion: string },
  onStage: (stage: "downloading" | "installing" | "resuming") => void,
  deps: OutdatedHostDeps = defaultDeps,
): Promise<{ targetVersion: string }> {
  const label = typeof input.descriptor.label === "string" ? input.descriptor.label : "this server";
  // A host updated by hand is already compatible: nothing to update.
  const current = await deps.descriptor(input.endpoint);
  if (isCompatibleDescriptor(current)) return { targetVersion: String(current!.serverVersion ?? input.targetVersion) };
  const capabilities = record(input.descriptor.capabilities);
  const selfUpdate = capabilities?.serverSelfUpdate;
  if (selfUpdate === undefined || (selfUpdate === "desktop-managed" && capabilities?.desktopAppUpdate !== true)) {
    throw new Error(`Update T3 Code on ${label} manually; it cannot update itself.`);
  }
  const socket = await deps.open(input.endpoint, input.bearer);
  try {
    await performServerUpdate({
      key: "outdated-host", serverLabel: label, targetVersion: input.targetVersion, request: socket.request, subscribe: socket.subscribe,
      selfUpdate: selfUpdate === "boot-service" || selfUpdate === "respawn" || selfUpdate === "desktop-managed" ? selfUpdate : null,
      progress: capabilities?.serverSelfUpdateProgress === true,
    }, (stage) => { if (stage !== "resuming") onStage(stage); });
  } finally {
    socket.close();
  }
  onStage("resuming");
  const deadline = deps.now() + RESTART_TIMEOUT_MS;
  while (deps.now() < deadline) {
    const next = await deps.descriptor(input.endpoint);
    if (next && next.environmentId === input.descriptor.environmentId && isCompatibleDescriptor(next)) return { targetVersion: String(next.serverVersion ?? input.targetVersion) };
    await deps.sleep(1000);
  }
  throw new Error(`${label} did not come back on a compatible T3 Code version.`);
}

const defaultDeps: OutdatedHostDeps = {
  async open(endpoint, bearer) {
    const issued = new URL(await issueSocketUrl(endpoint, bearer));
    issued.searchParams.delete("orchestrationProtocol");
    const client = new BackendClient(() => undefined);
    await client.connect(issued.toString());
    return {
      request: (method, payload) => client.request(method, payload, { timeoutMs: Infinity }),
      subscribe: (method, payload, onValue, onError) => client.subscribe(method, payload, onValue, onError),
      close: () => client.close(),
    };
  },
  async descriptor(endpoint) {
    try {
      const url = new URL(endpoint);
      url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
      const response = await fetch(`${url.origin}/.well-known/t3/environment`, { method: "GET" });
      return response.status === 200 ? record(await response.json()) : null;
    } catch { return null; }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** OutdatedServerUpdateAction's handler: one run per environment, toasts the outcome, then reconnects. */
const running = new Set<string>();
export async function runOutdatedHostUpdate(input: { key: string; serverLabel: string; endpoint: string; bearer: string | null; descriptor: Record<string, unknown>; targetVersion: string },
  ui: { toast: (toast: { type: "success" | "error"; title: string; description: string }) => void; reconnect: () => void; onStage?: (stage: string) => void }, deps?: OutdatedHostDeps) {
  if (running.has(input.key) || !input.bearer) return;
  running.add(input.key);
  try {
    const result = await updateOutdatedHost({ endpoint: input.endpoint, bearer: input.bearer, descriptor: input.descriptor, targetVersion: input.targetVersion }, (stage) => ui.onStage?.(stage), deps);
    ui.toast({ type: "success", title: `${input.serverLabel} updated`, description: `Reconnected on t3@${result.targetVersion}.` });
    ui.reconnect();
  } catch (error) {
    ui.toast({ type: "error", title: `${input.serverLabel} update failed`, description: error instanceof Error ? error.message : "Server update failed." });
  } finally {
    running.delete(input.key);
  }
}
