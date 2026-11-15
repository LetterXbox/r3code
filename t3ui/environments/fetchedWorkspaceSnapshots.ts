// client-runtime state/server.ts withFetchedWorkspaceSnapshots / recordFetchedWorkspaceSnapshot. The config stream asks
// for `workspaceSnapshotsOnDemand` (rpc/session.ts onDemandSnapshots), so a server with
// `capabilities.providerWorkspaceSnapshotsOnDemand` leaves per-cwd provider snapshots out of the config. The snapshots
// this client fetched (server.refreshProviders { instanceId, cwd }) are kept here and merged back into the providers.
type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null);

/** Structural equality for JSON-shaped values (Equal.equals on the decoded config). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = dict(a), right = dict(b);
  if (!left || !right) return false;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
  return keys.every((key) => jsonEqual(left[key], right[key]));
}

/** snapshotBasis: the provider-wide fields a workspace snapshot builds on. */
const snapshotBasis = (provider: Dict | undefined) =>
  provider && { enabled: provider.enabled, slashCommands: provider.slashCommands, skills: provider.skills };

export interface FetchedWorkspaceSnapshot { readonly instanceId: string; readonly snapshot: Dict; readonly basis: ReturnType<typeof snapshotBasis> }

export const MAX_FETCHED_WORKSPACE_SNAPSHOTS = 32;

export function withFetchedWorkspaceSnapshots(providers: Dict[], fetched: readonly FetchedWorkspaceSnapshot[], onDemand: boolean): Dict[] {
  if (fetched.length === 0 || !onDemand) return providers;
  return providers.map((provider) => {
    // A dropped snapshot reads as lost, and the composer fetches it again.
    const own = fetched.filter((entry) => entry.instanceId === provider.instanceId && jsonEqual(entry.basis, snapshotBasis(provider)));
    return own.length === 0 ? provider : { ...provider, workspaceSnapshots: own.map((entry) => entry.snapshot) };
  });
}

export function recordFetchedWorkspaceSnapshot(
  current: readonly FetchedWorkspaceSnapshot[],
  input: { readonly instanceId: string; readonly cwd: string; readonly fresh: boolean },
  providers: unknown,
  configProvider: Dict | undefined,
): readonly FetchedWorkspaceSnapshot[] {
  const basis = snapshotBasis(configProvider);
  const list = Array.isArray(providers) ? providers.map(dict) : [];
  const provider = list.find((item) => item?.instanceId === input.instanceId);
  const snapshots = Array.isArray(provider?.workspaceSnapshots) ? provider.workspaceSnapshots.map(dict) : [];
  const snapshot = snapshots.find((candidate): candidate is Dict => candidate?.cwd === input.cwd);
  const stored = current.find((entry) => entry.instanceId === input.instanceId && entry.snapshot.cwd === input.cwd);
  // A cached answer from the server would otherwise re-render every config reader.
  if (!input.fresh && snapshot && stored && jsonEqual(stored.snapshot, snapshot) && jsonEqual(stored.basis, basis)) return current;
  // A fresh scan drops the cwd's snapshots for every provider, as the server does.
  const kept = current.filter((entry) => entry.snapshot.cwd !== input.cwd || (!input.fresh && entry.instanceId !== input.instanceId));
  if (!snapshot) return kept.length === current.length ? current : kept;
  return [...kept, { instanceId: input.instanceId, snapshot, basis }].slice(-MAX_FETCHED_WORKSPACE_SNAPSHOTS);
}
