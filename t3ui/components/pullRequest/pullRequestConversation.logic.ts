// What the Summary tab's Comments section lists, and the reviewer avatars above it: pure arrangement of
// pullRequests.activity (ported from pullRequestDetail.logic.ts: review outcomes, comment ordering, the
// conversation items; the filter from PullRequestSummaryTab.tsx).
import type { Actor, DetailComment, PullRequestActivityData, PullRequestDetailData } from "./pullRequestDetail.logic";
import type { ReviewThread } from "./pullRequestReview.logic";

export type ReviewOutcome = "approved" | "changes-requested" | "dismissed";

/** The host total can lag the returned comments; count each comment only once across review threads. */
export function totalConversationComments(activity: PullRequestActivityData | null): number {
  if (!activity) return 0;
  const ids = new Set(activity.comments.map((comment) => comment.id));
  for (const thread of activity.reviewThreads) for (const comment of thread.comments) ids.add(comment.id);
  return Math.max(activity.commentCount, ids.size);
}

/** Normalize host verdict formats; ignore non-verdict review states. */
export function reviewOutcome(reviewState: string | null | undefined): ReviewOutcome | null {
  switch (reviewState?.trim().toLowerCase().replaceAll("_", "-")) {
    case "approved": return "approved";
    case "changes-requested": return "changes-requested";
    case "dismissed": return "dismissed";
    default: return null;
  }
}

export const REVIEW_OUTCOME_LABEL: Record<ReviewOutcome, string> = {
  approved: "Approved", "changes-requested": "Changes requested", dismissed: "Review dismissed",
};

export const reviewOutcomeStaleLabel = (outcome: ReviewOutcome) => `${REVIEW_OUTCOME_LABEL[outcome]} earlier changes`;

// Host UTC offsets make lexical timestamp sorting unsafe.
const instant = (iso: string) => Date.parse(iso);

export function newestCommitAt(commits: readonly { committedDate: string }[]): string | null {
  let newest: string | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const commit of commits) {
    const at = instant(commit.committedDate);
    if (Number.isNaN(at) || at <= newestAt) continue;
    newest = commit.committedDate;
    newestAt = at;
  }
  return newest;
}

export function isVerdictStale(at: string, newestCommit: string | null): boolean {
  if (newestCommit === null) return false;
  const verdictAt = instant(at);
  const commitAt = instant(newestCommit);
  return !Number.isNaN(verdictAt) && !Number.isNaN(commitAt) && verdictAt < commitAt;
}

export interface ReviewOutcomeEntry { key: string; actor: Actor | null; outcome: ReviewOutcome; at: string; stale: boolean }

export function latestReviewOutcomes(comments: readonly DetailComment[], commits: readonly { committedDate: string }[] = []): ReviewOutcomeEntry[] {
  const newest = newestCommitAt(commits);
  const latest = new Map<string, ReviewOutcomeEntry>();
  for (const comment of comments) {
    const outcome = reviewOutcome(comment.reviewState);
    if (outcome === null) continue;
    const login = comment.author?.login ?? `ghost:${comment.id}`;
    const current = latest.get(login);
    // Hosts can return reviews out of order.
    if (current !== undefined && instant(current.at) > instant(comment.createdAt)) continue;
    latest.set(login, { key: login, actor: comment.author, outcome, at: comment.createdAt, stale: isVerdictStale(comment.createdAt, newest) });
  }
  return [...latest.values()].filter((entry) => entry.outcome !== "dismissed");
}

export interface ReviewerEntry { key: string; actor: Actor | null; outcome: ReviewOutcome | null; stale: boolean }

const loginKey = (login: string) => login.toLowerCase();

