import { expect, test } from "nsh/test";
import { pullRequestQuickActions } from "./pullRequestList.logic";
import { followSpeedMode, runQuickAction, speedMode } from "./pullRequestSpeed.logic";

const all = new Set(["close", "merge", "ready", "reopen"]);

test("the quick actions follow the pull request's state and what the host takes", () => {
  expect(pullRequestQuickActions({ state: "open", isDraft: false }, all)).toEqual(["close", "merge"]);
  expect(pullRequestQuickActions({ state: "open", isDraft: true }, all)).toEqual(["close", "ready"]);
  expect(pullRequestQuickActions({ state: "closed", isDraft: false }, all)).toEqual(["reopen"]);
  expect(pullRequestQuickActions({ state: "merged", isDraft: false }, all)).toEqual([]);
  expect(pullRequestQuickActions({ state: "open", isDraft: false }, new Set(["close"]))).toEqual(["close"]);
});

test("speed mode is Shift alone", () => {
  const mods = (shift: boolean, extra: Partial<{ control: boolean; alt: boolean; platform: boolean }> = {}) => ({ modifiers: { shift, control: false, alt: false, platform: false, ...extra } });
  followSpeedMode(mods(true));
  expect(speedMode()).toBe(true);
  followSpeedMode(mods(true, { platform: true }));
  expect(speedMode()).toBe(false);
  followSpeedMode(mods(true));
  followSpeedMode(mods(false));
  expect(speedMode()).toBe(false);
});

test("Merge reads the repository's allowed methods first; the others go straight to runAction", async () => {
  const sent: { method: string; payload: unknown }[] = [];
  const request = async (method: string, payload: unknown) => {
    sent.push({ method, payload });
    return method === "pullRequests.detail"
      ? { repository: "a/b", title: "T", number: 7, state: "open", capabilities: { mergeMethods: ["squash", "rebase"], actions: ["merge"] }, viewerPermissions: { actions: ["merge"] }, mergeCapabilities: { merge: false, squash: false, rebase: true } }
      : undefined;
  };
  const target = { projectId: "p", host: "github.com", repository: "a/b", number: 7 };
  await runQuickAction(request, target, "merge");
  expect(sent.map((call) => call.method)).toEqual(["pullRequests.detail", "pullRequests.runAction"]);
  expect(sent[0]!.payload).toEqual({ projectId: "p", host: "github.com", repository: "a/b", number: 7, allowStale: false });
  expect(sent[1]!.payload).toEqual({ projectId: "p", host: "github.com", repository: "a/b", number: 7, action: "merge", mergeMethod: "rebase", replyWithSummary: true });
  sent.length = 0;
  await runQuickAction(request, target, "close");
  expect(sent).toEqual([{ method: "pullRequests.runAction", payload: { projectId: "p", host: "github.com", repository: "a/b", number: 7, action: "close", replyWithSummary: true } }]);
  const none = async (method: string) => (method === "pullRequests.detail" ? { repository: "a/b", title: "T", number: 7, state: "open", capabilities: { mergeMethods: [], actions: ["merge"] }, viewerPermissions: { actions: ["merge"] }, mergeCapabilities: {} } : undefined);
  await expect(runQuickAction(none, target, "merge")).rejects.toThrow("No merge method is available for this repository.");
});

test("quick Merge refuses a draft, a closed or a stacked pull request and follows the project default", async () => {
  const target = { projectId: "p", repository: "a/b", number: 7 };
  const base = { repository: "a/b", title: "T", number: 7, state: "open", capabilities: { mergeMethods: ["merge", "squash"], actions: ["merge"] }, viewerPermissions: { actions: ["merge"] }, mergeCapabilities: { merge: true, squash: true } };
  await expect(runQuickAction(async () => ({ ...base, isDraft: true }), target, "merge")).rejects.toThrow("This pull request cannot be merged.");
  await expect(runQuickAction(async () => ({ ...base, state: "closed" }), target, "merge")).rejects.toThrow("This pull request cannot be merged.");
  await expect(runQuickAction(async (method) => method === "pullRequests.detail" ? { ...base, capabilities: { ...base.capabilities, stackActions: true } } : { layers: [] }, target, "merge")).rejects.toThrow("Open this pull request to merge its stack.");
  const sent: unknown[] = [];
  await runQuickAction(async (method, payload) => { sent.push(payload); return method === "pullRequests.detail" ? base : undefined; }, target, "merge", { projectDefault: "squash" });
  expect((sent[1] as { mergeMethod: string }).mergeMethod).toBe("squash");
});
