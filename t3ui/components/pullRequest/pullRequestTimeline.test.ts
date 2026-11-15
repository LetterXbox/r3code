import { expect, test } from "nsh/test";
import { parseActivity, parseDetail } from "./pullRequestDetail.logic";
import { buildPullRequestTimelineEvents, friendlyReviewState, groupTimelineConversations, timelineConversationItems, timelineRowKey, uniqueConversationActors } from "./pullRequestTimeline.logic";

const detail = parseDetail({
  projectId: "p", repository: "o/r", number: 7, title: "T", url: "https://github.com/o/r/pull/7", state: "merged", headBranch: "h", baseBranch: "main",
  createdAt: "2026-01-01T00:00:00Z", mergedAt: "2026-01-09T00:00:00Z", closedAt: "2026-01-09T00:00:00Z", author: { login: "ann" },
  capabilities: { diff: true, comment: true, actions: [], mergeMethods: [], review: {}, reviewers: {} },
});

const author = (login: string) => ({ login });
const activity = parseActivity({
  commentCount: 5,
  commits: [{ oid: "abcdef1234567", messageHeadline: "Add it", committedDate: "2026-01-03T00:00:00Z", authors: [author("bob")], additions: 4, deletions: 1 }, { oid: "1234567abcdef", messageHeadline: "", committedDate: "2026-01-04T00:00:00Z", authors: [] }],
  comments: [
    { id: "c1", kind: "issue-comment", body: "first", createdAt: "2026-01-02T00:00:00Z", author: author("cy"), url: "https://x/c1" },
    { id: "c2", kind: "issue-comment", body: "second", createdAt: "2026-01-02T01:00:00Z", author: author("dee") },
    { id: "r1", kind: "review", body: "", reviewState: "APPROVED", createdAt: "2026-01-05T00:00:00Z", author: author("eve") },
    { id: "rc1", kind: "review-comment", body: "nit", path: "a.ts", createdAt: "2026-01-06T00:00:00Z", author: author("fay"), url: "https://x/rc1" },
  ],
  reviewThreads: [{
    id: "t1", path: "a.ts", line: 3, side: "right", isResolved: true, isOutdated: true, commentCount: 5, nextCommentsCursor: "next",
    comments: [
      { id: "rc1", body: "nit", createdAt: "2026-01-06T00:00:00Z", author: author("fay") },
      { id: "rc2", body: "fixed", createdAt: "2026-01-06T01:00:00Z", author: author("ann") },
    ],
  }],
});

test("the timeline lists the opening, commits, comments, threads and the merge, newest first, and merged wins over closed", () => {
  const events = buildPullRequestTimelineEvents(detail, activity);
  expect(events.map((event) => event.id)).toEqual(["merged", "rc1", "r1", "1234567abcdef", "abcdef1234567", "c2", "c1", "created"]);
  expect(events.find((event) => event.id === "merged")?.title).toBe("Pull request merged");
  expect(events.find((event) => event.id === "created")?.title).toBe("opened this pull request");
  const commit = events.find((event) => event.id === "abcdef1234567")!;
  expect(commit).toMatchObject({ title: "Commit abcdef1", body: "Add it", additions: 4, deletions: 1 });
  expect(commit.commitAuthors.map((actor) => actor.login)).toEqual(["bob"]);
  // A commit with no headline reads as untitled in the row.
  expect(events.find((event) => event.id === "1234567abcdef")?.body).toBeNull();
});

test("a review thread is one event holding its replies and what the host did not return", () => {
  const items = timelineConversationItems(activity.comments, activity.reviewThreads);
  expect(items.map((item) => item.id)).toEqual(["c1", "c2", "r1", "t1"]);
  const thread = buildPullRequestTimelineEvents(detail, activity).find((event) => event.id === "rc1")!;
  expect(thread.thread).toMatchObject({ path: "a.ts", line: 3, isResolved: true, isOutdated: true, moreReplies: 3, hasMoreReplies: true, url: "https://x/rc1" });
  expect(thread.thread?.replies.map((reply) => reply.id)).toEqual(["rc2"]);
  // The reply came from the thread alone, so it is normalised as the host's review comment.
  expect(thread.thread?.replies[0]?.comment?.kind).toBe("review-comment");
  expect(timelineRowKey({ kind: "event", event: thread })).toBe("thread:rc1:true:false");
});

test("plain comments run together into one row; verdicts, commits and threads stand alone", () => {
  const rows = groupTimelineConversations(buildPullRequestTimelineEvents(detail, activity));
  expect(rows.map((row) => (row.kind === "comments" ? `comments:${row.events.map((event) => event.id).join("+")}` : row.event.id))).toEqual(["merged", "rc1", "r1", "1234567abcdef", "abcdef1234567", "comments:c2+c1", "created"]);
  const group = rows.find((row) => row.kind === "comments");
  expect(group?.kind === "comments" && uniqueConversationActors(group.events).map((actor) => actor.login)).toEqual(["dee", "cy"]);
});

test("review states read as words", () => {
  expect(friendlyReviewState("CHANGES_REQUESTED")).toBe("Changes requested");
  expect(friendlyReviewState("approved")).toBe("Approved");
});

test("a pull request nobody has touched still has its opening", () => {
  const events = buildPullRequestTimelineEvents({ ...detail, mergedAt: "", closedAt: "" }, null);
  expect(events.map((event) => event.id)).toEqual(["created"]);
});
