import { expect, test } from "nsh/test";
import { clearToasts, toasts } from "../toast/toastState";
import { actionFailureHints, actionFailureLabels, actionSuccessLabels, readableFailure } from "./pullRequestActionCopy";
import { createPullRequestActionsModel } from "./pullRequestActionsModel";
import { canPerform } from "./pullRequestActions.logic";
import { parseDetail } from "./pullRequestDetail.logic";

test("action titles and hints follow the host's word for a change request", () => {
  expect(actionSuccessLabels("merge request").revert).toBe("Revert merge request opened");
  expect(actionSuccessLabels("pull request").merge).toBe("Merge requested");
  expect(actionSuccessLabels("pull request")["update-branch"]).toBe("Branch updated with the base branch");
  expect(actionFailureLabels("pull request")["approve-workflows"]).toBe("Could not approve workflows");
  expect(actionFailureLabels("merge request")["delete-branch"]).toBe("Could not delete this branch");
  expect(actionFailureHints("pull request").revert).toBe("The host refused it. Check that you have write access and that this pull request was merged on the host.");
});

test("a failure says what the host said, or the hint when it only said that a tool failed", () => {
  expect(readableFailure(new Error("Pull request operation runAction failed: Base branch was modified"), "hint")).toBe("Base branch was modified");
  expect(readableFailure(new Error("GitHub CLI failed."), "hint")).toBe("hint");
  expect(readableFailure(new Error("exited with code 1"), "hint")).toBe("hint");
  expect(readableFailure(new Error(""), "hint")).toBe("hint");
  expect(readableFailure("x".repeat(400), "hint")).toHaveLength(320);
});

function harness(request: (method: string, payload: unknown) => Promise<unknown>) {
  const calls: { method: string; payload: unknown }[] = [];
  let refreshed = 0;
  const model = createPullRequestActionsModel({
    request: async (method, payload) => { calls.push({ method, payload }); return request(method, payload); },
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    refresh: async () => { refreshed++; },
    allowedMethods: () => ["merge"],
    term: () => "merge request",
  });
  return { model, calls, refreshed: () => refreshed };
}

test("revert and delete branch run the host action and toast the reference's titles", async () => {
  clearToasts();
  const h = harness(async () => ({}));
  expect(await h.model.perform("revert")).toBe(true);
  expect(await h.model.perform("delete-branch")).toBe(true);
  expect(h.calls.map((call) => call.payload)).toEqual([
    { projectId: "p", repository: "o/r", number: 7, action: "revert" },
    { projectId: "p", repository: "o/r", number: 7, action: "delete-branch" },
  ]);
  expect(h.calls.every((call) => call.method === "pullRequests.runAction")).toBe(true);
  expect(toasts().map((toast) => toast.title).reverse()).toEqual(["Revert merge request opened", "Branch deleted"]);
  expect(h.refreshed()).toBe(2);
  expect(h.model.pending()).toBeNull();
});

test("a refused action toasts its failure title with the host's words and does not refresh", async () => {
  clearToasts();
  const h = harness(async () => { throw new Error("Pull request operation runAction failed: not allowed"); });
  expect(await h.model.perform("delete-branch")).toBe(false);
  const toast = toasts()[0]!;
  expect(toast.title).toBe("Could not delete this branch");
  expect(toast.description).toBe("not allowed");
  expect(h.refreshed()).toBe(0);
  expect(h.model.pending()).toBeNull();
  const noisy = harness(async () => { throw new Error("GitLab API failed"); });
  await noisy.model.perform("merge");
  expect(toasts()[0]?.description).toBe(actionFailureHints("merge request").merge);
});

test("delete branch is offered for a closed or merged change whose host and viewer allow it", () => {
  const closed = parseDetail({
    projectId: "p", repository: "o/r", number: 7, title: "T", state: "closed", headBranch: "h", baseBranch: "main",
    capabilities: { diff: true, comment: true, actions: ["delete-branch", "revert"], mergeMethods: [], deleteBranch: true, review: {}, reviewers: {} },
    viewerPermissions: { actions: ["delete-branch"] },
  });
  expect(closed.capabilities.deleteBranch).toBe(true);
  expect(canPerform(closed, "delete-branch")).toBe(true);
  // The viewer may not revert: the host lists the action but the viewer's permissions do not.
  expect(canPerform(closed, "revert")).toBe(false);
});

