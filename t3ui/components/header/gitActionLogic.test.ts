import { expect, test } from "nsh/test";
import {
  behindUpstreamNote, canPublishRepository, inlineSuccessFor, quickActionDisabledReason, quietEmptyDraft, requiresDefaultBranchConfirmation, resolveDefaultBranchActionDialogCopy,
  resolveDefaultBranchGate, resolveFeatureBranchUnavailableReason, SOURCE_CONTROL_READ_ONLY,
} from "./gitActionLogic";
import type { VcsStatus } from "./gitLogic";

const status: VcsStatus = {
  isRepo: true, sourceControlProviderKind: "github", hasPrimaryRemote: true, isDefaultRef: true, refName: "main",
  hasWorkingTreeChanges: false, workingTree: { insertions: 0, deletions: 0 }, branchChanges: null, hasUpstream: true,
  aheadCount: 1, behindCount: 0, aheadOfDefaultCount: null, pr: null,
};
const pr = { shortLabel: "PR", singular: "pull request" };

test("only push, create_pr and their commit variants are confirmed, and only on the default ref", () => {
  for (const action of ["push", "create_pr", "commit_push", "commit_push_pr"] as const) {
    expect(requiresDefaultBranchConfirmation(action, true)).toBe(true);
    expect(requiresDefaultBranchConfirmation(action, false)).toBe(false);
  }
  expect(requiresDefaultBranchConfirmation("commit", true)).toBe(false);
});

test("the dialog copy follows the action and whether it commits", () => {
  expect(resolveDefaultBranchActionDialogCopy({ action: "push", branchName: "main", includesCommit: false, terminology: pr }).title).toBe("Push to default ref?");
  expect(resolveDefaultBranchActionDialogCopy({ action: "commit_push", branchName: "main", includesCommit: true, terminology: pr })).toEqual({
    title: "Commit & push to default ref?",
    description: 'This action will commit and push changes on "main". You can continue on this ref or create a feature ref and run the same action there.',
    continueLabel: "Commit & push to main",
  });
  expect(resolveDefaultBranchActionDialogCopy({ action: "create_pr", branchName: "main", includesCommit: false, terminology: pr }).title).toBe("Push & create PR from default ref?");
  expect(resolveDefaultBranchActionDialogCopy({ action: "commit_push_pr", branchName: "trunk", includesCommit: true, terminology: { shortLabel: "MR", singular: "merge request" } }).continueLabel).toBe("Commit, push & create MR");
});

test("a feature branch cannot be named from a clean tree", () => {
  expect(resolveFeatureBranchUnavailableReason({ branchName: "main", hasWorkingTreeChanges: true })).toBeNull();
  expect(resolveFeatureBranchUnavailableReason({ branchName: "main", hasWorkingTreeChanges: false })).toBe("There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on main.");
});

test("the gate opens on the default ref, not after a feature-branch choice, not when skipped, not detached", () => {
  expect(resolveDefaultBranchGate({ action: "push", status })).toEqual({ action: "push", branchName: "main", includesCommit: false });
  expect(resolveDefaultBranchGate({ action: "commit_push", status: { ...status, hasWorkingTreeChanges: true } })?.includesCommit).toBe(true);
  expect(resolveDefaultBranchGate({ action: "push", status, featureBranch: true })).toBeNull();
  expect(resolveDefaultBranchGate({ action: "push", status, skip: true })).toBeNull();
  expect(resolveDefaultBranchGate({ action: "push", status: { ...status, refName: null } })).toBeNull();
  expect(resolveDefaultBranchGate({ action: "push", status: { ...status, isDefaultRef: false } })).toBeNull();
});

test("a created PR reads Created PR, anything else the server's toast", () => {
  expect(inlineSuccessFor({ title: "Pushed", description: "x", created: true }, "github")).toEqual({ title: "Created PR", description: null });
  expect(inlineSuccessFor({ title: "Created MR 3", description: "d", created: true }, "gitlab")).toEqual({ title: "Created MR", description: null });
  expect(inlineSuccessFor({ title: "Pushed", description: "to origin", created: false }, "github")).toEqual({ title: "Pushed", description: "to origin" });
});

test("the behind note shows only for a clean, branch-attached tree that is behind and not ahead", () => {
  expect(behindUpstreamNote({ ...status, behindCount: 2, aheadCount: 0 })).toBe("Behind upstream. Pull/rebase first.");
  expect(behindUpstreamNote({ ...status, behindCount: 2, aheadCount: 1 })).toBeNull();
  expect(behindUpstreamNote({ ...status, behindCount: 2, aheadCount: 0, hasWorkingTreeChanges: true })).toBeNull();
  expect(behindUpstreamNote({ ...status, behindCount: 2, aheadCount: 0, refName: null })).toBeNull();
});

test("publishing needs write access and a repository with no primary remote", () => {
  expect(canPublishRepository({ canWrite: true, status: { ...status, hasPrimaryRemote: false } })).toBe(true);
  expect(canPublishRepository({ canWrite: false, status: { ...status, hasPrimaryRemote: false } })).toBe(false);
  expect(canPublishRepository({ canWrite: true, status })).toBe(false);
  expect(canPublishRepository({ canWrite: true, status: null })).toBe(false);
});

test("a read-only connection's reason wins over the action's own hint", () => {
  expect(quickActionDisabledReason({ canWrite: false, disabled: false, hint: undefined })).toBe(SOURCE_CONTROL_READ_ONLY);
  expect(quickActionDisabledReason({ canWrite: true, disabled: true, hint: "Git status is unavailable." })).toBe("Git status is unavailable.");
  expect(quickActionDisabledReason({ canWrite: true, disabled: true, hint: undefined })).toBe("This action is currently unavailable.");
  expect(quickActionDisabledReason({ canWrite: true, disabled: false, hint: undefined })).toBeNull();
});

test("an empty draft hides the rows until there is work", () => {
  const empty = { draft: true, noRunYet: false, busy: false, statusError: null, quickDisabled: true, insertions: 0, deletions: 0 };
  expect(quietEmptyDraft(empty)).toBe(true);
  expect(quietEmptyDraft({ ...empty, draft: false, noRunYet: true })).toBe(true);
  expect(quietEmptyDraft({ ...empty, draft: false })).toBe(false);
  expect(quietEmptyDraft({ ...empty, insertions: 3 })).toBe(false);
  expect(quietEmptyDraft({ ...empty, quickDisabled: false })).toBe(false);
  expect(quietEmptyDraft({ ...empty, statusError: "x" })).toBe(false);
  expect(quietEmptyDraft({ ...empty, busy: true })).toBe(false);
});
