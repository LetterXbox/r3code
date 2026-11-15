// What the Timeline tab lists, ported from pullRequestDetail.logic.ts (buildPullRequestTimeline,
// pullRequestConversationItems, groupPullRequestTimelineConversations): the pull request opening, each commit,
// each comment or review, each review thread with its replies, then the merge or close, newest first.
import type { Actor, DetailComment, DetailCommit, PullRequestActivityData, PullRequestDetailData } from "./pullRequestDetail.logic";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import type { ReviewReaction, ReviewThread } from "./pullRequestReview.logic";
import { visibleBody } from "./pullRequestReview.logic";
import { reviewOutcome } from "./pullRequestConversation.logic";

// Host UTC offsets make lexical timestamp sorting unsafe.
const instant = (iso: string) => Date.parse(iso);
const orNull = (value: string) => (value === "" ? null : value);

export interface TimelineReplyAvailability { moreReplies: number; hasMoreReplies: boolean; url: string | null }

export interface TimelineThread extends TimelineReplyAvailability {
  path: string; line: number | null; isResolved: boolean; isOutdated: boolean; replies: TimelineEvent[];
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: "opened" | "commit" | "comment" | "review" | "merged" | "closed";
  title: string;
  body: string | null;
  markdown: boolean;
  url: string | null;
  actor: Actor | null;
  commitAuthors: readonly Actor[];
  additions: number | null;
  deletions: number | null;
  path: string | null;
  reviewState: string | null;
  reactions: readonly ReviewReaction[];
  comment?: DetailComment;
  thread?: TimelineThread;
}

export type TimelineRow =
  | { kind: "event"; event: TimelineEvent }
  | { kind: "comments"; events: readonly TimelineEvent[] };

/** One comment of a review thread as the flat conversation would carry it, when the flat list lacks it. */
function threadComment(thread: ReviewThread, comment: ReviewThread["comments"][number]): DetailComment {
  return {
    id: comment.id, kind: "review-comment", author: comment.author, body: comment.body, createdAt: comment.createdAt, path: thread.path, reviewState: "",
    editedAt: comment.editedAt ?? "", url: comment.url, reactions: comment.reactions, canEdit: comment.canEdit,
  };
}

type ConversationItem =
  | { kind: "comment"; id: string; createdAt: string; comment: DetailComment }
  | ({ kind: "thread"; id: string; createdAt: string; root: DetailComment; replies: DetailComment[]; thread: ReviewThread } & TimelineReplyAvailability);

export function timelineConversationItems(comments: readonly DetailComment[], reviewThreads: readonly ReviewThread[]): ConversationItem[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const claimed = new Set<string>();
  const threads: Extract<ConversationItem, { kind: "thread" }>[] = [];
  for (const thread of reviewThreads) {
    // The conversation's objects are kept for editing and reactions; some hosts only put a comment in the thread.
    const ordered = thread.comments.map((comment) => byId.get(comment.id) ?? threadComment(thread, comment)).sort((left, right) => instant(left.createdAt) - instant(right.createdAt));
    const [root, ...replies] = ordered;
    if (root === undefined) continue;
    for (const comment of ordered) claimed.add(comment.id);
    const moreReplies = Math.max(0, (thread.commentCount || ordered.length) - ordered.length);
    threads.push({
      kind: "thread", id: thread.id, createdAt: root.createdAt, root, replies, thread, moreReplies,
      hasMoreReplies: moreReplies > 0 || thread.nextCommentsCursor !== null,
      url: orNull(ordered.find((comment) => comment.url !== "")?.url ?? ""),
    });
  }
  threads.sort((left, right) => instant(left.createdAt) - instant(right.createdAt));
  const items: ConversationItem[] = [];
  let next = 0;
  // Loose comments keep their order; each thread goes in at its finding's time.
  for (const comment of comments) {
    if (claimed.has(comment.id)) continue;
    while (next < threads.length && instant(threads[next]!.createdAt) < instant(comment.createdAt)) items.push(threads[next++]!);
    items.push({ kind: "comment", id: comment.id, createdAt: comment.createdAt, comment });
  }
  items.push(...threads.slice(next));
  return items;
}