/** Hosts remove reviewed actors from requests, so submitted verdicts are listed too. */
export function reviewerEntries(detail: Pick<PullRequestDetailData, "reviewers">, activity: Pick<PullRequestActivityData, "comments" | "commits"> | null): ReviewerEntry[] {
  const outcomes = activity ? latestReviewOutcomes(activity.comments, activity.commits) : [];
  const byLogin = new Map(outcomes.flatMap((entry) => (entry.actor ? [[loginKey(entry.actor.login), entry] as const] : [])));
  return [
    ...detail.reviewers.map((actor) => ({
      key: actor.login, actor, outcome: byLogin.get(loginKey(actor.login))?.outcome ?? null, stale: byLogin.get(loginKey(actor.login))?.stale ?? false,
    })),
    ...outcomes
      .filter((entry) => !detail.reviewers.some((actor) => entry.actor !== null && loginKey(actor.login) === loginKey(entry.actor.login)))
      .map((entry) => ({ key: entry.key, actor: entry.actor, outcome: entry.outcome, stale: entry.stale })),
  ];
}

export function approvalCount(activity: Pick<PullRequestActivityData, "comments" | "commits" | "truncated"> | null): number {
  if (!activity || activity.truncated) return 0;
  return latestReviewOutcomes(activity.comments, activity.commits).filter((entry) => entry.outcome === "approved" && !entry.stale).length;
}

// ---- The Comments section ----

export type ConversationItem =
  | { kind: "comment"; id: string; at: string; comment: DetailComment }
  | { kind: "thread"; id: string; at: string; thread: ReviewThread };

export interface CommentFilter { bots: boolean; resolved: boolean }
export const DEFAULT_COMMENT_FILTER: CommentFilter = { bots: false, resolved: false };

export function isBot(actor: { login: string; isBot?: boolean } | null | undefined): boolean {
  return actor?.isBot === true;
}

/** Keep the server's loose-comment order, inserting review threads by their first comment's time. */
export function conversationItems(activity: Pick<PullRequestActivityData, "comments" | "reviewThreads"> | null): ConversationItem[] {
  if (!activity) return [];
  const byId = new Map(activity.comments.map((comment) => [comment.id, comment]));
  const claimed = new Set<string>();
  const threads: ConversationItem[] = [];
  for (const thread of activity.reviewThreads) {
    const comments = thread.comments.map((comment) => byId.get(comment.id) ?? comment)
      .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
    const first = comments[0];
    if (!first) continue;
    for (const comment of comments) claimed.add(comment.id);
    threads.push({ kind: "thread", id: thread.id, at: first.createdAt, thread: { ...thread, comments } });
  }
  threads.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const items: ConversationItem[] = [];
  let next = 0;
  for (const comment of activity.comments) {
    if (claimed.has(comment.id)) continue;
    while (next < threads.length && (Date.parse(threads[next]!.at) || 0) < (Date.parse(comment.createdAt) || 0)) items.push(threads[next++]!);
    items.push({ kind: "comment", id: comment.id, at: comment.createdAt, comment });
  }
  return [...items, ...threads.slice(next)];
}

/** A resolved thread or a dismissed review: finished, so the filter hides it by default. */
export function isFinished(item: ConversationItem): boolean {
  return item.kind === "thread" ? item.thread.isResolved : reviewOutcome(item.comment.reviewState) === "dismissed";
}

export function filterConversation(items: readonly ConversationItem[], filter: CommentFilter): ConversationItem[] {
  return items.filter((item) => (item.kind === "thread" ? item.thread.comments : [item.comment]).some((comment) => {
    const reviewState = "reviewState" in comment && typeof comment.reviewState === "string" ? comment.reviewState : "";
    const verdict = reviewOutcome(reviewState);
    return (filter.bots || !isBot(comment.author) || verdict === "approved" || verdict === "changes-requested")
      && (filter.resolved || (!(item.kind === "thread" && item.thread.isResolved) && verdict !== "dismissed"));
  }));
}

export function conversationCommentCount(items: readonly ConversationItem[]): number {
  return items.reduce((count, item) => count + (item.kind === "thread" ? item.thread.comments.length : 1), 0);
}

export const orderComments = <T,>(items: readonly T[], order: "newest" | "oldest"): T[] => (order === "newest" ? [...items].reverse() : [...items]);

/** Page the newest conversations first, then arrange that page in the requested order. */
export function pageConversations<T>(items: readonly T[], count: number, order: "newest" | "oldest"): { visible: T[]; hidden: number } {
  const start = Math.max(0, items.length - count);
  return { visible: orderComments(items.slice(start), order), hidden: start };
}
