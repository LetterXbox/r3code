// state/vcs.ts `branch` + `vcsBranchRevalidation` (client-runtime rpc/client.ts subscribeVcsBranch / refreshVcsBranch): the
// checked-out branch of a sidebar thread's checkout, for SidebarThreadRow's "You're currently checked out on another
// branch." A server advertising `capabilities.vcsBranchStatus` streams `subscribeVcsBranch` and is asked to rescan with
// `vcs.refreshBranch` when the app comes back to the front; an older one falls back to the local half of
// `subscribeVcsStatus` (includeRemote: false) and is never asked to rescan. Rows on one checkout share one stream.
import { computed, effect, lifecycle, signal, untracked } from "nsh";
import { allProjects, backendConnected, onServerConfigEvent, requestBackend, subscribeBackend } from "../../store";
import type { Thread } from "../../store";

type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
type Request = (method: string, payload: unknown) => Promise<unknown>;

const rec = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null);

/** One event of either stream: the branch name, or undefined when the event says nothing about it. */
export function readBranchEvent(value: unknown, branchStream: boolean): string | null | undefined {
  const event = rec(value);
  if (!event) return undefined;
  if (branchStream) return typeof event.refName === "string" ? event.refName : event.refName === null ? null : undefined;
  if (event._tag === "remoteUpdated") return undefined;
  const local = rec(event.local);
  return local ? (typeof local.refName === "string" ? local.refName : null) : undefined;
}

/** resolveLocalCheckoutBranchMismatch (BranchToolbar.logic.ts). */
export function branchMismatch(input: { worktreePath: string | null; threadBranch: string | null; currentBranch: string | null }): { threadBranch: string; currentBranch: string } | null {
  if (input.worktreePath !== null) return null;
  if (!input.threadBranch || !input.currentBranch || input.threadBranch === input.currentBranch) return null;
  return { threadBranch: input.threadBranch, currentBranch: input.currentBranch };
}

export function createVcsBranchWatcher(deps: { subscribe: Subscribe; request: Request; branchStatus: () => boolean | null; connected: () => boolean; active: () => boolean; wakeDebounceMs?: number }) {
  const entries = new Map<string, { users: number; branch: ReturnType<typeof signal<string | null>>; stop: (() => void) | null }>();
  const start = (cwd: string) => {
    const entry = entries.get(cwd);
    if (!entry || entry.stop || !deps.connected()) return;
    const capability = deps.branchStatus();
    if (capability === null) return;
    entry.stop = capability
      ? deps.subscribe("subscribeVcsBranch", { cwd }, (value) => { const name = readBranchEvent(value, true); if (name !== undefined) entry.branch.set(name); }, () => { entry.stop = null; })
      : deps.subscribe("subscribeVcsStatus", { cwd, includeRemote: false }, (value) => { const name = readBranchEvent(value, false); if (name !== undefined) entry.branch.set(name); }, () => { entry.stop = null; });
  };
  // A reconnect (or the capability arriving) opens every retained checkout's stream again.
  effect(() => {
    const connected = deps.connected();
    const capability = deps.branchStatus();
    untracked(() => {
      for (const [cwd, entry] of entries) {
        entry.stop?.();
        entry.stop = null;
        if (connected && capability !== null) start(cwd);
      }
    });
  });
  // vcsBranchRevalidation: coming back to the app rescans each retained checkout (debounced), on servers that stream branches.
  let wasActive = untracked(deps.active);
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const active = deps.active();
    const woke = active && !wasActive;
    wasActive = active;
    if (!woke) return;
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => untracked(() => {
      if (!deps.connected() || deps.branchStatus() !== true) return;
      for (const cwd of entries.keys()) void deps.request("vcs.refreshBranch", { cwd }).catch(() => {});
    }), deps.wakeDebounceMs ?? 250);
  });
  return {
    /** Holds `cwd`'s stream open; returns the branch reader and the release. */
    retain(cwd: string): { branch: () => string | null; release: () => void } {
      let entry = entries.get(cwd);
      if (!entry) { entry = { users: 0, branch: signal<string | null>(null), stop: null }; entries.set(cwd, entry); }
      entry.users += 1;
      untracked(() => start(cwd));
      const held = entry;
      let released = false;
      return {
        branch: () => held.branch() ?? null,
        release: () => {
          if (released) return;
          released = true;
          held.users -= 1;
          if (held.users > 0) return;
          held.stop?.();
          entries.delete(cwd);
        },
      };
    },
  };
}

// The connected environment's `capabilities.vcsBranchStatus` (null until its config is read).
const branchStatusCapability = signal<boolean | null>(null);
let capabilityRead = false;
function readCapability(config: unknown) {
  const capabilities = rec(rec(rec(config)?.environment)?.capabilities);
  if (capabilities) branchStatusCapability.set(capabilities.vcsBranchStatus === true);
}
let shared: ReturnType<typeof createVcsBranchWatcher> | null = null;
export function vcsBranchWatcher() {
  if (shared) return shared;
  if (!capabilityRead) {
    capabilityRead = true;
    onServerConfigEvent((event) => readCapability(event.type === "snapshot" ? event.config : event.payload));
    effect(() => {
      if (!backendConnected()) { branchStatusCapability.set(null); return; }
      void untracked(() => requestBackend("server.getConfig", {}).then(readCapability).catch(() => {}));
    });
  }
  shared = createVcsBranchWatcher({ subscribe: subscribeBackend, request: requestBackend, branchStatus: () => branchStatusCapability(), connected: backendConnected, active: () => lifecycle() === "active" });
  return shared;
}

/**
 * SidebarThreadRow's branch lease: while the row is mounted, a local-checkout thread with a branch holds its project
 * checkout's branch stream (rows on one checkout share it). Worktree threads never mismatch, so they hold nothing.
 */
export function useCheckoutBranch(thread: () => Thread): () => string | null {
  const cwd = computed(() => { const value = thread(); return value.path || !value.meta?.branch ? null : allProjects().find((project) => project.id === value.projectId)?.path ?? null; });
  const held = signal<{ branch: () => string | null } | null>(null);
  effect(() => {
    const next = cwd();
    if (!next) { held.set(null); return; }
    const lease = untracked(() => vcsBranchWatcher().retain(next));
    held.set(lease);
    return lease.release;
  });
  return () => held()?.branch() ?? null;
}
