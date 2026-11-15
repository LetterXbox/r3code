import { expect, test } from "nsh/test";
import {
  approvalCount, conversationCommentCount, conversationItems, filterConversation, DEFAULT_COMMENT_FILTER, latestReviewOutcomes, orderComments, pageConversations, reviewerEntries, reviewOutcome, totalConversationComments,
} from "./pullRequestConversation.logic";
import { parseActivity } from "./pullRequestDetail.logic";

const actor = (login: string) => ({ login, name: "", avatarUrl: "" });
const activity = parseActivity({
  comments: [
    { id: "c1", kind: "issue-comment", author: { ...actor("hubot[bot]"), isBot: true }, body: "bot noise", createdAt: "2026-01-01T10:00:00Z" },
    { id: "c2", kind: "review", author: actor("ann"), body: "", createdAt: "2026-01-01T11:00:00Z", reviewState: "APPROVED" },
    { id: "c3", kind: "review", author: actor("bob"), body: "", createdAt: "2026-01-01T12:00:00Z", reviewState: "CHANGES_REQUESTED" },
    { id: "c4", kind: "review", author: actor("bob"), body: "", createdAt: "2026-01-01T13:00:00Z", reviewState: "dismissed" },
    { id: "c5", kind: "review", author: actor("cy"), body: "", createdAt: "2026-01-01T09:00:00Z", reviewState: "COMMENTED" },
    { id: "c6", kind: "issue-comment", author: actor("dee"), body: "A remark", createdAt: "2026-01-01T14:00:00Z" },
    { id: "c7", kind: "review-comment", author: actor("dee"), body: "on a line", createdAt: "2026-01-01T14:30:00Z", path: "a.ts" },
  ],
  commits: [{ oid: "abc", messageHeadline: "later", committedDate: "2026-01-01T11:30:00Z", authors: [] }],
  reviewThreads: [
    { id: "t1", path: "a.ts", line: 1, side: "right", isResolved: true, isOutdated: false, comments: [{ id: "x", body: "done", createdAt: "2026-01-01T15:00:00Z", author: actor("ann") }] },
    { id: "t2", path: "a.ts", line: 2, side: "right", isResolved: false, isOutdated: false, comments: [{ id: "y", body: "open", createdAt: "2026-01-01T16:00:00Z", author: actor("ann") }] },
  ],
  commentCount: 7, commentsTruncated: false,
});

test("comment total uses unique returned comments when the host count lags", () => {
  const data = parseActivity({ comments: [{ id: "a" }, { id: "b" }], commits: [], commentCount: 1, reviewThreads: [{ id: "thread", path: "a", comments: [{ id: "b" }, { id: "c" }] }] });
  expect(totalConversationComments(data)).toBe(3);
  expect(totalConversationComments({ ...data, commentCount: 8 })).toBe(8);
  expect(totalConversationComments(null)).toBe(0);
});

test("both sort orders page the same recent conversations before changing their order", () => {
  const comments = ["oldest", "middle", "newest"];
  expect(pageConversations(comments, 2, "oldest")).toEqual({ visible: ["middle", "newest"], hidden: 1 });
  expect(pageConversations(comments, 2, "newest")).toEqual({ visible: ["newest", "middle"], hidden: 1 });
  expect(pageConversations(comments, 10, "oldest")).toEqual({ visible: comments, hidden: 0 });
});

test("thread comments use the canonical conversation copy and do not appear twice", () => {
  const data = parseActivity({ comments: [
    { id: "loose", kind: "issue-comment", author: actor("a"), body: "first", createdAt: "2026-01-01T10:00:00Z" },
    { id: "line", kind: "review-comment", author: actor("b"), body: "edited", createdAt: "2026-01-01T11:00:00Z" },
    { id: "last", kind: "issue-comment", author: actor("c"), body: "last", createdAt: "2026-01-01T12:00:00Z" },
  ], commits: [], reviewThreads: [{ id: "thread", path: "a", comments: [{ id: "line", author: actor("b"), body: "stale", createdAt: "2026-01-01T11:00:00Z" }] }] });
  const items = conversationItems(data);
  expect(items.map((item) => item.id)).toEqual(["loose", "thread", "last"]);
  expect(items[1]?.kind === "thread" ? items[1].thread.comments[0]?.body : null).toBe("edited");
});

