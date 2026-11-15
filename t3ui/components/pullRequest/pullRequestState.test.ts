import { expect, test } from "nsh/test";
import { signal } from "nsh";
import {
  createThreadLinkedPullRequestRelinker, invalidatePullRequests, newestPullRequestObservation, observePullRequestChecks,
  observePullRequestMetadata, observedPullRequestSummary, pullRequestChecksRefreshIntervalMs, resetPullRequestRefreshesForTest,
  resolvePullRequestDetailChecks, retainPullRequestRefreshes, threadLinkedPullRequestReplacement, usePullRequestRefreshes,
  type PullRequestObservations,
} from "./pullRequestState";
import { createPullRequestRouter, type RoutingEnvironment } from "./pullRequestRouting";
import { createPullRequestDetailModel } from "./pullRequestDetailModel";
import type { PullRequestEntry } from "../../pages/utility-data";

const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

test("a sparse summary keeps known status; checks keep their own freshness", () => {
  const current = { summary: { state: "open", updatedAt: "2026-01-01T00:00:00Z", isDraft: true, mergeability: "mergeable", reviewDecision: "approved", checksState: "passing" }, observedAt: 1 };
  const sparse = { summary: { state: "open", updatedAt: "2026-01-02T00:00:00Z" }, observedAt: 2 };
  const merged = newestPullRequestObservation(current, sparse)!;
  expect(merged.summary.isDraft).toBe(true);
  expect(merged.summary.mergeability).toBe("mergeable");
  expect(merged.summary.reviewDecision).toBe("approved");
  expect(merged.summary.checksState).toBe("passing");
  // An older summary does not replace a newer one.
  expect(newestPullRequestObservation(sparse, current)).toBe(sparse);
  // A merged answer wins over a newer open one.
  const mergedState = { summary: { state: "merged", updatedAt: "2025-01-01T00:00:00Z" }, observedAt: 0 };
  expect(newestPullRequestObservation(sparse, mergedState)!.summary.state).toBe("merged");
  // Checks read later win; a list read with older checks does not take them back.
  let obs: PullRequestObservations = { metadata: null, checks: null };
  obs = observePullRequestChecks(obs, { checksState: "failing", readAt: 50, observedAt: 5 });
  obs = observePullRequestMetadata(obs, { summary: { state: "open", updatedAt: "2026-01-03T00:00:00Z", checksState: "passing", observedAt: 40 }, observedAt: 6 });
  expect(observedPullRequestSummary(obs)!.checksState).toBe("failing");
  expect(observedPullRequestSummary(obs)!.updatedAt).toBe("2026-01-03T00:00:00Z");
});

test("checks answers merge over the detail by observedAt; merged stays merged; poll 45 s while running, 60 s settled", () => {
  const detail = { state: "open", checks: [{ status: "pending" }], observedAt: 10 };
  expect(resolvePullRequestDetailChecks(detail, { state: "closed", checks: [{ status: "success" }], observedAt: 11 }, false)!.checks[0]!.status).toBe("success");
  expect(resolvePullRequestDetailChecks(detail, { state: "closed", checks: [{ status: "success" }], observedAt: 9 }, true)).toBe(detail);
  expect(resolvePullRequestDetailChecks({ ...detail, state: "merged" }, { state: "open", checks: [] as { status: string }[], observedAt: 11 }, false)!.state).toBe("merged");
  expect(resolvePullRequestDetailChecks({ state: "open", checks: [] as { status: string }[] }, { state: "open", checks: [{ status: "success" }] }, true)!.checks.length).toBe(1);
  expect(pullRequestChecksRefreshIntervalMs([])).toBe(45_000);
  expect(pullRequestChecksRefreshIntervalMs([{ status: "action-required" }])).toBe(45_000);
  expect(pullRequestChecksRefreshIntervalMs([{ status: "success" }])).toBe(60_000);
});

