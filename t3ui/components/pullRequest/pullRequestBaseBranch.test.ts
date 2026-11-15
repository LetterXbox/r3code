import { expect, test } from "nsh/test";
import { resolveBaseFreshness } from "./pullRequestDetail.logic";
import { checkoutFailureDescription, pullRequestCheckoutCommand, repositoryUrlOf, changeRequestTerm } from "./pullRequestCheckout.logic";

const behind = { state: "open", mergeability: "mergeable", baseComparison: "behind", behindBy: 3, updateMethods: ["merge", "rebase"], viewerUpdateMethods: ["rebase"] };

test("a mergeable open pull request that fell behind offers the update methods the viewer may use", () => {
  expect(resolveBaseFreshness(behind)).toEqual({ behindBy: 3, methods: ["rebase"] });
  expect(resolveBaseFreshness({ ...behind, baseComparison: "up-to-date" })).toBeNull();
  expect(resolveBaseFreshness({ ...behind, state: "merged" })).toBeNull();
  expect(resolveBaseFreshness({ ...behind, mergeability: "conflicting" })).toBeNull();
});

test("each host has its own checkout command, or none", () => {
  const input = { number: 7, headBranch: "feature/x" };
  expect(pullRequestCheckoutCommand({ provider: "github", ...input })).toBe("gh pr checkout 7");
  expect(pullRequestCheckoutCommand({ provider: "gitlab", ...input })).toBe("glab mr checkout 7");
  expect(pullRequestCheckoutCommand({ provider: "forgejo", ...input })).toBeNull();
  expect(pullRequestCheckoutCommand({ provider: "forgejo", ...input, repositoryUrl: "https://codeberg.org/a/b" })).toBe("git fetch 'https://codeberg.org/a/b' refs/pull/7/head && git checkout -B pulls/7 FETCH_HEAD");
  expect(pullRequestCheckoutCommand({ provider: "bitbucket", ...input, headRepositoryNameWithOwner: "a/b" })).toBe("git clone --single-branch --branch feature/x https://bitbucket.org/a/b.git t3code-pr-7");
  expect(pullRequestCheckoutCommand({ provider: "bitbucket", number: 7, headBranch: "x; rm -rf", headRepositoryNameWithOwner: "a/b" })).toBeNull();
  expect(pullRequestCheckoutCommand({ provider: "azure-devops", ...input })).toBeNull();
});

test("the repository URL and the host's word for a change request come from the pull request", () => {
  expect(repositoryUrlOf("https://github.com/acme/t3code/pull/7")).toBe("https://github.com/acme/t3code");
  expect(repositoryUrlOf("https://gitlab.com/g/p/-/merge_requests/7")).toBe("https://gitlab.com/g/p");
  expect(repositoryUrlOf("not a url")).toBeNull();
  expect(changeRequestTerm("gitlab")).toBe("merge request");
  expect(changeRequestTerm("github")).toBe("pull request");
  expect(checkoutFailureDescription(new Error("  boom "))).toBe("boom");
  expect(checkoutFailureDescription(null)).toContain("Check that the branch still exists");
});

test("a checkout failure reads the host's words, a git failure adds its reason, and tool noise becomes the hint", async () => {
  const { RequestFailure } = await import("../../backend/client");
  const hint = "Check that the branch still exists and is not checked out elsewhere, then try again.";
  expect(checkoutFailureDescription(new RequestFailure("fatal: 'x' is already checked out", "GitCommandError", "branch-in-use"))).toBe("fatal: 'x' is already checked out (branch-in-use)");
  expect(checkoutFailureDescription(new RequestFailure("fatal: nope", "GitCommandError"))).toBe("fatal: nope");
  expect(checkoutFailureDescription(new Error("Pull request operation x failed: not mergeable"))).toBe("not mergeable");
  expect(checkoutFailureDescription(new Error("GitHub CLI failed."))).toBe(hint);
  expect(checkoutFailureDescription(new Error("exited with code 1"))).toBe(hint);
});
