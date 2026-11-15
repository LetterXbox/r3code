// ArchivedThreadsPanel's grouping and the relative times it prints.
export interface ArchivedItem { id: string; projectId: string; title: string; createdAt?: number; updatedAt: number }
export interface ArchivedGroup { key: string; title: string; threads: ArchivedItem[] }

/** "just now", "5m ago", "3h ago", "2d ago", else a date (RelativeTime). */
export function relativeTime(then: number, now: number): string {
  if (!then) return "unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** One section per project, newest archive first, as the web groups them. */
export function groupArchived(threads: ArchivedItem[], projectName: (projectId: string) => string | null): ArchivedGroup[] {
  const groups = new Map<string, ArchivedGroup>();
  for (const thread of threads) {
    const group = groups.get(thread.projectId) ?? { key: thread.projectId, title: projectName(thread.projectId) ?? thread.projectId, threads: [] };
    group.threads.push(thread);
    groups.set(thread.projectId, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    threads: group.threads.toSorted((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
  }));
}
