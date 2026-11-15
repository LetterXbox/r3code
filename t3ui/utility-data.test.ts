import { expect, test } from "nsh/test";
import { parsePullRequestPage, parseUsage, parseUsageLimits, sortPullRequests, usageWindow } from "./pages/utility-data";

test("pull request pages retain server errors and next cursors", () => {
  const page = parsePullRequestPage({
    entries: [{ projectId: "p", host: "github.com", repository: "a/b", number: 4, title: "Fix race", url: "https://github.com/a/b/pull/4", author: { login: "dev" }, headBranch: "fix", baseBranch: "main", state: "open", isDraft: false, mergeability: "mergeable", checksState: "passing", reviewDecision: "approved", updatedAt: "2026-11-10", createdAt: "2026-11-09" }],
    errors: [{ projectTitle: "other", message: "not authorized" }], nextCursors: { "a/b": "next" }, truncated: true,
  });
  expect(page.entries[0].author).toBe("dev");
  expect(page.errors).toEqual(["other: not authorized"]);
  expect(page.nextCursors).toEqual({ "a/b": "next" });
  expect(page.truncated).toBe(true);
  expect(() => parsePullRequestPage({ entries: [] })).toThrow("invalid pull request list");
});

test("pull request sorting uses readiness and review state", () => {
  const page = parsePullRequestPage({ entries: [
    { projectId: "p", repository: "a/b", number: 1, title: "Draft", url: "https://example.com/1", isDraft: true, updatedAt: "2026-11-11", viewerReviewRequested: true },
    { projectId: "p", repository: "a/b", number: 2, title: "Ready", url: "https://example.com/2", mergeability: "mergeable", checksState: "passing", reviewDecision: "approved", updatedAt: "2026-11-10" },
  ], errors: [], nextCursors: {} });
  expect(sortPullRequests(page.entries, "Merge readiness")[0].number).toBe(2);
  expect(sortPullRequests(page.entries, "Blocked on me")[0].number).toBe(1);
});

test("usage summary rejects malformed totals and preserves partial source errors", () => {
  const data = parseUsage({
    buckets: [{ day: "2026-11-11", provider: "codex", model: "test", costUsd: 1.25, cacheSavingsUsd: 0.5, totals: { uncachedInputTokens: 20, cachedInputTokens: 100, cacheCreationTokens: 5, outputTokens: 10 } }],
    sources: [{ distinctSessions: 3, status: "partial", message: "some files were unreadable", refreshing: true }],
  });
  expect(data.buckets[0].cachedInputTokens).toBe(100);
  expect(data.sessions).toBe(3);
  expect(data.refreshing).toBe(true);
  expect(data.issues).toEqual(["some files were unreadable"]);
  expect(() => parseUsage({ buckets: [{ day: "2026-11-11", provider: "codex", model: "test", totals: {} }], sources: [] })).toThrow("invalid usage totals");
});

test("usage windows use UTC and include exact past 24 hours", () => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  expect(usageWindow(1, now)).toEqual({ sinceDay: "2026-11-10", untilDay: "2026-11-11", timeZone: "UTC", resolution: "hour", sinceTime: "2026-11-10T12:00:00.000Z", untilTime: "2026-11-11T12:00:00.000Z" });
  expect(usageWindow(7, now)).toEqual({ sinceDay: "2026-11-05", untilDay: "2026-11-11", timeZone: "UTC", resolution: "day" });
});


test("subscription limits display returned windows and reject invalid percentages", () => {
  const accounts = parseUsageLimits({ providers: [
    { instanceId: "codex-1", driver: "codex", displayName: "Codex", usageLimits: { windows: [{ id: "weekly", label: "Weekly", usedPercent: 38, resetsAt: "2026-11-15T00:00:00Z" }] } },
    { instanceId: "other", driver: "other" },
  ] });
  expect(accounts.length).toBe(1);
  expect(accounts[0].windows[0].usedPercent).toBe(38);
  expect(() => parseUsageLimits({ providers: [{ instanceId: "codex-1", usageLimits: { windows: [{ id: "weekly", label: "Weekly", usedPercent: 101 }] } }] })).toThrow("invalid usage limit");
});

test("live provider limits skip a malformed window or provider instead of failing the page", () => {
  const providers = [
    { instanceId: "claude", driver: "claudeAgent", displayName: "Claude", usageLimits: { checkedAt: "2026-11-11T10:00:00.000Z", windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 59 }, { id: "bad", label: "Bad", usedPercent: 140 }] } },
    { driver: "codex", usageLimits: { windows: [] } },
    { instanceId: "pi", driver: "pi", usageLimits: { unavailable: { reason: "unsupported" } } },
    { instanceId: "grok", driver: "grok", displayName: "Grok", usageLimits: { checkedAt: "2026-11-11T10:00:00.000Z", windows: [] , unavailable: { reason: "probeFailed", message: "Probe failed" } } },
  ];
  const accounts = parseUsageLimits({ providers }, true);
  expect(accounts.map((account) => [account.id, account.windows.map((window) => window.id), account.unavailable])).toEqual([["claude", ["weekly"], ""], ["grok", [], "Probe failed"]]);
  expect(() => parseUsageLimits({ providers })).toThrow();
});
