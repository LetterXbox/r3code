import { expect, test } from "nsh/test";
import { parsePullRequestPage } from "../../pages/utility-data";
import { buildTimeline, markdownBlocks, parseActivity, parseDetail } from "./pullRequestDetail.logic";
import { buildListView, emptyStateKind, listRequest, measuredPullRequestStats, mergeEntries, parseSearch, pullRequestStatsKey } from "./pullRequestList.logic";
import { relativeTime, resolveChecksState, resolveConflict, resolveReviewDecision, resolveState } from "./pullRequestPresentation";

function page(entries: Record<string, unknown>[]) {
  return parsePullRequestPage({
    viewers: { "github.com": "me" }, providers: [], errors: [], nextCursors: {}, truncated: false,
    entries: entries.map((entry, index) => ({
      projectId: "p", host: "github.com", repository: "a/b", number: index + 1, title: `PR ${index + 1}`, url: `https://x/${index + 1}`,
      author: { login: "dev" }, headBranch: "h", baseBranch: "main", state: "open", isDraft: false, updatedAt: `2026-11-0${index + 1}T00:00:00Z`,
      createdAt: `2026-10-0${index + 1}T00:00:00Z`, labels: [], ...entry,
    })),
  });
}

const base = { state: "all" as const, involvement: "all" as const, filters: {}, search: "", sort: "updated" as const };

test("entries are grouped Authored, Review requested, Others by who the viewer is", () => {
  const { entries, viewers } = page([{ author: { login: "me" } }, { viewerReviewRequested: true }, {}]);
  const view = buildListView({ ...base, entries, viewers });
  expect(view.groups.map((g) => g.label)).toEqual(["Authored", "Review requested", "Others"]);
  expect(view.groups.map((g) => g.entries.length)).toEqual([1, 1, 1]);
});

test("involvement tabs drop the group headers and narrow the rows", () => {
  const { entries, viewers } = page([{ author: { login: "me" } }, { viewerReviewRequested: true }, {}]);
  const reviewing = buildListView({ ...base, entries, viewers, involvement: "reviewing" });
  expect(reviewing.groups).toEqual([{ key: "others", label: "", entries: reviewing.entries }]);
  expect(reviewing.entries.length).toBe(1);
});

test("text, label: qualifiers and the draft/review/checks filters narrow locally", () => {
  const { entries, viewers } = page([
    { title: "Fix cache", labels: [{ name: "bug", color: "" }], checksState: "passing", reviewDecision: "approved" },
    { title: "Add docs", isDraft: true },
    { title: "Fix lint", checksState: "failing" },
  ]);
  expect(buildListView({ ...base, entries, viewers, search: "fix" }).entries.length).toBe(2);
  expect(buildListView({ ...base, entries, viewers, search: "label:bug" }).entries.map((e) => e.title)).toEqual(["Fix cache"]);
  expect(buildListView({ ...base, entries, viewers, filters: { draft: "only" } }).entries.map((e) => e.title)).toEqual(["Add docs"]);
  // The check rollup on a row can omit workflows awaiting approval, so the checks filter is the host's to apply.
  expect(buildListView({ ...base, entries, viewers, filters: { checks: "failing" } }).entries).toHaveLength(3);
  expect(buildListView({ ...base, entries, viewers, filters: { review: "none" } }).entries.length).toBe(2);
  expect(parseSearch("fix label:bug  now")).toEqual({ text: "fix now", labels: ["bug"] });
});

test("merge readiness puts ready rows first and conflicts last; sizes and dates reorder", () => {
  const { entries, viewers } = page([
    { title: "conflict", mergeability: "conflicting" },
    { title: "ready", checksState: "passing", reviewDecision: "approved" },
    { title: "plain" },
  ]);
  expect(buildListView({ ...base, entries, viewers, sort: "ready" }).entries.map((e) => e.title)).toEqual(["ready", "plain", "conflict"]);
  const sized = page([{ title: "small", additions: 1, deletions: 0 }, { title: "large", additions: 90, deletions: 9 }]);
  expect(buildListView({ ...base, entries: sized.entries, viewers: sized.viewers, sort: "largest" }).entries[0].title).toBe("large");
  expect(buildListView({ ...base, entries: sized.entries, viewers: sized.viewers, sort: "newest" }).entries[0].title).toBe("large");
  expect(buildListView({ ...base, entries: sized.entries, viewers: sized.viewers, sort: "oldest" }).entries[0].title).toBe("small");
});

test("measured zero-line pull requests sort before unknown sizes", () => {
  const { entries, viewers } = page([{ title: "measured zero" }, { title: "unknown" }]);
  const measured = measuredPullRequestStats([{ stats: [{ projectId: "p", repository: "A/B", number: 1, additions: 0, deletions: 0 }] }]);
  const measuredSize = (entry: typeof entries[number]) => entry.additions + entry.deletions > 0 || measured.has(pullRequestStatsKey(entry));
  for (const sort of ["ready", "smallest", "largest"] as const) {
    expect(buildListView({ ...base, entries, viewers, sort, measuredSize }).entries.map((entry) => entry.title)).toEqual(["measured zero", "unknown"]);
  }
});

test("the request carries only contract fields and the next cursors", () => {
  expect(listRequest({ state: "open", involvement: "all", filters: {}, query: "", limit: 100 })).toEqual({ state: "open", involvement: "all", limit: 100 });
  expect(listRequest({ state: "merged", involvement: "authored", filters: { draft: "hide", labels: ["bug"] }, query: "race label:ui", cursors: { r: "c" }, limit: 100, host: "github.com" })).toEqual({
    state: "merged", involvement: "authored", filters: { draft: "hide", labels: [["ui"]] }, query: "race", host: "github.com", cursors: { r: "c" }, limit: 100,
  });
});