test("one refresh subscription per environment, shared and released; a pushed revision re-reads a mounted view once", async () => {
  resetPullRequestRefreshesForTest();
  const opened: string[] = [];
  let push: (() => void) | null = null;
  let closed = 0;
  const subscribe = (method: string, _payload: unknown, onValue: (value: unknown) => void) => { opened.push(method); push = () => onValue(1); return () => { closed += 1; }; };
  const a = retainPullRequestRefreshes("env", subscribe);
  const b = retainPullRequestRefreshes("env", subscribe);
  expect(opened).toEqual(["pullRequests.subscribeRefreshes"]);
  a(); expect(closed).toBe(0);
  b(); expect(closed).toBe(1);
  let reads = 0;
  usePullRequestRefreshes({ environmentId: () => "env2", connected: () => true, subscribe, onRefresh: () => { reads += 1; } });
  expect(opened.length).toBe(2);
  expect(reads).toBe(0);
  push!();
  await until(() => reads === 1);
  expect(reads).toBe(1);
  push!();
  await until(() => reads === 2);
  expect(reads).toBe(2);
  resetPullRequestRefreshesForTest();
});

test("invalidate sends {} or the normalized reference and never throws", async () => {
  const calls: Array<[string, unknown]> = [];
  await invalidatePullRequests(async (method, payload) => { calls.push([method, payload]); throw new Error("down"); }, {});
  await invalidatePullRequests(async (method, payload) => { calls.push([method, payload]); return null; }, { reference: { projectId: "p", repository: "o/r", number: 2, host: undefined } });
  expect(calls).toEqual([["pullRequests.invalidate", {}], ["pullRequests.invalidate", { reference: { projectId: "p", repository: "o/r", number: 2 } }]]);
});

test("detail refresh from host invalidates the reference first; checks come from pullRequests.checks when supported", async () => {
  const calls: Array<[string, unknown]> = [];
  const entry = signal<PullRequestEntry | null>({ projectId: "p", host: "github.com", repository: "o/r", number: 7, title: "T" } as unknown as PullRequestEntry);
  const detailPayload = { projectId: "p", repository: "o/r", number: 7, title: "T", state: "open", updatedAt: "2026-01-01T00:00:00Z", observedAt: 10, checks: [{ name: "ci", status: "pending" }] };
  const model = createPullRequestDetailModel({
    request: async (method, payload) => {
      calls.push([method, payload]);
      if (method === "pullRequests.detail") return detailPayload;
      if (method === "pullRequests.checks") return { observedAt: 20, state: "open", checks: [{ name: "ci", status: "success" }] };
      if (method === "pullRequests.activity") return { comments: [], commentCount: 0, commentsTruncated: false, reviewThreads: [] };
      return null;
    },
    entry: () => entry(),
    live: { environmentId: () => "primary", connected: () => false, subscribe: () => () => {}, supportsChecks: () => true },
  });
  await until(() => model.detail()?.checks[0]?.status === "success");
  expect(model.detail()!.checks[0]!.status).toBe("success");
  calls.length = 0;
  await model.refreshFromHost();
  expect(calls[0]).toEqual(["pullRequests.invalidate", { reference: { projectId: "p", host: "github.com", repository: "o/r", number: 7 } }]);
  expect(calls.map(([method]) => method)).toEqual(["pullRequests.invalidate", "pullRequests.detail", "pullRequests.activity", "pullRequests.checks"]);
});

