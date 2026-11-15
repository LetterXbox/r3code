import { expect, open, test } from "nsh/test";
import { breakdownRows, checksCountLabel, checksRefreshIntervalMs, threadPanelPullRequestAction, trailingActionCopy } from "./ThreadDetailsPrRow";

test("the trailing action and its copy follow resolveThreadPanelPullRequestAction", () => {
  const detail = (patch: Record<string, unknown>) => ({ state: "open", isDraft: false, mergeability: "mergeable", checks: [], capabilities: { actions: ["merge", "ready"], mergeMethods: ["squash"] }, permissions: { actions: ["merge", "ready"] }, mergeCapabilities: { merge: false, squash: true, rebase: false }, ...patch }) as never;
  expect(threadPanelPullRequestAction(null)).toBe(null);
  expect(threadPanelPullRequestAction(detail({ mergeability: "conflicting" }))).toBe("resolve");
  expect(threadPanelPullRequestAction(detail({ isDraft: true }))).toBe("ready");
  expect(threadPanelPullRequestAction(detail({ checks: [{ status: "failure" }] }))).toBe("fix");
  expect(threadPanelPullRequestAction(detail({ checks: [{ status: "pending" }] }))).toBe(null);
  expect(threadPanelPullRequestAction(detail({}))).toBe("merge");
  expect(threadPanelPullRequestAction(detail({ state: "merged" }))).toBe(null);
  expect(trailingActionCopy("merge", "pull request", "squash")).toEqual({ label: "Merge", pendingLabel: "Merging...", destructive: false, tooltip: "Merge this pull request (squash)" });
  expect(trailingActionCopy("ready", "merge request", "merge").tooltip).toBe("Mark this merge request as ready for review");
  expect(checksRefreshIntervalMs([])).toBe(45_000);
  expect(checksRefreshIntervalMs([{ status: "success" } as never])).toBe(60_000);
  expect(checksCountLabel([{ status: "success" }, { status: "failure" }] as never)).toBe("1/2");
  expect(breakdownRows({ code: { additions: 10, deletions: 3 }, tests: { additions: 0, deletions: 0 }, docs: { additions: 1, deletions: 0 } })).toEqual([{ label: "Code", additions: 10, deletions: 3 }, { label: "Docs", additions: 1, deletions: 0 }]);
});

test("rows read the live detail: title, #N, checks count, Merge after confirm, Fix, Ready, Stop watching", async () => {
  const app = await open("./ThreadDetailsPrRowFixture.tsx", { width: 500, height: 600 });
  await expect(app.texts()).toContain("feat: add the thing");
  await expect(app.texts()).toContain("#1");
  await expect(app.texts()).toContain("2/2");
  await expect(app.texts()).toContain("1/3");
  await app.press("label:Checks 1 of 3 running · 1 failed");
  await expect(app.texts()).toContain("e2e");
  await expect(app.texts()).toContain("Show all");
  await app.press("label:Show all");
  await expect(app.texts()).toContain("lint");
  await expect(app.texts()).toContain("Fix");
  await expect(app.texts()).toContain("Ready");
  await app.press("label:Merge");
  await expect(app.texts()).toContain("Merge pull request?");
  await expect(app.texts()).toContain("This merges #1 using squash.");
  await app.press("label:Confirm");
  await expect(app.texts()).toContain("log pullRequests.runAction merge squash");
  await app.press("label:Ready");
  await expect(app.texts()).toContain("log pullRequests.runAction merge squash,pullRequests.runAction ready");
  await app.press("label:Stop watching #1");
  await expect(app.texts()).toContain("log pullRequests.runAction merge squash,pullRequests.runAction ready stopped 1");
});
