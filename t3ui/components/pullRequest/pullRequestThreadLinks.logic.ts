// Threads linked to a pull request (PullRequestThreadLinks.tsx): the key a link is stored under, the
// orchestration commands that make and break one, and the label of the count.

export interface ThreadLinkTarget { host: string; repository: string; number: number; url: string }

/** normalizeThreadPullRequestKey: host and repository compare case-insensitively. */
export function threadPullRequestKey(target: Pick<ThreadLinkTarget, "host" | "repository" | "number">) {
  return { host: target.host.trim().toLowerCase(), repository: target.repository.trim().toLowerCase(), number: target.number };
}

/** `thread.pull-request.link` (a manual link) or `.unlink` (orchestrationV2.ts), without the commandId the app adds. */
export function threadLinkCommand(threadId: string, target: ThreadLinkTarget, linked: boolean) {
  const key = threadPullRequestKey(target);
  return linked
    ? { type: "thread.pull-request.link" as const, threadId, ...key, url: target.url, source: "manual" as const }
    : { type: "thread.pull-request.unlink" as const, threadId, ...key };
}

export interface LinkedThread { id: string; projectId: string; title: string; archivedAt: string | null; settled: boolean }

/** pullRequests.linkedThreads: the threads that point at the pull request, archived ones left out. */
export function parseLinkedThreads(value: unknown): LinkedThread[] {
  const threads = (value as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) return [];
  return threads.flatMap((thread): LinkedThread[] => {
    const t = thread as Record<string, unknown> | null;
    if (!t || typeof t.id !== "string" || !t.id) return [];
    const archivedAt = typeof t.archivedAt === "string" ? t.archivedAt : null;
    // Archived threads stay: the reference counts them and the palette lists them as "Archived thread".
    return [{ id: t.id, projectId: typeof t.projectId === "string" ? t.projectId : "", title: typeof t.title === "string" ? t.title : "", archivedAt, settled: t.settled === true }];
  });
}

export const linkedThreadsLabel = (count: number) => (count > 0 ? `Linked from ${count} ${count === 1 ? "thread" : "threads"}` : "Linked threads");

/** Threads to offer for linking: not archived, matching the typed words in the title or project name, newest first. */
export function threadPickerCandidates<T extends { id: string; title: string; updatedAt: number }>(
  threads: readonly T[], projectNameOf: (thread: T) => string, query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return threads
    .filter((thread) => `${thread.title} ${projectNameOf(thread)}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
