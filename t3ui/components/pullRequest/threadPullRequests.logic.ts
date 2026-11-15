// What a thread's linked pull requests panel shows and does (ThreadPullRequestsPanel.tsx): the rows, the counts in its footer, and
// the orchestration commands behind Unlink, Dismiss and Watch (orchestrationV2.ts thread.pull-request.*).
import type { LinkedPullRequest } from "../header/threadRelations";
import { threadPullRequestKey } from "./pullRequestThreadLinks.logic";

export const LINK_SOURCE_LABELS: Record<string, string> = {
  manual: "Linked by you", created: "Created from this thread", agent: "Linked by the agent", stack: "Found in the stack", "stack-dismissed": "Dismissed",
};

/** visibleThreadPullRequests: a link dismissed from a stack stays stored but is not listed. */
export const visibleThreadPullRequests = (links: readonly LinkedPullRequest[]): LinkedPullRequest[] => links.filter((link) => link.source !== "stack-dismissed");

export const isOpenLink = (link: LinkedPullRequest) => link.snapshot === null || link.snapshot.state === "open";

export function threadPullRequestsSummary(links: readonly LinkedPullRequest[], syncedAt: string | null, now: number, relative: (iso: string, now: number) => string): string {
  const open = links.filter(isOpenLink).length;
  return `${open} open · ${links.length} linked${syncedAt ? ` · synced ${relative(syncedAt, now)}` : ""}`;
}

export const unlinkMenuLabel = (link: LinkedPullRequest) => (link.source === "stack" ? "Dismiss from thread" : "Unlink from thread");

/** The command for Unlink / Dismiss. */
export const unlinkCommand = (threadId: string, link: LinkedPullRequest) => ({ type: "thread.pull-request.unlink" as const, threadId, ...threadPullRequestKey(link) });

/** The command for Watch for changes / Stop watching; a watch on a link the server may not hold yet carries the link. */
export function watchCommand(threadId: string, link: LinkedPullRequest, watching: boolean) {
  return { type: "thread.pull-request.watch" as const, threadId, ...threadPullRequestKey(link), watching, link: { url: link.url, source: link.source === "stack-dismissed" ? "stack" : link.source } };
}
