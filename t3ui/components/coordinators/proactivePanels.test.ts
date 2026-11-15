// hooks/useProactivePanels.ts: the diff opens after a turn completes with enough changes, the linked pull request panel when a link appears,
// and a panel the user touched since wins. Fed with contract-shaped checkpoint rows (OrchestrationV2Checkpoint) and thread shell links.
import { expect, test } from "nsh/test";
import { checkpointSummaries, createProactivePanels, linkedTargetOf, resetProactivePanelsForTest, resolveProactiveTurnDiffAction, type ProactiveInput, type ProactiveRequest, type ProactivePanelsHost } from "./proactivePanels";
import type { Thread } from "../../store";

const checkpointRow = (runId: string, files: number, extra: Record<string, unknown> = {}) => ({
  id: `cp-${runId}`, threadId: "t", scopeId: "s", runId, appRunOrdinal: 1, status: "ready",
  files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, kind: "modified", additions: 1, deletions: 0 })), ...extra,
});

function fakeHost() {
  const opened: ProactiveRequest[] = [];
  let revision = 0;
  const host: ProactivePanelsHost = {
    userActionRevision: () => revision,
    activeSurface: () => null,
    openProactive: (request, expected) => { if (expected !== revision) return false; opened.push(request); return true; },
  };
  return { host, opened, userActs: () => { revision += 1; } };
}

const base: ProactiveInput = {
  threadKey: "k", enabled: true, settingsHydrated: true, threadDetailLoading: false, runningTurnId: null, latestRun: null, latestRunSettled: false,
  checkpoints: [], isGitRepo: true, linkedPullRequest: null, hasLinkedPullRequestDetail: false, pullRequestsKey: null,
  pullRequestsCapabilityKnown: true, supportsPullRequests: true, pullRequestsSurfaceAvailable: false, visiblePullRequestCount: 0,
};
const done = (runId: string, files: number): Partial<ProactiveInput> => ({
  latestRun: { runId, status: "completed" }, latestRunSettled: true, checkpoints: checkpointSummaries([checkpointRow(runId, files)]),
});

test("a completed turn that changed three files opens its diff; two files do not", () => {
  resetProactivePanelsForTest();
  const { host, opened } = fakeHost();
  const step = createProactivePanels(() => host);
  step({ ...base, runningTurnId: "r1" });
  step({ ...base, ...done("r1", 3) });
  expect(opened).toEqual([{ kind: "diff", turnId: "r1" }]);
  const second = fakeHost();
  const stepTwo = createProactivePanels(() => second.host);
  stepTwo({ ...base, threadKey: "k2", runningTurnId: "r2" });
  stepTwo({ ...base, threadKey: "k2", ...done("r2", 2) });
  expect(second.opened).toEqual([]);
});

test("fifty changed lines open the diff however few files", () => {
  expect(resolveProactiveTurnDiffAction({ checkpoint: { runId: "r", status: "ready", files: [{ additions: 40, deletions: 10 }] }, isGitRepo: true })).toBe("open");
  expect(resolveProactiveTurnDiffAction({ checkpoint: { runId: "r", status: "ready", files: [{ additions: 4, deletions: 1 }] }, isGitRepo: true })).toBe("ignore");
  expect(resolveProactiveTurnDiffAction({ checkpoint: undefined, isGitRepo: true })).toBe("defer");
  expect(resolveProactiveTurnDiffAction({ checkpoint: { runId: "r", status: "ready", files: [{ additions: 400, deletions: 0 }] }, isGitRepo: false })).toBe("ignore");
});

test("with the setting off nothing opens, and a panel the user touched during the turn wins", () => {
  resetProactivePanelsForTest();
  const off = fakeHost();
  const stepOff = createProactivePanels(() => off.host);
  stepOff({ ...base, enabled: false, runningTurnId: "r1" });
  stepOff({ ...base, enabled: false, ...done("r1", 5) });
  expect(off.opened).toEqual([]);
  const touched = fakeHost();
  const stepTouched = createProactivePanels(() => touched.host);
  stepTouched({ ...base, threadKey: "kk", runningTurnId: "r1" });
  touched.userActs();
  stepTouched({ ...base, threadKey: "kk", ...done("r1", 5) });
  expect(touched.opened).toEqual([]);
});

test("a link that appears opens the pull request panel; several links open the list", () => {
  resetProactivePanelsForTest();
  const one = fakeHost();
  const target = { projectId: "p", host: "github.com", repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7" };
  const stepOne = createProactivePanels(() => one.host);
  stepOne({ ...base, threadKey: "a" });
  stepOne({ ...base, threadKey: "a", linkedPullRequest: target, hasLinkedPullRequestDetail: true, pullRequestsKey: "[1]", pullRequestsSurfaceAvailable: true, visiblePullRequestCount: 1 });
  expect(one.opened).toEqual([{ kind: "pull-request", target }]);
  const many = fakeHost();
  const stepMany = createProactivePanels(() => many.host);
  stepMany({ ...base, threadKey: "b" });
  stepMany({ ...base, threadKey: "b", linkedPullRequest: target, hasLinkedPullRequestDetail: true, pullRequestsKey: "[1,2]", pullRequestsSurfaceAvailable: true, visiblePullRequestCount: 2 });
  expect(many.opened).toEqual([{ kind: "pull-requests" }]);
});

test("the newest visible link of a thread shell is the target", () => {
  const link = (number: number, linkedAt: string, source = "manual") => ({ host: "github.com", repository: "o/r", number, url: `https://github.com/o/r/pull/${number}`, source, linkedAt, snapshot: null, watching: false });
  const thread = { id: "t", projectId: "p", title: "t", status: "idle", pinned: false, updatedAt: 0, relations: { pullRequests: [link(1, "2026-01-01T00:00:00Z"), link(2, "2026-02-01T00:00:00Z"), link(3, "2026-03-01T00:00:00Z", "stack-dismissed")] } } as Thread;
  expect(linkedTargetOf(thread)?.number).toBe(2);
});

test("the right panel host opens the diff once, and refuses after the user changed the panel", async () => {
  const { panelHostFor } = await import("./proactivePanels");
  const { panelStateFor, updatePanel } = await import("../rightPanel/panelState");
  resetProactivePanelsForTest();
  const key = "proactive-test-1";
  const host = panelHostFor(key);
  const revision = host.userActionRevision();
  expect(host.openProactive({ kind: "diff", turnId: "r1" }, revision)).toBe(true);
  expect(panelStateFor(key).surfaces.some((surface) => surface.kind === "diff")).toBe(true);
  // The same turn is not offered twice.
  expect(host.openProactive({ kind: "diff", turnId: "r1" }, host.userActionRevision())).toBe(false);
  const other = "proactive-test-2";
  const hostTwo = panelHostFor(other);
  const before = hostTwo.userActionRevision();
  updatePanel(other, (state) => ({ ...state, open: true }));
  expect(hostTwo.openProactive({ kind: "diff", turnId: "r9" }, before)).toBe(false);
  expect(panelStateFor(other).surfaces.length).toBe(0);
});
