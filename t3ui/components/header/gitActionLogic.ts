// The pure rules GitActionsControl.tsx / GitActionsControl.logic.ts add around the Git actions row: which
// actions ask before running on the default ref, that dialog's copy, the inline success window, the
// "Behind upstream" note and the empty-draft quieting. No signals and no RPC, so they are tested without an engine.
import { changeRequestTerms, type GitStackedAction, type VcsStatus } from "./gitLogic";

/** The actions that run against the default ref and so ask first (requiresDefaultBranchConfirmation). */
export type DefaultBranchConfirmableAction = "push" | "create_pr" | "commit_push" | "commit_push_pr";

export function requiresDefaultBranchConfirmation(action: GitStackedAction, isDefaultBranch: boolean): action is DefaultBranchConfirmableAction {
  if (!isDefaultBranch) return false;
  return action === "push" || action === "create_pr" || action === "commit_push" || action === "commit_push_pr";
}

export interface DefaultBranchActionDialogCopy { title: string; description: string; continueLabel: string }

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: { shortLabel: string; singular: string };
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this ref or create a feature ref and run the same action there.`;
  const { terminology } = input;
  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return { title: "Commit & push to default ref?", description: `This action will commit and push changes${suffix}`, continueLabel: `Commit & push to ${branchLabel}` };
    }
    return { title: "Push to default ref?", description: `This action will push local commits${suffix}`, continueLabel: `Push to ${branchLabel}` };
  }
  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ref?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ref?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}

/** Clean trees cannot create feature branches because the server derives names from uncommitted changes. */
export function resolveFeatureBranchUnavailableReason(input: { branchName: string; hasWorkingTreeChanges: boolean }): string | null {
  if (input.hasWorkingTreeChanges) return null;
  return `There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on ${input.branchName}.`;
}

/** What `runGitActionWithToast` decides before it runs: whether the dialog opens and what it shows. */
export interface DefaultBranchGate {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}

/**
 * `null` when the action runs at once. A feature-branch run is never on the default ref
 * (`actionIsDefaultBranch = featureBranch ? false : isDefaultRef`); a detached HEAD has no branch to name.
 */
export function resolveDefaultBranchGate(input: { action: GitStackedAction; status: VcsStatus | null; featureBranch?: boolean; skip?: boolean }): DefaultBranchGate | null {
  if (input.skip) return null;
  const isDefault = input.featureBranch ? false : input.status?.isDefaultRef ?? false;
  const branch = input.status?.refName ?? null;
  if (!requiresDefaultBranchConfirmation(input.action, isDefault) || !branch) return null;
  const canCommit = input.action === "commit_push" || input.action === "commit_push_pr";
  const includesCommit = canCommit && (!!input.status?.hasWorkingTreeChanges || input.featureBranch === true);
  return { action: input.action, branchName: branch, includesCommit };
}

/** The write-scope refusal GitActionsControl shows on a connection that may not change source control. */
export const SOURCE_CONTROL_READ_ONLY = "This connection cannot change source control.";

/** GIT_ACTION_SUCCESS_VISIBLE_MS: how long the row keeps a finished action's title. */
export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

/** The inline success after an action: a created PR reads `Created PR` with no description, anything else the server's toast. */
export function inlineSuccessFor(result: { title: string; description: string | null; created: boolean }, providerKind: string | null): { title: string; description: string | null } {
  return result.created ? { title: `Created ${changeRequestTerms(providerKind).shortLabel}`, description: null } : { title: result.title, description: result.description };
}

/** The dropdown's note under its rows when the branch is only behind (GitActionsControl's `gitItems`). */
export function behindUpstreamNote(status: VcsStatus | null): string | null {
  if (!status || status.refName === null || status.hasWorkingTreeChanges) return null;
  return status.behindCount > 0 && status.aheadCount === 0 ? "Behind upstream. Pull/rebase first." : null;
}

/** `canPublishRepository`: a repository with no primary remote, on a connection that may write. */
export function canPublishRepository(input: { canWrite: boolean; status: VcsStatus | null }): boolean {
  return input.canWrite && input.status !== null && input.status.isRepo && !input.status.hasPrimaryRemote;
}

/**
 * `quietEmptyDraft`: a fresh draft, or a thread with no turn yet, hides the commit, push and diff rows until there is
 * work. `statusError` is the status stream's message; an unavailable action or empty totals are what "no work" means.
 */
export function quietEmptyDraft(input: { draft: boolean; noRunYet: boolean; busy: boolean; statusError: string | null; quickDisabled: boolean; insertions: number; deletions: number }): boolean {
  return (input.draft || input.noRunYet) && !input.busy && !input.statusError && input.quickDisabled && !input.insertions && !input.deletions;
}

/** What a quick action's press does: its reason when the connection cannot write, then the press kind. */
export function quickActionDisabledReason(input: { canWrite: boolean; disabled: boolean; hint: string | undefined }): string | null {
  if (!input.canWrite) return SOURCE_CONTROL_READ_ONLY;
  return input.disabled ? input.hint ?? "This action is currently unavailable." : null;
}