test("Close with comment posts the comment, then closes; a failed comment stops there with the reference's toast", async () => {
  clearToasts();
  const ok = harness(async () => ({}));
  expect(await ok.model.commentAction("  Done here  ", "close")).toEqual({ commentPosted: true });
  expect(ok.calls.map((call) => call.method)).toEqual(["pullRequests.comment", "pullRequests.runAction"]);
  expect(ok.calls[0]!.payload).toEqual({ projectId: "p", repository: "o/r", number: 7, body: "Done here" });
  expect(ok.calls[1]!.payload).toEqual({ projectId: "p", repository: "o/r", number: 7, action: "close" });
  clearToasts();
  const failing = harness(async (method) => { if (method === "pullRequests.comment") throw new Error("nope"); return {}; });
  expect(await failing.model.commentAction("Reopen please", "reopen")).toEqual({ commentPosted: false });
  expect(failing.calls.map((call) => call.method)).toEqual(["pullRequests.comment"]);
  expect(toasts().map((toast) => toast.title)).toEqual(["Could not post the comment"]);
  clearToasts();
  expect(await failing.model.comment("plain")).toBe(false);
  expect(toasts().map((toast) => toast.title)).toEqual(["Could not post the comment"]);
});

test("closing the label picker sends its picks; a refusal says which label and asks for triage access", async () => {
  clearToasts();
  const h = harness(async (method) => {
    if (method === "pullRequests.labelCandidates") return { candidates: [{ name: "bug", color: "d73a4a", description: "", isApplied: true }], truncated: true };
    if (method === "pullRequests.setLabels") throw new Error("GitHub CLI failed.");
    return {};
  });
  h.model.toggleLabelsMenu();
  for (let i = 0; i < 50 && h.model.labelsStatus() !== "loaded"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.model.labelsTruncated()).toBe(true);
  h.model.toggleLabel("bug");
  expect(h.calls.some((call) => call.method === "pullRequests.setLabels")).toBe(false);
  await h.model.toggleLabelsMenu();
  expect(h.calls.at(-1)?.payload).toEqual({ projectId: "p", repository: "o/r", number: 7, labels: ["bug"], applied: false });
  expect(toasts().map((toast) => [toast.title, toast.description])).toEqual([["Could not take bug off", "The host refused it. Check that you have triage access on this repository."]]);
});

test("the label picker batches additions and removals and drops undone toggles", async () => {
  const h = harness(async (method) => method === "pullRequests.labelCandidates"
    ? { candidates: ["bug", "docs", "tests", "undo"].map((name) => ({ name, color: "aaaaaa", isApplied: name === "bug" })) }
    : {});
  await h.model.toggleLabelsMenu();
  for (const name of ["bug", "docs", "tests", "undo", "undo"]) h.model.toggleLabel(name);
  expect(h.calls.filter((call) => call.method === "pullRequests.setLabels")).toEqual([]);
  await h.model.toggleLabelsMenu();
  expect(h.calls.filter((call) => call.method === "pullRequests.setLabels").map((call) => call.payload)).toEqual([
    { projectId: "p", repository: "o/r", number: 7, labels: ["docs", "tests"], applied: true },
    { projectId: "p", repository: "o/r", number: 7, labels: ["bug"], applied: false },
  ]);
});

test("the detail's failures toast the detail panel's own titles", async () => {
  clearToasts();
  const h = harness(async () => { throw new Error("GitHub CLI failed."); });
  await h.model.perform("enable-auto-merge");
  await h.model.updateBranch("rebase");
  await h.model.updateBody("new body");
  await h.model.replyToThread("t1", "hi");
  await h.model.setThreadResolved("t1", true);
  expect(await h.model.loadThreadComments("t1", "c")).toBe(null);
  expect(toasts().map((toast) => toast.title).reverse()).toEqual([
    "Could not turn on auto-merge", "Could not update this branch", "Could not save the description",
    "Reply could not be posted", "The conversation could not be updated", "More comments could not be loaded",
  ]);
  expect(toasts().find((toast) => toast.title === "Could not update this branch")?.description).toBe("The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.");
});

const waitUntil = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
const reviewerA = { id: "u1", kind: "user", login: "ana", name: "Ana", avatarUrl: "", isRequested: false };

test("closing the reviewer picker sends one request for the selected people", async () => {
  const h = harness(async () => ({}));
  await h.model.toggleReviewersMenu();
  h.model.toggleReviewer(reviewerA);
  h.model.toggleReviewer({ ...reviewerA, id: "u2", login: "mona" });
  expect(h.calls.filter((call) => call.method === "pullRequests.requestReviewers")).toEqual([]);
  await h.model.toggleReviewersMenu();
  expect(h.calls.filter((call) => call.method === "pullRequests.requestReviewers").map((call) => call.payload)).toEqual([
    { projectId: "p", repository: "o/r", number: 7, reviewers: [{ id: "u1", kind: "user" }, { id: "u2", kind: "user" }], requested: true },
  ]);
});