test("bot verdicts and human replies stay visible, and hidden counts include every comment", () => {
  const input = parseActivity({
    comments: [{ id: "v", kind: "review", author: { ...actor("reviewer"), isBot: true }, body: "", createdAt: "2026-01-01T10:00:00Z", reviewState: "CHANGES_REQUESTED" }],
    commits: [],
    reviewThreads: [
      { id: "mixed", path: "a", isResolved: false, comments: [{ id: "b", author: { ...actor("reviewer"), isBot: true }, body: "finding", createdAt: "2026-01-01T11:00:00Z" }, { id: "h", author: actor("human"), body: "reply", createdAt: "2026-01-01T12:00:00Z" }] },
      { id: "hidden", path: "b", isResolved: true, comments: [{ id: "a", author: actor("human"), body: "one", createdAt: "2026-01-01T13:00:00Z" }, { id: "c", author: actor("human"), body: "two", createdAt: "2026-01-01T14:00:00Z" }] },
    ],
  });
  const items = conversationItems(input);
  const visible = filterConversation(items, DEFAULT_COMMENT_FILTER);
  expect(visible.map((item) => item.id)).toEqual(["v", "mixed"]);
  expect(conversationCommentCount(items) - conversationCommentCount(visible)).toBe(2);
});

test("a login suffix alone does not mark an actor as a bot", () => {
  const input = parseActivity({ comments: [{ id: "unknown", kind: "issue-comment", author: actor("helper[bot]"), body: "message", createdAt: "2026-01-01T10:00:00Z" }], commits: [], reviewThreads: [] });
  expect(filterConversation(conversationItems(input), DEFAULT_COMMENT_FILTER).map((item) => item.id)).toEqual(["unknown"]);
});

test("dismissed comments in a review thread are filtered individually", () => {
  const data = parseActivity({ comments: [
    { id: "line", kind: "review-comment", author: actor("a"), body: "dismissed", reviewState: "DISMISSED", createdAt: "2026-01-01T11:00:00Z" },
  ], commits: [], reviewThreads: [{ id: "thread", path: "a", comments: [{ id: "line", author: actor("a"), body: "dismissed", createdAt: "2026-01-01T11:00:00Z" }] }] });
  const items = conversationItems(data);
  expect(filterConversation(items, DEFAULT_COMMENT_FILTER)).toEqual([]);
  expect(filterConversation(items, { bots: false, resolved: true }).map((item) => item.id)).toEqual(["thread"]);
});

test("a verdict is normalised, and one older than the newest commit is stale", () => {
  expect(reviewOutcome("CHANGES_REQUESTED")).toBe("changes-requested");
  expect(reviewOutcome("COMMENTED")).toBeNull();
  const outcomes = latestReviewOutcomes(activity.comments, activity.commits);
  // bob's later dismissal replaces his request and is then dropped; ann approved before the last commit.
  expect(outcomes.map((entry) => `${entry.key}:${entry.outcome}:${entry.stale}`)).toEqual(["ann:approved:true"]);
  expect(approvalCount(activity)).toBe(0);
  expect(approvalCount({ ...activity, truncated: true })).toBe(0);
});

test("reviewers are the requested ones plus anyone who submitted a verdict", () => {
  const entries = reviewerEntries({ reviewers: [actor("zed"), actor("Ann")] }, activity);
  expect(entries.map((entry) => `${entry.key}:${entry.outcome}`)).toEqual(["zed:null", "Ann:approved"]);
  expect(reviewerEntries({ reviewers: [] }, activity).map((entry) => entry.key)).toEqual(["ann"]);
});

test("the Comments section lists comments and threads, hides bots and resolved ones until asked, and reorders", () => {
  const items = conversationItems(activity);
  expect(items.map((item) => item.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "t1", "t2"]);
  expect(filterConversation(items, DEFAULT_COMMENT_FILTER).map((item) => item.id)).toEqual(["c2", "c3", "c5", "c6", "c7", "t2"]);
  expect(filterConversation(items, { bots: true, resolved: true })).toHaveLength(9);
  expect(orderComments(["a", "b"], "newest")).toEqual(["b", "a"]);
  expect(orderComments(["a", "b"], "oldest")).toEqual(["a", "b"]);
});