function commentEvent(comment: DetailComment): TimelineEvent {
  return {
    comment, id: comment.id, at: comment.createdAt, kind: comment.kind === "review" ? "review" : "comment", title: comment.kind === "review" ? "reviewed" : "commented",
    body: visibleBody(comment.body), markdown: true, url: orNull(comment.url), actor: comment.author, commitAuthors: [], additions: null, deletions: null,
    path: orNull(comment.path), reviewState: orNull(comment.reviewState), reactions: comment.reactions,
  };
}

function commitEvent(commit: DetailCommit): TimelineEvent {
  return {
    id: commit.oid, at: commit.committedDate, kind: "commit", title: `Commit ${commit.oid.slice(0, 7)}`, body: commit.headline || null, markdown: false, url: null,
    actor: commit.authors[0] ?? null, commitAuthors: commit.authors, additions: commit.additions, deletions: commit.deletions, path: null, reviewState: null, reactions: [],
  };
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Merged wins over closed: a host sets both timestamps on a merge, and "closed" would misstate it. */
export function buildPullRequestTimelineEvents(detail: Pick<PullRequestDetailData, "provider" | "createdAt" | "author" | "mergedAt" | "closedAt">, activity: Pick<PullRequestActivityData, "comments" | "commits" | "reviewThreads"> | null): TimelineEvent[] {
  const term = changeRequestTerm(detail.provider);
  const lifecycle = (id: "merged" | "closed", at: string): TimelineEvent => ({
    id, at, kind: id, title: `${capitalize(term)} ${id}`, body: null, markdown: false, url: null, actor: null, commitAuthors: [], additions: null, deletions: null, path: null, reviewState: null, reactions: [],
  });
  return [
    {
      id: "created", at: detail.createdAt, kind: "opened" as const, title: `opened this ${term}`, body: null, markdown: false, url: null, actor: detail.author,
      commitAuthors: [], additions: null, deletions: null, path: null, reviewState: null, reactions: [],
    },
    ...(activity?.commits ?? []).map(commitEvent),
    ...timelineConversationItems(activity?.comments ?? [], activity?.reviewThreads ?? []).map((item): TimelineEvent => {
      if (item.kind === "comment") return commentEvent(item.comment);
      return {
        ...commentEvent(item.root),
        thread: { path: item.thread.path, line: item.thread.line, isResolved: item.thread.isResolved, isOutdated: item.thread.isOutdated, replies: item.replies.map(commentEvent), moreReplies: item.moreReplies, hasMoreReplies: item.hasMoreReplies, url: item.url },
      };
    }),
    ...(detail.mergedAt ? [lifecycle("merged", detail.mergedAt)] : []),
    ...(detail.closedAt && !detail.mergedAt ? [lifecycle("closed", detail.closedAt)] : []),
  ].sort((left, right) => (instant(right.at) || 0) - (instant(left.at) || 0));
}

/** Runs of plain comments fold into one disclosure row; verdicts, threads, commits and lifecycle events stand alone. */
export function groupTimelineConversations(events: readonly TimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const event of events) {
    if ((event.kind === "comment" || event.kind === "review") && event.thread === undefined && reviewOutcome(event.reviewState) === null) {
      const last = rows.at(-1);
      if (last?.kind === "comments") rows[rows.length - 1] = { kind: "comments", events: [...last.events, event] };
      else rows.push({ kind: "comments", events: [event] });
    } else rows.push({ kind: "event", event });
  }
  return rows;
}

/** "Changes requested" for the Review state badge: the host's token in words. */
export function friendlyReviewState(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  return words.replace(/^\w/u, (letter) => letter.toUpperCase());
}

export function uniqueConversationActors(events: readonly TimelineEvent[]): Actor[] {
  const actors = new Map<string, Actor>();
  for (const event of events) if (event.actor !== null && !actors.has(event.actor.login)) actors.set(event.actor.login, event.actor);
  return [...actors.values()];
}

/** The key of a row: a thread's resolution or dismissal remounts it so its disclosure starts in the new state. */
export function timelineRowKey(row: TimelineRow): string {
  if (row.kind === "comments") return `comments:${row.events[0]?.id ?? "empty"}`;
  const event = row.event;
  return event.thread === undefined ? event.id : `thread:${event.id}:${event.thread.isResolved}:${reviewOutcome(event.reviewState) === "dismissed"}`;
}