test("asking for a review toasts both ends, with the host's words or the hint on a refusal", async () => {
  clearToasts();
  const h = harness(async () => ({}));
  await h.model.toggleReviewersMenu();
  h.model.toggleReviewer(reviewerA);
  expect(await h.model.toggleReviewersMenu()).toBe(true);
  expect(toasts().map((toast) => toast.title)).toEqual(["Review requested from ana"]);
  clearToasts();
  const refused = harness(async () => { throw new Error("GitHub CLI failed."); });
  await refused.model.toggleReviewersMenu();
  refused.model.toggleReviewer({ ...reviewerA, isRequested: true });
  expect(await refused.model.toggleReviewersMenu()).toBe(false);
  expect(toasts().map((toast) => [toast.title, toast.description])).toEqual([["Could not take back the review request to ana", "The host refused it. Check that you have write access on this repository, and that they still have access to it."]]);
  clearToasts();
  const said = harness(async () => { throw new Error("Pull request operation requestReviewers failed: ana cannot review her own change"); });
  await said.model.toggleReviewersMenu();
  said.model.toggleReviewer(reviewerA);
  await said.model.toggleReviewersMenu();
  expect(toasts()[0]?.title).toBe("Could not ask ana for a review");
  expect(toasts()[0]?.description).toBe("ana cannot review her own change");
});

test("an approval toasts the host's word for a change request; a refusal keeps the draft", async () => {
  clearToasts();
  const h = harness(async () => ({}));
  expect(await h.model.submitReview("approve", "")).toBe(true);
  expect(toasts().map((toast) => toast.title)).toEqual(["Merge request approved"]);
  clearToasts();
  expect(await h.model.submitReview("request-changes", "Please fix")).toBe(true);
  expect(toasts().map((toast) => toast.title)).toEqual(["Changes requested"]);
  clearToasts();
  const refused = harness(async () => { throw new Error("GitHub CLI failed."); });
  expect(await refused.model.submitReview("comment", "hello")).toBe(false);
  expect(toasts().map((toast) => [toast.title, toast.description])).toEqual([["The review could not be submitted", "The host refused the review. Your draft is still here to try again."]]);
});

test("maintainer access: a refusal says what the host said, else Try again", async () => {
  clearToasts();
  const h = harness(async () => { throw new Error("GitHub CLI failed."); });
  expect(await h.model.setMaintainerEdits(true, { key: "k", observedAt: 1 })).toBe(false);
  expect(toasts().map((toast) => [toast.title, toast.description])).toEqual([["Could not save maintainer access", "Try again."]]);
});

test("a stack action's refusal holds the host's words or the hint, and the panel is read again either way", async () => {
  const refused = harness(async () => { throw new Error("GitHub CLI failed."); });
  expect(await refused.model.runStackAction(() => ({ action: "merge" }), "Stack merge request completed", "stack hint")).toBe(false);
  expect(refused.model.error()).toBe("stack hint");
  expect(refused.refreshed()).toBe(1);
  const said = harness(async () => { throw new Error("Pull request operation runAction failed: layer 2 is blocked"); });
  await said.model.runStackAction(() => ({ action: "merge" }), "ok", "hint");
  expect(said.model.error()).toBe("layer 2 is blocked");
  const ok = harness(async () => ({}));
  expect(await ok.model.runStackAction(() => ({ action: "merge" }), "Stack rebased")).toBe(true);
  expect(ok.model.notice()).toBe("Stack rebased");
  expect(ok.refreshed()).toBe(1);
  expect(ok.model.pending()).toBeNull();
});

test("past the first page the host is asked for the typed name, and its answer joins the list", async () => {
  const first = { candidates: [reviewerA], truncated: true };
  const found = { id: "u9", kind: "user", login: "zed", name: "Zed", avatarUrl: "", isRequested: false };
  const calls: unknown[] = [];
  let hostDown = false;
  const model = createPullRequestActionsModel({
    request: async (method, payload) => { calls.push({ method, payload }); if (!(payload as { query?: string }).query) return first; if (hostDown) throw new Error("search is down"); return { candidates: [found], truncated: false }; },
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    refresh: async () => undefined,
    allowedMethods: () => [],
    reviewerSearchable: () => true,
  });
  model.toggleReviewersMenu();
  await waitUntil(() => model.reviewersStatus() === "loaded");
  expect(model.reviewersTruncationNote()).toBe("This repository has more people with access than are listed here. Search to find them.");
  model.reviewerQuery.set("zed");
  // Nothing matches yet and the host has not answered, which is not "nobody matches".
  expect(model.reviewersPending()).toBe(true);
  await waitUntil(() => model.visibleReviewers().length === 1);
  expect(model.visibleReviewers().map((c) => c.login)).toEqual(["zed"]);
  expect(calls.at(-1)).toEqual({ method: "pullRequests.reviewerCandidates", payload: { projectId: "p", repository: "o/r", number: 7, query: "zed" } });
  expect(model.reviewersTruncationNote()).toBeNull();
  // The host search itself failing says so and keeps matching the people already listed.
  hostDown = true;
  model.reviewerQuery.set("an");
  await waitUntil(() => model.reviewersTruncationNote()?.startsWith("Only the people already listed") === true);
  expect(model.reviewersTruncationNote()).toBe("Only the people already listed are matched: the host search failed. search is down");
  expect(model.visibleReviewers().map((c) => c.login)).toEqual(["ana"]);
});