test("relink: only a merged/closed persisted link on the thread's branch with a newer open request is replaced", () => {
  const base = {
    persisted: { projectId: "p", repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1" },
    persistedState: "merged",
    projectId: "p",
    projectRepository: "o/r",
    threadBranch: "feat",
    gitStatus: { refName: "feat", pr: { number: 2, url: "https://github.com/o/r/pull/2", state: "open", headRef: "feat" } },
  };
  expect(threadLinkedPullRequestReplacement(base)).toEqual({ projectId: "p", repository: "o/r", number: 2, url: "https://github.com/o/r/pull/2" });
  expect(threadLinkedPullRequestReplacement({ ...base, persistedState: "open" })).toBe(null);
  expect(threadLinkedPullRequestReplacement({ ...base, gitStatus: { ...base.gitStatus, refName: "main" } })).toBe(null);
  expect(threadLinkedPullRequestReplacement({ ...base, gitStatus: { refName: "feat", pr: { ...base.gitStatus.pr, number: 1 } } })).toBe(null);
  expect(threadLinkedPullRequestReplacement({ ...base, persisted: null })).toBe(null);
});

test("relink writes once per change, retargets the open panel, and toasts a failed write", async () => {
  const writes: unknown[] = [];
  const toasts: unknown[] = [];
  const opened: unknown[] = [];
  let fail = true;
  const persisted = { projectId: "p", repository: "o/r", number: 1, url: "u1" };
  const replacement = { projectId: "p", repository: "o/r", number: 2, url: "u2" };
  const step = createThreadLinkedPullRequestRelinker({
    updateMetadata: async (input) => { writes.push(input); if (fail) throw new Error("denied"); },
    openSurface: () => ({ kind: "pull-request", projectId: "p", repository: "O/R", number: 1 }),
    openPullRequest: (_id, target) => opened.push(target),
    toast: (input) => toasts.push(input),
  });
  await step("t", persisted, replacement);
  expect(writes).toEqual([{ threadId: "t", linkedPullRequest: replacement }]);
  expect(opened).toEqual([replacement]);
  expect(toasts).toEqual([{ type: "error", title: "Unable to update the thread pull request", description: "denied" }]);
  // The failure cleared the key, so the same replacement is written again.
  fail = false;
  await step("t", persisted, replacement);
  await step("t", persisted, replacement);
  expect(writes.length).toBe(2);
  expect(toasts.length).toBe(1);
});

const env = (id: string, extra: Partial<RoutingEnvironment> = {}): RoutingEnvironment => ({ id, enabled: true, supported: true, local: true, permission: "off", connected: true, supportsChecks: true, ...extra });

test("router: one environment (or no trust) sends every call straight to the origin, with no routing calls", async () => {
  const calls: string[] = [];
  const ref = { projectId: "p", repository: "o/r", number: 3 };
  let environments = [env("a")];
  const route = createPullRequestRouter({ environments: () => environments, request: async (id, tag) => { calls.push(`${id}:${tag}`); return { state: "open" }; } });
  await route("a", "pullRequests.detail", ref);
  await route("a", "pullRequests.runAction", { ...ref, action: "ready" });
  await route("a", "pullRequests.invalidate", {});
  environments = [env("a"), env("b")];
  await route("a", "pullRequests.checks", ref);
  expect(calls).toEqual(["a:pullRequests.detail", "a:pullRequests.runAction", "a:pullRequests.invalidate", "a:pullRequests.checks"]);
});

test("router: a trusted second environment with the same account answers; the origin hears reportState and later invalidates", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const ref = { projectId: "p", repository: "o/r", number: 3 };
  const identity = { accountId: "acct", host: "github.com", provider: "github", viewer: "me", projectTitle: "P", workspaceRoot: "/w" };
  const route = createPullRequestRouter({
    environments: () => [env("a", { permission: "read-write" }), env("b", { permission: "read-write" })],
    request: async (id, tag, input) => {
      calls.push([id, tag, input]);
      if (tag === "pullRequests.routing" || tag === "pullRequests.routingIdentity") return identity;
      if (id === "a" && tag === "pullRequests.detail") throw new Error("no account here");
      if (tag === "pullRequests.detail") return { projectId: "other", state: "merged" };
      return null;
    },
  });
  const answer = await route("a", "pullRequests.detail", ref) as Record<string, unknown>;
  expect(answer.projectId).toBe("p");
  expect(answer.projectTitle).toBe("P");
  await until(() => calls.some(([, tag]) => tag === "pullRequests.reportState"));
  const tags = calls.map(([id, tag]) => `${id}:${tag}`);
  expect(tags.slice(0, 2)).toEqual(["a:pullRequests.detail", "a:pullRequests.routing"]);
  expect(tags).toContain("b:pullRequests.routingIdentity");
  expect(tags).toContain("b:pullRequests.detail");
  expect(calls.find(([id, tag]) => id === "b" && tag === "pullRequests.detail")![2]).toEqual({ ...ref, allowStale: false, host: "github.com", expectedAccountId: "acct" });
  expect(calls.find(([, tag]) => tag === "pullRequests.reportState")!.slice(0, 2)).toEqual(["a", "pullRequests.reportState"]);
  calls.length = 0;
  await route("a", "pullRequests.invalidate", { reference: ref });
  const invalidated = calls.filter(([, tag]) => tag === "pullRequests.invalidate").map(([id]) => id).sort();
  expect(invalidated).toEqual(["a", "a", "b"]);
});
