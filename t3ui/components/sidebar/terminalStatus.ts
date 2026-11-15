// Which threads have a terminal process running, for the row's terminal icon
// (useThreadRunningTerminalIds). The server streams terminal metadata: a snapshot, then
// upserts and removals, each summary saying whether a subprocess runs in it.
import { effect, signal, untracked } from "nsh";
import { retryingStream } from "../../environments/environmentSession";
import { backendConnectionGeneration, backendStatus, backendUrl, subscribeBackend } from "../../store";
import { environmentConnections, environmentGeneration, parseScopedKey, subscribeEnvironment } from "../../environments/connectionManager";

interface Summary { threadId: string; terminalId: string; running: boolean }

const summaries = signal<Summary[]>([]);
/** Whether this connection's metadata snapshot has arrived (knownTerminalSessionsAtom is null until then). */
const summariesKnown = signal(false);
const remoteSummaries = signal<Readonly<Record<string, { items: Summary[]; known: boolean }>>>({});
// QuickJS builds without Intl.Collator; compare digit runs numerically without
// converting them to numbers (terminal IDs can contain arbitrarily long runs).
export function terminalOrder(left: string, right: string): number {
  const a = left.match(/\d+|\D+/g) ?? [];
  const b = right.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const nx = x.replace(/^0+/, "") || "0";
      const ny = y.replace(/^0+/, "") || "0";
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      const nx = x.toLowerCase();
      const ny = y.toLowerCase();
      if (nx !== ny) return nx < ny ? -1 : 1;
    }
  }
  return a.length - b.length;
}
export const serverTerminalSessionsKnown = (threadId?: string) => {
  const scoped = threadId ? parseScopedKey(threadId) : null;
  return scoped ? remoteSummaries()[scoped.environmentId]?.known === true : summariesKnown();
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function summaryOf(value: unknown): Summary | null {
  const item = record(value);
  if (!item || typeof item.threadId !== "string" || typeof item.terminalId !== "string") return null;
  return { threadId: item.threadId, terminalId: item.terminalId, running: item.status === "running" && item.hasRunningSubprocess === true };
}

/** Applies one metadata event to the list; unknown shapes leave it as it was. */
export function applyTerminalMetadata(current: readonly Summary[], event: unknown): Summary[] {
  const data = record(event);
  if (!data) return [...current];
  if (data.type === "snapshot" && Array.isArray(data.terminals)) {
    return data.terminals.map(summaryOf).filter((item): item is Summary => item !== null);
  }
  if (data.type === "upsert") {
    const next = summaryOf(data.terminal);
    if (!next) return [...current];
    return [...current.filter((item) => !(item.threadId === next.threadId && item.terminalId === next.terminalId)), next];
  }
  if (data.type === "remove" && typeof data.threadId === "string" && typeof data.terminalId === "string") {
    return current.filter((item) => !(item.threadId === data.threadId && item.terminalId === data.terminalId));
  }
  return [...current];
}

/** The metadata stream is authoritative for known terminals and their subprocess status. */
export function selectRunningTerminalIds(items: readonly Summary[], threadId: string): string[] {
  return items.filter((item) => item.threadId === threadId && item.running).map((item) => item.terminalId).sort(terminalOrder);
}

export const runningTerminalIds = (threadId: string): string[] => {
  const scoped = parseScopedKey(threadId);
  return scoped ? selectRunningTerminalIds(remoteSummaries()[scoped.environmentId]?.items ?? [], scoped.localId) : selectRunningTerminalIds(summaries(), threadId);
};

export const terminalLabel = (count: number) =>
  count === 1 ? "1 terminal process running. Open terminal" : `${count} terminal processes running. Open terminal`;

let started = false;
const remoteStreams = new Map<string, { generation: string; stop: () => void }>();

/** Subscribes while connected (once per connection). Call from the sidebar. */
export function startTerminalStatus() {
  if (started) return;
  started = true;
  effect(() => {
    summariesKnown.set(false);
    if (backendStatus() !== "connected") {
      summaries.set([]);
      return;
    }
    backendUrl();
    backendConnectionGeneration();
    summaries.set([]);
    // rpc/client.ts: the metadata stream resubscribes when it fails or ends (its next snapshot replaces the list).
    return retryingStream(subscribeBackend, "subscribeTerminalMetadata", {}, (event) => {
      summaries.update((current) => applyTerminalMetadata(current, event));
      if (record(event)?.type === "snapshot") summariesKnown.set(true);
    });
  });
  effect(() => {
    const connected = new Map(Object.entries(environmentConnections()).filter(([, state]) => state.phase === "connected").map(([id]) => [id, environmentGeneration(id)]));
    untracked(() => {
      for (const [id, stream] of remoteStreams) {
        if (connected.get(id) === stream.generation) continue;
        stream.stop();
        remoteStreams.delete(id);
        remoteSummaries.update((all) => { const { [id]: _removed, ...rest } = all; return rest; });
      }
      for (const [id, generation] of connected) {
        if (remoteStreams.has(id)) continue;
        const stop = retryingStream(
          (method, payload, onValue, onError) => subscribeEnvironment(id, method, payload, onValue, onError),
          "subscribeTerminalMetadata", {}, (event) => {
            remoteSummaries.update((all) => {
              const prior = all[id] ?? { items: [], known: false };
              return { ...all, [id]: { items: applyTerminalMetadata(prior.items, event), known: prior.known || record(event)?.type === "snapshot" } };
            });
          },
        );
        remoteStreams.set(id, { generation, stop });
      }
    });
  });
}

/** Every terminal the server's metadata stream lists for a thread (useKnownTerminalSessions), running or not. */
export const serverTerminalIds = (threadId: string): string[] => {
  const scoped = parseScopedKey(threadId);
  const items = scoped ? remoteSummaries()[scoped.environmentId]?.items ?? [] : summaries();
  const localId = scoped?.localId ?? threadId;
  return items.filter((item) => item.threadId === localId).map((item) => item.terminalId).sort(terminalOrder);
};
