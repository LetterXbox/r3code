import { expect, test } from "nsh/test";
import {
  groupReviewLines, indexPatchLines, parseReviewThreads, positionAnchor, resolveReviewAnchor, viewLineFor, canEditPullRequestComment,
  canResolvePullRequestThread, mergeThreadComments, visibleBody,
} from "./pullRequestReview.logic";
import { createPullRequestReviewStore } from "./pullRequestReviewStore";
import {
  applyPendingPullRequestReactions, pullRequestReactionTooltip, pullRequestReactionsSignature,
} from "./pullRequestReactions.logic";
import { moreRepliesLabel } from "./PullRequestMoreReplies";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,3 @@", " keep a1", "-old a", "+new a", " keep a3",
  "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -20,3 +21,3 @@", " keep b1", "-old b", "+new b", " keep b3",
  "@@ -40 +41 @@", "-x", "+y", "",
].join("\n");

test("indexPatchLines numbers each side across files as the DiffView does, with real file line numbers", () => {
  const lines = indexPatchLines(PATCH);
  // The probe of the native view: the added line of the second file is new index 4, its deleted line old index 4.
  const newB = lines.find((line) => line.path === "src/b.ts" && line.kind === "added")!;
  expect(newB.newIndex).toBe(4);
  expect(newB.newLine).toBe(22);
  const oldB = lines.find((line) => line.path === "src/b.ts" && line.kind === "deleted")!;
  expect(oldB.oldIndex).toBe(4);
  expect(oldB.oldLine).toBe(21);
  expect(lines.filter((line) => line.path === "src/a.ts")).toHaveLength(4);
});

test("a pressed line resolves to a contract position and a thread's host line to a view line", () => {
  const lines = indexPatchLines(PATCH);
  const added = resolveReviewAnchor(lines, { side: "new", start: 1, end: 1 }, false)!;
  expect(added.position).toEqual({ kind: "added", newLine: 11 });
  expect(added.path).toBe("src/a.ts");
  const deleted = resolveReviewAnchor(lines, { side: "old", start: 4, end: 4 }, false)!;
  expect(deleted.position).toEqual({ kind: "deleted", oldLine: 21 });
  const context = resolveReviewAnchor(lines, { side: "new", start: 0, end: 0 }, false)!;
  expect(context.position).toEqual({ kind: "context", oldLine: 10, newLine: 10, side: "right" });
  expect(positionAnchor(context.position)).toEqual({ line: 10, side: "right" });
  expect(viewLineFor(lines, "src/b.ts", 22, "right")).toEqual({ side: "new", index: 4 });
  expect(viewLineFor(lines, "src/b.ts", 21, "left")).toEqual({ side: "old", index: 4 });
  expect(viewLineFor(lines, "src/b.ts", 99, "right")).toBeNull();
  expect(viewLineFor(lines, "src/nope.ts", 11, "right")).toBeNull();
});

test("a ranged selection keeps its first line only inside one hunk of one file, and only on hosts that take ranges", () => {
  const lines = indexPatchLines(PATCH);
  const range = resolveReviewAnchor(lines, { side: "new", start: 0, end: 2 }, true)!;
  expect(range.startPosition).toEqual({ kind: "context", oldLine: 10, newLine: 10, side: "right" });
  expect(range.position).toEqual({ kind: "context", oldLine: 12, newLine: 12, side: "right" });
  // Without review.rangeComment the comment sits on the last line.
  expect(resolveReviewAnchor(lines, { side: "new", start: 0, end: 2 }, false)!.startPosition).toBeUndefined();
  // Across two files the range collapses to its last line.
  expect(resolveReviewAnchor(lines, { side: "new", start: 1, end: 4 }, true)!.startPosition).toBeUndefined();
  // Past the shown lines nothing resolves.
  expect(resolveReviewAnchor(lines, { side: "new", start: 40, end: 40 }, true)).toBeNull();
});

test("threads, pending comments and the draft gather under their line; unseen threads come back apart", () => {
  const lines = indexPatchLines(PATCH);
  const threads = parseReviewThreads([
    { id: "t1", path: "src/b.ts", line: 22, side: "right", isResolved: false, isOutdated: false, comments: [{ id: "c1", body: "hi", createdAt: "2026-01-01T00:00:00Z", author: { login: "a" } }] },
    { id: "t2", path: "src/gone.ts", line: 3, side: "right", isResolved: true, isOutdated: true, comments: [] },
  ]);
  const draft = resolveReviewAnchor(lines, { side: "new", start: 4, end: 4 }, false)!;
  const placed = groupReviewLines({
    lines, threads,
    pending: [{ id: "p1", path: "src/a.ts", position: { kind: "added", newLine: 11 }, body: "later" }],
    draft,
  });
  expect(placed.groups.map((group) => group.id)).toEqual(["review:new:1", "review:new:4"]);
  const shared = placed.groups.find((group) => group.id === "review:new:4")!;
  expect(shared.threads.map((thread) => thread.id)).toEqual(["t1"]);
  expect(shared.draft).toBe(true);
  expect(placed.unplaced.map((thread) => thread.id)).toEqual(["t2"]);
  // A commit's diff uses other line numbers: every thread is then listed apart.
  expect(groupReviewLines({ lines, threads, pending: [], draft: null, placeThreads: false }).unplaced).toHaveLength(2);
});

