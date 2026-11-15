// Checking a pull request out: the command to copy for each host (the hosts' source-control definitions'
// `checkoutCommand`) and the words the toasts use. The web reads these from sourceControlClients.
import { readableFailure } from "./pullRequestActionCopy";

/** The host's word for a change request, as in "pull request". */
export function changeRequestTerm(provider: string): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** The repository's web URL, read from a change request's URL (`.../pull/7`, `.../-/merge_requests/7`, `.../pulls/7`). */
export function repositoryUrlOf(url: string): string | null {
  const stripped = url.replace(/\/(?:-\/)?(?:pull|pulls|merge_requests|pull-requests)\/\d+.*$/u, "");
  return stripped !== url && /^https?:\/\//u.test(stripped) ? stripped : null;
}

const SAFE_SHELL = /^[A-Za-z0-9._/@+=,-]+$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

export function pullRequestCheckoutCommand(input: {
  provider: string; number: number; headBranch: string; headRepositoryNameWithOwner?: string | null; repositoryUrl?: string | null;
}): string | null {
  switch (input.provider) {
    case "github": return `gh pr checkout ${input.number}`;
    case "gitlab": return `glab mr checkout ${input.number}`;
    case "cursor-origin": return `origin pr checkout ${input.number}`;
    case "gitcafe": return `cafe pr checkout ${input.number}`;
    // Neither `fj` nor `tea` checks out by number.
    case "forgejo":
      return input.repositoryUrl
        ? `git fetch '${input.repositoryUrl.replaceAll("'", "'\\''")}' refs/pull/${input.number}/head && git checkout -B pulls/${input.number} FETCH_HEAD`
        : null;
    // Bitbucket has no checkout CLI.
    case "bitbucket":
      return input.headRepositoryNameWithOwner && REPOSITORY_NAME.test(input.headRepositoryNameWithOwner) && SAFE_SHELL.test(input.headBranch)
        ? `git clone --single-branch --branch ${input.headBranch} https://bitbucket.org/${input.headRepositoryNameWithOwner}.git t3code-pr-${input.number}`
        : null;
    default: return null;
  }
}

/**
 * checkoutFailureDescription: a git failure reads "detail (reason)", then readableFailure's rule (the host's words, or the hint
 * when it only said that a tool failed).
 */
export function checkoutFailureDescription(failure: unknown): string {
  const git = failure instanceof Error && (failure as { tag?: unknown }).tag === "GitCommandError" ? (failure as { reason?: unknown }) : null;
  const reason = typeof git?.reason === "string" && git.reason ? git.reason : null;
  const described = failure instanceof Error && reason !== null ? `${failure.message} (${reason})` : failure;
  return readableFailure(described, "Check that the branch still exists and is not checked out elsewhere, then try again.");
}
