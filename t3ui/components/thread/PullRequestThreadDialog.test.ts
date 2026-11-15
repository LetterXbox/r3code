import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { createPullRequestThreadDialogModel, resetPullRequestResolutionsForTest, sourceControlTerminology } from "./PullRequestThreadDialog";
import { pullRequestBadgeFromShell } from "../sidebar/threadMeta";

const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

function make(answer: (method: string, payload: unknown) => Promise<unknown>) {
  const calls: Array<[string, unknown]> = [];
  const prepared: unknown[] = [];
  let closed = false;
  const model = createPullRequestThreadDialogModel({
    request: (method, payload) => { calls.push([method, payload]); return answer(method, payload); },
    cwd: () => "/repo", threadId: () => "t1", initialReference: "#42", open: () => true,
    terminology: () => sourceControlTerminology("github"),
    onPrepared: (input) => { prepared.push(input); }, onClose: () => { closed = true; }, debounceMs: 20,
  });
  return { model, calls, prepared, closed: () => closed };
}

test("a reference resolves through git.resolvePullRequest, then Worktree prepares the thread with its id", async () => {
  resetPullRequestResolutionsForTest();
  const { model, calls, prepared, closed } = make(async (method) => method === "git.resolvePullRequest"
    ? { pullRequest: { number: 42, title: "Fix it", url: "u", baseBranch: "main", headBranch: "fix", state: "open" } }
    : { branch: "fix", worktreePath: "/wt", isOnPullRequestHead: true });
  await until(() => model.resolvedPullRequest() !== null);
  expect(calls[0]).toEqual(["git.resolvePullRequest", { cwd: "/repo", reference: "42" }]);
  expect(model.resolvedPullRequest()!.title).toBe("Fix it");
  await model.confirm("worktree");
  expect(calls[1]).toEqual(["git.preparePullRequestThread", { cwd: "/repo", reference: "42", mode: "worktree", threadId: "t1" }]);
  expect(prepared).toEqual([{ branch: "fix", worktreePath: "/wt" }]);
  expect(closed()).toBe(true);
});

test("the server's resolve error shows; an unparsable reference shows the validation copy", async () => {
  resetPullRequestResolutionsForTest();
  const { model } = make(async () => { throw new Error("GitHub CLI failed to resolve pull request: no git remotes found"); });
  await until(() => model.errorMessage() !== null);
  expect(model.errorMessage()).toBe("GitHub CLI failed to resolve pull request: no git remotes found");
  expect(model.canConfirm()).toBe(false);
  model.dirty.set(true);
  model.reference.set("not a pr");
  expect(model.errorMessage()).toBe("Use a pull request URL, checkout command, 123, or #123.");
  model.reference.set("");
  expect(model.errorMessage()).toBe("Paste a pull request URL, checkout command, or enter 123 / #123.");
});

test("a legacy linked or branch pull request badge carries its reference for the summary read", () => {
  const badge = pullRequestBadgeFromShell({ branchPullRequest: { projectId: "p", repository: "o/r", number: 5, url: "https://github.com/o/r/pull/5" } });
  expect(badge!.fallback).toEqual({ kind: "branch", projectId: "p", repository: "o/r", number: 5, url: "https://github.com/o/r/pull/5" });
  void signal;
});
