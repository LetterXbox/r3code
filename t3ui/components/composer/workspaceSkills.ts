// providerSkills.ts (client-runtime) and useProviderWorkspaceSnapshotRefresh: a provider reports skills and slash
// commands per workspace (`workspaceSnapshots`, one per cwd). The composer reads the snapshot for its cwd, falling back
// to the provider's global lists, and asks the server to rescan (`server.refreshProviders { instanceId, cwd,
// workspaceSnapshotsOnDemand }`) when the cwd's snapshot is missing or older than the TTL, re-checking as the user types.
import { signal } from "nsh";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null);

/** PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS (contracts server.ts). */
export const WORKSPACE_SNAPSHOT_TTL_MS = 5 * 60_000;
export const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;
export const WORKSPACE_SNAPSHOT_MAX_ATTEMPTS = 3;

export function workspaceSnapshotFor(record: Dict | null | undefined, cwd: string | null | undefined): Dict | undefined {
  if (!record || !cwd || !Array.isArray(record.workspaceSnapshots)) return undefined;
  return record.workspaceSnapshots.map(dict).find((snapshot): snapshot is Dict => snapshot?.cwd === cwd);
}

/** resolveProviderSkillsForCwd: the cwd snapshot's skills, else the provider's. */
export function skillsForCwd(record: Dict | null | undefined, cwd: string | null | undefined): unknown {
  return workspaceSnapshotFor(record, cwd)?.skills ?? record?.skills;
}

/** resolveProviderSlashCommandsForCwd. */
export function slashCommandsForCwd(record: Dict | null | undefined, cwd: string | null | undefined): unknown {
  return workspaceSnapshotFor(record, cwd)?.slashCommands ?? record?.slashCommands;
}

const complete = (record: Dict | null | undefined, cwd: string) => { const snapshot = workspaceSnapshotFor(record, cwd); return Boolean(snapshot && snapshot.slashCommandsPending !== true); };
const current = (record: Dict | null | undefined, cwd: string, now: number) => {
  const snapshot = workspaceSnapshotFor(record, cwd);
  const checked = typeof snapshot?.checkedAt === "string" ? Date.parse(snapshot.checkedAt) : NaN;
  return complete(record, cwd) && now - checked < WORKSPACE_SNAPSHOT_TTL_MS;
};

export interface SnapshotRefreshState { requestedAt: number | null; retryNotBefore: number | null; failedAttempts: number; hadSnapshot: boolean; snapshotPending: boolean }
export const INITIAL_SNAPSHOT_REFRESH: SnapshotRefreshState = { requestedAt: null, retryNotBefore: null, failedAttempts: 0, hadSnapshot: false, snapshotPending: false };

/** planProviderWorkspaceSnapshotRefresh. */
export function planSnapshotRefresh(previous: SnapshotRefreshState, record: Dict | null | undefined, cwd: string, now: number): { state: SnapshotRefreshState; refresh: boolean } {
  const hasSnapshot = complete(record, cwd);
  const pending = workspaceSnapshotFor(record, cwd)?.slashCommandsPending === true;
  const lost = previous.hadSnapshot && !hasSnapshot;
  const requestedAt = lost ? null : previous.requestedAt;
  const retryNotBefore = lost || (previous.retryNotBefore !== null && now >= previous.retryNotBefore) ? null : previous.retryNotBefore;
  const state: SnapshotRefreshState = {
    requestedAt, retryNotBefore,
    failedAttempts: lost || (requestedAt !== null && now - requestedAt >= WORKSPACE_SNAPSHOT_TTL_MS) ? 0 : previous.failedAttempts,
    hadSnapshot: hasSnapshot, snapshotPending: pending,
  };
  const refresh = (requestedAt === null || now - requestedAt >= WORKSPACE_SNAPSHOT_TTL_MS) && !current(record, cwd, now) && retryNotBefore === null;
  return refresh ? { state: { ...state, requestedAt: now }, refresh: true } : { state, refresh: false };
}

/** failProviderWorkspaceSnapshotRefresh: cool down before a retry; after the last attempt only the TTL lets one through. */
export function failSnapshotRefresh(state: SnapshotRefreshState, requestedAt: number, now: number): SnapshotRefreshState {
  if (state.requestedAt !== requestedAt) return state;
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts >= WORKSPACE_SNAPSHOT_MAX_ATTEMPTS) return { ...state, failedAttempts };
  return { ...state, requestedAt: null, retryNotBefore: now + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS, failedAttempts };
}

/** isProviderWorkspaceSnapshotScanning. */
export function snapshotScanning(state: SnapshotRefreshState | undefined): boolean {
  return state !== undefined && (state.requestedAt !== null || state.snapshotPending) && !state.hadSnapshot && state.failedAttempts < WORKSPACE_SNAPSHOT_MAX_ATTEMPTS;
}

/**
 * One refresher per composer: `check` runs the plan for the selected instance and cwd (on mount, on a provider update
 * and as the user types); `scanning` drives the skill / slash menu's loading row.
 */
export function createWorkspaceSnapshotRefresher(deps: {
  request: (instanceId: string, cwd: string) => Promise<Dict | undefined>;
  now?: () => number;
}) {
  const states = signal<Record<string, SnapshotRefreshState>>({});
  const now = deps.now ?? (() => Date.now());
  const keyOf = (instanceId: string, cwd: string) => `${instanceId}\u0000${cwd}`;
  const write = (key: string, next: SnapshotRefreshState) => {
    const all = states();
    const previous = all[key];
    if (previous && previous.requestedAt === next.requestedAt && previous.retryNotBefore === next.retryNotBefore
      && previous.failedAttempts === next.failedAttempts && previous.hadSnapshot === next.hadSnapshot
      && previous.snapshotPending === next.snapshotPending) return;
    states.set({ ...all, [key]: next });
  };
  return {
    check(instanceId: string | null | undefined, cwd: string | null | undefined, record: Dict | null | undefined): void {
      if (!instanceId || !cwd) return;
      const key = keyOf(instanceId, cwd);
      const at = now();
      const plan = planSnapshotRefresh(states()[key] ?? INITIAL_SNAPSHOT_REFRESH, record, cwd, at);
      write(key, plan.state);
      if (!plan.refresh) return;
      const before = workspaceSnapshotFor(record, cwd)?.checkedAt;
      const retryLater = () => { const live = states()[key]; if (live) write(key, failSnapshotRefresh(live, at, now())); };
      void deps.request(instanceId, cwd).then((refreshed) => {
        const done = now();
        const ok = complete(refreshed, cwd) && (current(refreshed, cwd, done) || workspaceSnapshotFor(refreshed, cwd)?.checkedAt !== before);
        if (!ok) retryLater();
      }, retryLater);
    },
    scanning(instanceId: string | null | undefined, cwd: string | null | undefined): boolean {
      return !!instanceId && !!cwd && snapshotScanning(states()[keyOf(instanceId, cwd)]);
    },
  };
}
