// What a pull request action says when it finishes, ported from usePullRequestActions.ts (actionSuccessLabels,
// actionFailureLabels, actionFailureHints) and readableFailure in pullRequestDetail.logic.ts: a failure shows what the
// host said when that is words, and a hint when it is only tool noise.
import type { PullRequestActionName } from "./pullRequestActions.logic";

const capitalize = (term: string) => term.charAt(0).toUpperCase() + term.slice(1);

export const actionSuccessLabels = (term: string): Record<PullRequestActionName, string> => ({
  merge: "Merge requested",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: `${capitalize(term)} closed`,
  reopen: `${capitalize(term)} reopened`,
  "update-branch": "Branch updated with the base branch",
  "enable-auto-merge": "Auto-merge enabled",
  "disable-auto-merge": "Auto-merge disabled",
  revert: `Revert ${term} opened`,
  "delete-branch": "Branch deleted",
  "approve-workflows": "Workflows approved",
});

export const actionFailureLabels = (term: string): Record<PullRequestActionName, string> => ({
  merge: `Could not merge this ${term}`,
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: `Could not close this ${term}`,
  reopen: `Could not reopen this ${term}`,
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not enable auto-merge",
  "disable-auto-merge": "Could not disable auto-merge",
  revert: `Could not open a revert ${term}`,
  "delete-branch": "Could not delete this branch",
  "approve-workflows": "Could not approve workflows",
});

export const actionFailureHints = (term: string): Record<PullRequestActionName, string> => ({
  merge: "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen: "The host refused it. Check that you have write access, and that the branch still exists.",
  "update-branch": "The host refused it. Check that you have write access, and that the base branch has not diverged in a way the host cannot merge.",
  "enable-auto-merge": "The host refused it. Check that auto-merge is enabled for this repository and that you have write access.",
  "disable-auto-merge": "The host refused it. Check that you have write access to this repository.",
  revert: `The host refused it. Check that you have write access and that this ${term} was merged on the host.`,
  "delete-branch": "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  "approve-workflows": "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
});

const OPERATION_PREFIX = /^Pull request operation \w+ failed:\s*/iu;
const HOST_LABELS = ["GitHub", "GitLab", "Bitbucket", "Azure DevOps", "Forgejo", "GitCafe", "Cursor Origin"].join("|");
const TOOL_NOISE = [
  new RegExp(`^(${HOST_LABELS})?\\s*(cli|api)?\\s*(command\\s*)?failed\\.?$`, "iu"),
  /^exited? with (code|status) \d+\.?$/iu,
  /^unknown error\.?$/iu,
];
const FAILURE_DETAIL_MAX_LENGTH = 320;

export function readableFailure(failure: unknown, hint: string): string {
  const raw = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.replace(OPERATION_PREFIX, "").trim();
  if (detail.length === 0 || TOOL_NOISE.some((pattern) => pattern.test(detail))) return hint;
  return detail.length <= FAILURE_DETAIL_MAX_LENGTH ? detail : `${detail.slice(0, FAILURE_DETAIL_MAX_LENGTH - 1)}…`;
}

/** PullRequestDetailPanel.tsx's own failure titles (the detail's actions; the list's quick actions keep the ones above). */
export const detailActionFailureLabels = (term: string): Record<PullRequestActionName, string> => ({
  ...actionFailureLabels(term),
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
});

/** PullRequestDetailPanel.tsx's own failure hints. */
export const detailActionFailureHints = (term: string): Record<PullRequestActionName, string> => ({
  ...actionFailureHints(term),
  "update-branch": "The host refused it. Check that you have write access to the branch (a fork branch also needs its author to allow edits from maintainers), and that it does not conflict with the base.",
  "enable-auto-merge": "The host refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
  "disable-auto-merge": "The host refused it. Check that you have write access, and that the merge has not already happened.",
});

/** UPDATE_BRANCH_REBASE_FAILURE_HINT: an update by rebase that failed. */
export const UPDATE_BRANCH_REBASE_FAILURE_HINT = "The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";
