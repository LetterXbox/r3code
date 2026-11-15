// The toast after a checkout that could not be confirmed on the pull request's head (pullRequestCheckoutToast.ts).
import { offHeadCheckoutToast } from "./pullRequestEditing.logic";

export function offHeadPullRequestCheckoutToast(term: string) {
  return { type: "warning" as const, ...offHeadCheckoutToast(term) };
}