test("parseReviewThreads keeps the contract's fields and drops malformed entries", () => {
  const [thread] = parseReviewThreads([
    { id: "t", path: "a.ts", line: 3, side: "left", isResolved: true, isOutdated: false, commentCount: 5, nextCommentsCursor: "next", canResolve: false,
      comments: [{ id: "c", body: "x", createdAt: "2026-01-01T00:00:00Z", author: null, url: null, canEdit: true, reactions: [{ content: "heart", count: 2, actors: ["a"], viewerHasReacted: true }] }, { nope: 1 }] },
    { id: "", path: "a.ts" },
  ]);
  expect(thread!.side).toBe("left");
  expect(thread!.commentCount).toBe(5);
  expect(thread!.nextCommentsCursor).toBe("next");
  expect(thread!.canResolve).toBe(false);
  expect(thread!.comments).toHaveLength(1);
  expect(thread!.comments[0]!.reactions[0]!.viewerHasReacted).toBe(true);
  expect(parseReviewThreads("x")).toEqual([]);
});

test("edit and resolve permissions follow the host's flags, then the viewer's login", () => {
  const detail = { viewer: "Octocat", capabilities: { editComment: true }, permissions: { resolve: true } };
  expect(canEditPullRequestComment(detail, { author: { login: "octocat" }, kind: "issue-comment", canEdit: undefined })).toBe(true);
  expect(canEditPullRequestComment(detail, { author: { login: "other" }, kind: "issue-comment", canEdit: undefined })).toBe(false);
  expect(canEditPullRequestComment(detail, { author: { login: "other" }, kind: "review-comment", canEdit: true })).toBe(true);
  expect(canEditPullRequestComment(detail, { author: { login: "octocat" }, kind: "review", canEdit: undefined })).toBe(false);
  expect(canEditPullRequestComment({ ...detail, capabilities: { editComment: false } }, { author: { login: "octocat" }, kind: "issue-comment", canEdit: true })).toBe(false);
  expect(canResolvePullRequestThread(detail, { canResolve: undefined })).toBe(true);
  expect(canResolvePullRequestThread(detail, { canResolve: false })).toBe(false);
  expect(canResolvePullRequestThread({ permissions: { resolve: false } }, { canResolve: true })).toBe(false);
});

test("thread helpers merge by id and hide marker-only bodies", () => {
  expect(mergeThreadComments([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map((c) => c.id)).toEqual(["a", "b", "c"]);
  expect(visibleBody("<!-- bot -->")).toBeNull();
  // Text beside a marker is kept whole, as the web keeps it.
  expect(visibleBody("  hi <!-- x -->  ")).toBe("hi <!-- x -->");
  expect(moreRepliesLabel(0)).toBe("More replies");
  expect(moreRepliesLabel(1)).toBe("1 more reply");
  expect(moreRepliesLabel(1200)).toBe("1,200 more replies");
});

test("the pending review store keeps comments and the summary per pull request", () => {
  const store = createPullRequestReviewStore();
  const comment = { id: "1", path: "a.ts", position: { kind: "added" as const, newLine: 1 }, body: "x" };
  store.addComment("k", comment);
  store.addComment("k", { ...comment, id: "2" });
  expect(store.comments("k").map((c) => c.id)).toEqual(["1", "2"]);
  expect(store.comments("other")).toEqual([]);
  store.removeComment("k", "1");
  expect(store.comments("k").map((c) => c.id)).toEqual(["2"]);
  store.removeComments("k", ["2"]);
  expect(store.comments("k")).toEqual([]);
  store.setSummary("k", "draft");
  // An edit made while the review was sent survives the clear.
  store.clearSummary("k", "older");
  expect(store.summary("k")).toBe("draft");
  store.clearSummary("k", "draft");
  expect(store.summary("k")).toBe("");
});

test("reactions: the viewer is named only when the host left room, and pending toggles apply optimistically", () => {
  const heart = { content: "heart", count: 3, actors: ["ann", "bob"], viewerHasReacted: true };
  expect(pullRequestReactionTooltip(heart)).toBe("You, ann, and bob reacted with heart emoji");
  expect(pullRequestReactionTooltip({ ...heart, count: 2 })).toBe("ann and bob reacted with heart emoji");
  expect(pullRequestReactionTooltip({ content: "eyes", count: 5, actors: [], viewerHasReacted: false })).toBe("5 people reacted with eyes emoji");
  const shown = applyPendingPullRequestReactions([heart], new Map([["heart", false], ["rocket", true]]));
  expect(shown.map((r) => `${r.content}:${r.count}:${r.viewerHasReacted}`)).toEqual(["heart:2:false", "rocket:1:true"]);
  expect(pullRequestReactionsSignature([heart])).toBe("heart:3:1");
});
