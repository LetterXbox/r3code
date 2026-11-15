import { expect, test } from "nsh/test";
import { createPullRequestCheckoutModel, type CheckoutWorkspace } from "./pullRequestCheckoutModel";

function harness(overrides: { request?: (method: string, payload: unknown) => Promise<unknown>; path?: string | null; thread?: string | null; select?: (w: CheckoutWorkspace) => void } = {}) {
  const calls: { method: string; payload: unknown }[] = [];
  const toasts: { id: string; type: string; title: string; description?: string }[] = [];
  const workspaces: CheckoutWorkspace[] = [];
  const model = createPullRequestCheckoutModel({
    request: overrides.request ?? (async (method, payload) => { calls.push({ method, payload }); return { branch: "feature", worktreePath: null, isOnPullRequestHead: true }; }),
    subject: () => ({ url: "https://github.com/a/b/pull/7", projectId: "p1", term: "pull request" }),
    projectPath: () => (overrides.path === undefined ? "/repo" : overrides.path),
    newThread: () => (overrides.thread === undefined ? "thread:1" : overrides.thread),
    selectWorkspace: overrides.select ?? ((workspace) => { workspaces.push(workspace); }),
    toasts: {
      show: (input) => { toasts.push({ id: "t", ...input }); return "t"; },
      update: (_id, input) => { toasts.push({ id: "t", ...input }); },
    },
  });
  return { model, calls, toasts, workspaces };
}

test("a worktree checkout asks the server by pull request URL, then points the thread at the worktree", async () => {
  const h = harness({ request: async (method, payload) => { h.calls.push({ method, payload }); return { branch: "feature", worktreePath: "/wt", isOnPullRequestHead: true }; } });
  expect(await h.model.start("worktree")).toBe(true);
  expect(h.calls).toEqual([{ method: "git.preparePullRequestThread", payload: { cwd: "/repo", reference: "https://github.com/a/b/pull/7", mode: "worktree", threadId: "thread:1" } }]);
  expect(h.workspaces).toEqual([{ type: "existing_worktree", worktreePath: "/wt", branch: "feature" }]);
  expect(h.toasts.map((t) => t.title)).toEqual(["Preparing the pull request checkout...", "Checked out"]);
  expect(h.model.handoff()).toBeNull();
});

test("a local checkout switches the repository's branch", async () => {
  const h = harness();
  await h.model.start("local");
  expect(h.workspaces).toEqual([{ type: "root", branch: "feature" }]);
  expect(h.toasts[1]).toMatchObject({ type: "success", title: "Checked out here" });
});

test("a checkout not confirmed on the head says so", async () => {
  const h = harness({ request: async () => ({ branch: "feature", worktreePath: "/wt", isOnPullRequestHead: false }) });
  await h.model.start("worktree");
  expect(h.toasts[1]).toMatchObject({ type: "warning", title: "Checked out, but not confirmed on the latest commit" });
});

test("a server refusal, a missing project folder, no thread and a started thread each stop with their own words", async () => {
  const refused = harness({ request: async () => { throw new Error("branch is checked out elsewhere"); } });
  expect(await refused.model.start("local")).toBe(false);
  expect(refused.toasts[1]).toMatchObject({ type: "error", title: "Could not prepare the pull request checkout", description: "branch is checked out elsewhere" });
  expect(refused.model.handoff()).toBeNull();

  const noPath = harness({ path: null });
  expect(await noPath.model.start("local")).toBe(false);
  expect(noPath.toasts).toEqual([]);

  const noThread = harness({ thread: null });
  expect(await noThread.model.start("local")).toBe(false);
  expect(noThread.toasts[1]).toMatchObject({ title: "Could not open a thread for the checkout" });
  expect(noThread.calls).toEqual([]);

  const started = harness({ select: () => { throw new Error("Workspace can only be changed before the thread starts"); } });
  expect(await started.model.start("local")).toBe(false);
  expect(started.toasts[1]).toMatchObject({ type: "error", title: "Checked out, but the thread stayed where it was", description: "The checkout is ready on `feature`. Point a thread at it from the branch picker, then ask again." });
});
