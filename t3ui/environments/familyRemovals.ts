import { signal } from "nsh";

// A family snapshot can arrive after a shell removal. Retain the removal sequence so that
// old family rows cannot resurrect a deleted or archived thread.
const removed = signal<Record<string, number>>({});
const generations = signal<Record<string, number>>({});
const key = (environment: string, threadId: string) => JSON.stringify([environment, threadId]);

/** Family reads are scoped to an authoritative shell snapshot, not merely a connection. */
export function familyShellGeneration(environment: string): number {
  return generations()[environment] ?? 0;
}

export function recordFamilyShellEvent(environment: string, event: Record<string, unknown>): void {
  if (event.kind === "snapshot" && !Array.isArray(event.resolvedRepositoryIdentityRoots) && typeof event.snapshot === "object" && event.snapshot !== null && !Array.isArray(event.snapshot)) {
    // A new authoritative snapshot starts a new sequence baseline. Tombstones from an
    // earlier snapshot must not suppress rows returned by the new family read.
    clearFamilyRemovals(environment);
    generations.update((current) => ({ ...current, [environment]: (current[environment] ?? 0) + 1 }));
    return;
  }
  if (event.kind !== "thread.removed" || typeof event.threadId !== "string" || typeof event.sequence !== "number") return;
  const entry = key(environment, event.threadId);
  const sequence = event.sequence;
  removed.update((current) => ({ ...current, [entry]: Math.max(current[entry] ?? -1, sequence) }));
}

export function familyRowStillPresent(environment: string, threadId: string, snapshotSequence: number): boolean {
  return (removed()[key(environment, threadId)] ?? -1) <= snapshotSequence;
}

export function clearFamilyRemovals(environment: string): void {
  removed.update((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => JSON.parse(entry)[0] !== environment)));
}