test("a later page replaces held rows by key and keeps the rest", () => {
  const first = page([{ title: "one" }, { title: "two" }]).entries;
  const next = page([{ title: "one again" }]).entries;
  expect(mergeEntries(first, next).map((e) => e.title)).toEqual(["one again", "two"]);
});

test("empty states follow the web's cases", () => {
  expect(emptyStateKind({ hasProjects: false, query: "", filtered: false })).toBe("no-projects");
  expect(emptyStateKind({ hasProjects: true, query: "zzz", filtered: true })).toBe("search");
  expect(emptyStateKind({ hasProjects: true, query: "", filtered: true })).toBe("filtered");
  expect(emptyStateKind({ hasProjects: true, query: "", filtered: false })).toBe("none");
});

test("presentation matches the web's labels and icons", () => {
  expect(resolveState({ state: "open", isDraft: true }).label).toBe("Draft");
  expect(resolveState({ state: "merged", isDraft: false }).icon).toBe("git-merge");
  expect(resolveConflict({ state: "open", isDraft: false, mergeability: "conflicting", baseBranch: "main" })?.label).toBe("Conflicts with main");
  expect(resolveConflict({ state: "open", isDraft: true, mergeability: "conflicting", baseBranch: "main" })).toBe(null);
  expect(resolveChecksState("failing")?.label).toBe("Some checks were not successful");
  expect(resolveReviewDecision("review-required")?.label).toBe("Awaiting review");
  const now = Date.parse("2026-11-11T12:00:00Z");
  expect(relativeTime("2026-11-11T11:55:00Z", now)).toBe("5m ago");
  expect(relativeTime("2026-11-09T12:00:00Z", now)).toBe("2d ago");
});

test("the timeline orders opening, comments, reviews, commits and the merge", () => {
  const detail = parseDetail({ repository: "a/b", number: 1, title: "T", body: "", url: "u", state: "merged", createdAt: "2026-11-01T00:00:00Z", mergedAt: "2026-11-05T00:00:00Z", author: { login: "dev" } });
  const activity = parseActivity({
    comments: [{ id: "1", kind: "issue-comment", author: { login: "x" }, body: "hi", createdAt: "2026-11-03T00:00:00Z" }, { id: "2", kind: "review", author: { login: "y" }, body: "", createdAt: "2026-11-04T00:00:00Z", reviewState: "APPROVED" }],
    commits: [{ oid: "abcdef123456", messageHeadline: "fix", committedDate: "2026-11-02T00:00:00Z" }], reviewThreads: [],
  });
  const items = buildTimeline(detail, activity);
  expect(items.map((i) => i.kind)).toEqual(["opened", "commit", "comment", "review", "merged"]);
  expect(items[3].title).toBe("approved these changes");
  expect(() => parseDetail({})).toThrow("invalid pull request");
});

test("descriptions read as blocks: headings, bullets, code and paragraphs", () => {
  const blocks = markdownBlocks("# Title\n\nSome text\ncontinues\n\n- one\n- [x] done\n\n```\ncode\n```\n<!-- hidden -->");
  expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "bullet", "bullet", "code"]);
  expect(blocks[1].text).toBe("Some text continues");
  expect(blocks[3].text).toBe("[x] done");
});

test("rows listed without counts ask listStats in batches of 500 and take the answer (fm13)", async () => {
  const { applyPullRequestStats, pullRequestStatsBatches } = await import("./pullRequestList.logic");
  const rows = Array.from({ length: 501 }, (_value, index) => ({ projectId: "p", repository: "o/r", number: index + 1, additions: 0, deletions: 0 }));
  rows.push({ projectId: "p", repository: "o/r", number: 900, additions: 3, deletions: 1 });
  expect(pullRequestStatsBatches(rows).map((batch) => batch.length)).toEqual([500, 1]);
  const next = applyPullRequestStats(rows, { stats: [{ projectId: "p", repository: "O/R", number: 2, additions: 7, deletions: 4 }] });
  expect(next[1]).toEqual({ projectId: "p", repository: "o/r", number: 2, additions: 7, deletions: 4 });
  expect(next[0]!.additions).toBe(0);
});

test("check details are out of date when the list's rollup disagrees with the detail's checks (fm13)", async () => {
  const { pullRequestChecksStale, resolvedDetailChecksState } = await import("./pullRequestDetail.logic");
  expect(pullRequestChecksStale("failing", [{ status: "success" }])).toBe(true);
  expect(pullRequestChecksStale("passing", [{ status: "success" }])).toBe(false);
  expect(pullRequestChecksStale("", [{ status: "pending" }])).toBe(false);
  expect(pullRequestChecksStale("passing", [{ status: "action-required" }])).toBe(false);
  expect(resolvedDetailChecksState("", [{ status: "success" }])).toBe("passing");
  expect(resolvedDetailChecksState("failing", [{ status: "success" }])).toBe("failing");
  expect(resolvedDetailChecksState("passing", [{ status: "action-required" }])).toBe("pending");
  expect(resolvedDetailChecksState("", [])).toBe(null);
});

test("a shown stack carries the reference's refreshing / stale notices (fm13)", async () => {
  const { pullRequestStackNotice } = await import("./pullRequestDetail.logic");
  expect(pullRequestStackNotice(true, "loading")).toBe("Refreshing stack… Showing saved data.");
  expect(pullRequestStackNotice(true, "error")).toBe("Stack data may be stale. We couldn’t refresh it.");
  expect(pullRequestStackNotice(true, "loaded")).toBe(null);
  expect(pullRequestStackNotice(false, "loading")).toBe(null);
});
