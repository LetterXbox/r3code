/** Changes received after an archive snapshot request was sent. */
export type ArchiveChanges = Map<string, Record<string, unknown> | null>;

export function recordArchiveChange(changes: ArchiveChanges | null | undefined, event: Record<string, unknown>): void {
  if (!changes) return;
  if (event.kind === "thread.updated" && typeof event.thread === "object" && event.thread !== null) {
    const thread = event.thread as Record<string, unknown>;
    if (typeof thread.id === "string") changes.set(thread.id, event.location === "archive" ? thread : null);
  } else if (event.kind === "thread.removed" && event.location === "archive" && typeof event.threadId === "string") {
    changes.set(event.threadId, null);
  }
}

export function mergeArchiveSnapshot(snapshot: Record<string, unknown>[], changes: ArchiveChanges): Record<string, unknown>[] {
  const rows = snapshot.filter((thread) => typeof thread.id !== "string" || !changes.has(thread.id));
  for (const thread of changes.values()) if (thread !== null) rows.push(thread);
  return rows;
}
