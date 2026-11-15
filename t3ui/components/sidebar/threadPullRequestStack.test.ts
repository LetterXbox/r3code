import { expect, test } from "nsh/test";
import { badgeLinkFromShell, changeRequestWords, pullRequestChainSizes, pullRequestListOrder, resolveCurrentLink, resolveThreadPullRequestBadge, stackBadgeFromShell, stackBadgePresentation, type BadgeLink } from "./threadPullRequestStack";

const link = (number: number, head: string, base: string, state = "open", isDraft = false, extra: Partial<BadgeLink> = {}): BadgeLink => ({
  host: "github.com", repository: "o/r", number, snapshot: { state, isDraft, headBranch: head, baseBranch: base }, stack: null, ...extra,
});

test("links based on each other's branches form one chain, and a lone link is its own", () => {
  expect(pullRequestChainSizes([link(1, "a", "main"), link(2, "b", "a"), link(3, "c", "b")])).toEqual([3]);
  expect(pullRequestChainSizes([link(1, "a", "main"), link(2, "b", "main")]).sort()).toEqual([1, 1]);
  expect(pullRequestChainSizes([link(1, "a", "main"), { ...link(2, "b", "a"), snapshot: null }]).sort()).toEqual([1, 1]);
});

test("members of a host's native stack chain by the stack id, whatever their branches", () => {
  const stack = { id: "s1", layers: [{ number: 1 }, { number: 2 }] };
  expect(pullRequestChainSizes([link(1, "x", "main", "open", false, { stack }), link(2, "y", "main", "open", false, { stack })])).toEqual([2]);
});

test("one chain of several links is a stack; otherwise the newest link with others", () => {
  expect(resolveThreadPullRequestBadge([link(1, "a", "main"), link(2, "b", "a")])).toEqual({ kind: "stack", layers: 2, state: "open" });
  expect(resolveThreadPullRequestBadge([link(1, "a", "main"), link(2, "b", "main")])).toEqual({ kind: "pull-request", others: 1, state: "open" });
  expect(resolveThreadPullRequestBadge([link(1, "a", "main")])).toEqual({ kind: "pull-request", others: 0, state: "open" });
  expect(resolveThreadPullRequestBadge([])).toBeNull();
});

test("the overall state: draft only when every link is an open draft, open if any is open, merged only when all are", () => {
  expect(resolveThreadPullRequestBadge([link(1, "a", "main", "open", true), link(2, "b", "a", "open", true)])?.state).toBe("draft");
  expect(resolveThreadPullRequestBadge([link(1, "a", "main", "open", true), link(2, "b", "a", "open", false)])?.state).toBe("open");
  expect(resolveThreadPullRequestBadge([link(1, "a", "main", "merged"), link(2, "b", "a", "merged")])?.state).toBe("merged");
  expect(resolveThreadPullRequestBadge([link(1, "a", "main", "merged"), link(2, "b", "a", "closed")])?.state).toBe("closed");
  // A link with no snapshot yet reads as open.
  expect(resolveThreadPullRequestBadge([{ ...link(1, "a", "main"), snapshot: null }, link(2, "b", "main", "merged")])?.state).toBe("open");
});

test("a dismissed stack link is not counted", () => {
  expect(resolveThreadPullRequestBadge([link(1, "a", "main"), { ...link(2, "b", "a"), source: "stack-dismissed" }])).toEqual({ kind: "pull-request", others: 0, state: "open" });
});

test("shell links are read as contract-shaped records, and a lone link gives no multi badge", () => {
  const raw = { host: "github.com", repository: "o/r", number: 4, url: "u", source: "agent", linkedAt: "2026-01-01T00:00:00Z", snapshot: { state: "open", isDraft: false, headBranch: "a", baseBranch: "main" }, stack: { id: "s", layers: [{ number: 4 }, { number: 5 }] } };
  expect(badgeLinkFromShell(raw)).toMatchObject({ number: 4, repository: "o/r", stack: { id: "s", layers: [{ number: 4 }, { number: 5 }] } });
  expect(badgeLinkFromShell({ number: "x" })).toBeNull();
  expect(stackBadgeFromShell({ pullRequests: [raw] })).toBeNull();
  expect(stackBadgeFromShell({})).toBeNull();
});

test("the badge's words: Stack of N, and the newest link with its overall state; GitLab says merge requests", () => {
  expect(stackBadgePresentation({ kind: "stack", layers: 3, state: "open" }, { number: 1, url: "https://github.com/o/r/pull/1", singleLabel: "PR #1, open" })).toEqual({ text: "3", label: "Stack of 3 pull requests, open", state: "open", glyph: "layers" });
  expect(stackBadgePresentation({ kind: "stack", layers: 2, state: "merged" }, { number: 1, url: "https://gitlab.com/g/p/-/merge_requests/1", singleLabel: "MR #1" }).label).toBe("Stack of 2 merge requests, merged");
  expect(stackBadgePresentation({ kind: "pull-request", others: 2, state: "draft" }, { number: 1, url: "u", singleLabel: "PR #1, open" })).toEqual({ text: "+3", label: "PR #1, open, and 2 more linked; overall draft", state: "draft", glyph: "state" });
  expect(changeRequestWords("https://github.com/o/r/pull/1")).toEqual({ shortLabel: "PR", plural: "pull requests" });
});

test("the current link: the one open link, the top of an open stack, else the top of the only chain or the latest update", () => {
  const dated = (number: number, head: string, base: string, state: string, linkedAt: string, updatedAt: string | null = null): BadgeLink => ({ ...link(number, head, base, state), linkedAt, snapshot: { state, isDraft: false, headBranch: head, baseBranch: base, updatedAt } });
  expect(resolveCurrentLink([dated(1, "a", "main", "open", "2026-01-01"), dated(2, "b", "main", "merged", "2026-02-01")])?.number).toBe(1);
  // Two open links in one chain: the one on top (further from the base) is current.
  expect(resolveCurrentLink([dated(1, "a", "main", "open", "2026-01-01"), dated(2, "b", "a", "open", "2026-01-02")])?.number).toBe(2);
  // None open, one chain: its top, even when a lower one was updated later.
  expect(resolveCurrentLink([dated(1, "a", "main", "merged", "2026-01-01", "2026-05-01"), dated(2, "b", "a", "merged", "2026-01-02")])?.number).toBe(2);
  // None open and unrelated: the most recently updated.
  expect(resolveCurrentLink([dated(1, "a", "main", "closed", "2026-01-01"), dated(2, "b", "main", "closed", "2026-01-02", "2026-03-01")])?.number).toBe(2);
  expect(resolveCurrentLink([])).toBeNull();
});

test("fm13: pullRequestListOrder lists chains newest first, each in layer order (pullRequestListLines)", () => {
  const link = (number: number, head: string, base: string, updatedAt: string) => ({ host: "github.com", repository: "o/r", number, linkedAt: updatedAt, snapshot: { state: "open", isDraft: false, headBranch: head, baseBranch: base, updatedAt }, stack: null });
  const old = link(1, "a", "main", "2026-01-01T00:00:00Z");
  const above = link(2, "b", "a", "2026-01-02T00:00:00Z");
  const newest = link(3, "c", "main", "2026-03-01T00:00:00Z");
  expect(pullRequestListOrder([old, newest, above]).map((entry) => entry.number)).toEqual([3, 1, 2]);
});
