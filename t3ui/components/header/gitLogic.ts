// Ported from GitActionsControl.logic.ts: which quick action the Git actions
// row offers for a status, and what its dropdown lists. Pure, so it is tested
// without an engine.
import { summarizeChangedFiles } from "../diff/changedFileKind";

export interface VcsStatus {
  isRepo: boolean;
  sourceControlProviderKind: string | null;
  hasPrimaryRemote: boolean;
  isDefaultRef: boolean;
  refName: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: { insertions: number; deletions: number; files?: ChangedFile[] };
  branchChanges: { baseRef: string | null; insertions: number; deletions: number; files?: ChangedFile[] } | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number | null;
  pr: { number: number; title: string; url: string; state: "open" | "closed" | "merged"; /** VcsStatusResult.pr.headRef. */ headRef?: string } | null;
}

export interface ChangedFile { path: string; insertions: number; deletions: number }

export type GitStackedAction = "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
export type GitActionIconName = "commit" | "push" | "pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  action: GitStackedAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

/** The web's source-control terminology: GitLab calls a pull request a merge request. */
/** GitActionsControl's SourceControlIcon: the host's own mark for a create-PR action (GitHub's mark for a GitHub
 * remote); a host with no artwork, or no recognised host, gets the pull request glyph, as a
 * definition with no artwork does (sourceControlPresentation.tsx). */
const HOST_MARKS = new Set(["gitlab", "bitbucket", "azure-devops", "forgejo", "gitcafe", "cursor-origin"]);
export function changeRequestIconName(providerKind: string | null): string {
  if (providerKind === "github") return "github";
  return providerKind !== null && HOST_MARKS.has(providerKind) ? `host-${providerKind}` : "git-pull-request-arrow";
}

/** GitQuickActionIcon in GitActionsControl.tsx. */
export function quickActionIconName(quick: Pick<GitQuickAction, "kind" | "action" | "label">, providerKind: string | null): string {
  if (quick.kind === "open_publish") return "cloud-upload";
  if (quick.kind === "run_pull") return "cloud-download";
  if (quick.kind === "run_action") {
    if (quick.action === "commit") return "git-commit-horizontal";
    if (quick.action === "push" || quick.action === "commit_push") return "cloud-upload";
    return changeRequestIconName(providerKind);
  }
  if (quick.label === "Commit") return "git-commit-horizontal";
  if (quick.label === "Push") return "cloud-upload";
  return "info";
}

export function changeRequestTerms(providerKind: string | null): { shortLabel: string; singular: string } {
  return providerKind === "gitlab" ? { shortLabel: "MR", singular: "merge request" } : { shortLabel: "PR", singular: "pull request" };
}

export function buildMenuItems(status: VcsStatus | null, isBusy: boolean, hasPrimaryRemote = true): GitActionMenuItem[] {
  if (!status) return [];
  const terms = changeRequestTerms(status.sourceControlProviderKind);
  const hasBranch = status.refName !== null;
  const hasOpenPr = status.pr?.state === "open";
  const isBehind = status.behindCount > 0;
  const hasDefaultBranchDelta = (status.aheadOfDefaultCount ?? status.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !status.hasUpstream;
  const canCommit = !isBusy && status.hasWorkingTreeChanges;
  const canPush = !isBusy && hasBranch && !isBehind && status.aheadCount > 0 && (status.hasUpstream || canPushWithoutUpstream);
  const canCreatePr = !isBusy && hasBranch && !hasOpenPr && hasDefaultBranchDelta && !isBehind && (status.hasUpstream || canPushWithoutUpstream);
  const commit: GitActionMenuItem = { id: "commit", label: "Commit", disabled: !canCommit, icon: "commit", action: "commit" };
  if (!hasPrimaryRemote) return [commit];
  const push: GitActionMenuItem = { id: "push", label: "Push", disabled: !canPush, icon: "push", action: "push" };
  if (hasOpenPr) return [commit, push];
  return [commit, push, { id: "pr", label: `Create ${terms.shortLabel}`, disabled: !canCreatePr, icon: "pr", action: "create_pr" }];
}

export function resolveQuickAction(status: VcsStatus | null, isBusy: boolean, isDefaultRef = false, hasPrimaryRemote = true): GitQuickAction {
  const hint = (label: string, text: string): GitQuickAction => ({ label, disabled: true, kind: "show_hint", hint: text });
  if (isBusy) return hint("Commit", "Git action in progress.");
  if (!status) return hint("Commit", "Git status is unavailable.");
  const terms = changeRequestTerms(status.sourceControlProviderKind);
  const hasOpenPr = status.pr?.state === "open";
  const isAhead = status.aheadCount > 0;
  const isBehind = status.behindCount > 0;
  const hasDefaultBranchDelta = (status.aheadOfDefaultCount ?? status.aheadCount) > 0;
  if (status.refName === null) return hint("Commit", `Create and checkout a ref before pushing or opening a ${terms.singular}.`);
  if (status.hasWorkingTreeChanges) {
    if (isBehind || (!status.hasUpstream && !hasPrimaryRemote)) return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    if (hasOpenPr || isDefaultRef) return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    return { label: `Commit, push & ${terms.shortLabel}`, disabled: false, kind: "run_action", action: "commit_push_pr" };
  }
  if (!status.hasUpstream) {
    if (!hasPrimaryRemote) return { label: "Publish repository", disabled: false, kind: "open_publish" };
    if (!isAhead) return hasOpenPr ? hint("Commit", "Branch is up to date. No action needed.") : hint("Push", "No local commits to push.");
    if (hasOpenPr || isDefaultRef) return { label: "Push", disabled: false, kind: "run_action", action: isDefaultRef ? "commit_push" : "push" };
    return { label: `Push & create ${terms.shortLabel}`, disabled: false, kind: "run_action", action: "create_pr" };
  }
  if (isAhead && isBehind) return hint("Sync ref", "Branch has diverged from upstream. Rebase/merge first.");
  if (isBehind) return { label: "Pull", disabled: false, kind: "run_pull" };
  if (isAhead) {
    if (hasOpenPr || isDefaultRef) return { label: "Push", disabled: false, kind: "run_action", action: isDefaultRef ? "commit_push" : "push" };
    return { label: `Push & create ${terms.shortLabel}`, disabled: false, kind: "run_action", action: "create_pr" };
  }
  if (hasOpenPr && status.hasUpstream) return hint("Commit", "Branch is up to date. No action needed.");
  if (hasDefaultBranchDelta && !isDefaultRef) return { label: `Create ${terms.shortLabel}`, disabled: false, kind: "run_action", action: "create_pr" };
  return hint("Commit", "Branch is up to date. No action needed.");
}

/** Why a disabled dropdown item is disabled (getMenuActionDisabledReason in GitActionsControl.tsx). */
export function menuItemDisabledReason(item: GitActionMenuItem, status: VcsStatus | null, isBusy: boolean, hasPrimaryRemote = true): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!status) return "Git status is unavailable.";
  const terms = changeRequestTerms(status.sourceControlProviderKind);
  const hasBranch = status.refName !== null;
  const hasChanges = status.hasWorkingTreeChanges;
  const isAhead = status.aheadCount > 0;
  const isBehind = status.behindCount > 0;
  if (item.id === "commit") return hasChanges ? "Commit is currently unavailable." : "Worktree is clean. Make changes before committing.";
  if (item.id === "push") {
    if (!hasBranch) return "Detached HEAD: check out a branch before pushing.";
    if (hasChanges) return "Commit or stash local changes before pushing.";
    if (isBehind) return "Branch is behind upstream. Pull/rebase before pushing.";
    if (!status.hasUpstream && !hasPrimaryRemote) return 'Add an "origin" remote before pushing.';
    if (!isAhead) return "No local commits to push.";
    return "Push is currently unavailable.";
  }
  if (!hasBranch) return `Detached HEAD: check out a branch before creating a ${terms.singular}.`;
  if (!status.hasUpstream && !hasPrimaryRemote) return `Add an "origin" remote before creating a ${terms.singular}.`;
  if ((status.aheadOfDefaultCount ?? status.aheadCount) <= 0) return `No local commits to include in a ${terms.singular}.`;
  if (isBehind) return `Branch is behind upstream. Pull/rebase before creating a ${terms.singular}.`;
  return `Create ${terms.singular} is currently unavailable.`;
}

export interface ChangesTotals { insertions: number; deletions: number; baseRef: string | null; breakdown?: import("../diff/changedFileKind").ChangeBreakdown | null }

/** `branchChanges ?? workingTree` would treat {0,0} as present and hide a dirty tree, so zero totals fall through. */
export function resolveChangesTotals(status: VcsStatus | null | undefined): ChangesTotals | null {
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null as string | null };
  const selected = branch && (branch.insertions > 0 || branch.deletions > 0) ? branch : tree.insertions > 0 || tree.deletions > 0 ? tree : (branch ?? tree);
  const files = selected === tree ? tree.files : (branch as { files?: ChangedFile[] } | null)?.files;
  const breakdown = Array.isArray(files) && files.length > 0
    ? summarizeChangedFiles(files.map((file) => ({ path: file.path, additions: file.insertions, deletions: file.deletions })))
    : null;
  return { insertions: selected.insertions, deletions: selected.deletions, baseRef: selected.baseRef, breakdown };
}

/** formatDiffCount: Intl.NumberFormat grouping, 1234 -> "1,234". */
export function formatDiffCount(count: number): string {
  return String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Merges a VcsStatusStreamEvent's local and remote halves into one status (null before a snapshot). */
export function mergeVcsStatus(previous: { local: Record<string, unknown> | null; remote: Record<string, unknown> | null }, event: unknown) {
  const next = { ...previous };
  if (!object(event)) return next;
  if (event._tag === "snapshot") {
    next.local = object(event.local) ? event.local : null;
    next.remote = object(event.remote) ? event.remote : null;
  } else if (event._tag === "localUpdated") next.local = object(event.local) ? event.local : next.local;
  else if (event._tag === "remoteUpdated") next.remote = object(event.remote) ? event.remote : null;
  return next;
}

export function readVcsStatus(parts: { local: Record<string, unknown> | null; remote: Record<string, unknown> | null }): VcsStatus | null {
  const local = parts.local;
  if (!local) return null;
  const remote = parts.remote ?? {};
  const tree = object(local.workingTree) ? local.workingTree : {};
  const branch = object(local.branchChanges) ? local.branchChanges : null;
  const pr = object(remote.pr) ? remote.pr : null;
  const provider = object(local.sourceControlProvider) ? local.sourceControlProvider : null;
  return {
    isRepo: local.isRepo === true,
    sourceControlProviderKind: provider && typeof provider.kind === "string" ? provider.kind : null,
    hasPrimaryRemote: local.hasPrimaryRemote === true,
    isDefaultRef: local.isDefaultRef === true,
    refName: typeof local.refName === "string" ? local.refName : null,
    hasWorkingTreeChanges: local.hasWorkingTreeChanges === true,
    workingTree: { insertions: int(tree.insertions), deletions: int(tree.deletions), files: readChangedFiles(tree.files) },
    branchChanges: branch ? { baseRef: typeof branch.baseRef === "string" ? branch.baseRef : null, insertions: int(branch.insertions), deletions: int(branch.deletions), ...(Array.isArray(branch.files) ? { files: readChangedFiles(branch.files) } : {}) } : null,
    hasUpstream: remote.hasUpstream === true,
    aheadCount: int(remote.aheadCount),
    behindCount: int(remote.behindCount),
    aheadOfDefaultCount: typeof remote.aheadOfDefaultCount === "number" ? remote.aheadOfDefaultCount : null,
    pr: pr && typeof pr.number === "number" && typeof pr.title === "string" && typeof pr.url === "string" && (pr.state === "open" || pr.state === "closed" || pr.state === "merged")
      ? { number: pr.number, title: pr.title, url: pr.url, state: pr.state, ...(typeof pr.headRef === "string" ? { headRef: pr.headRef } : {}) } : null,
  };
}

function readChangedFiles(value: unknown): ChangedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (object(item) && typeof item.path === "string" ? [{ path: item.path, insertions: int(item.insertions), deletions: int(item.deletions) }] : []));
}

/** The commit dialog's copy (COMMIT_DIALOG_TITLE / COMMIT_DIALOG_DESCRIPTION in GitActionsControl.tsx). */
export const COMMIT_DIALOG_TITLE = "Commit changes";
export const COMMIT_DIALOG_DESCRIPTION = "Review and confirm your commit. Leave the message blank to auto-generate one.";

export interface CommitSelection {
  selected: ChangedFile[];
  allSelected: boolean;
  noneSelected: boolean;
  insertions: number;
  deletions: number;
  /** `filePaths` for the action: omitted while every file is selected. */
  filePaths: string[] | null;
}

/** Which files the dialog commits: all of them unless some were unchecked. */
export function commitSelection(files: readonly ChangedFile[], excluded: ReadonlySet<string>): CommitSelection {
  const selected = files.filter((file) => !excluded.has(file.path));
  const allSelected = excluded.size === 0 || selected.length === files.length;
  return {
    selected,
    allSelected,
    noneSelected: selected.length === 0,
    insertions: selected.reduce((sum, file) => sum + file.insertions, 0),
    deletions: selected.reduce((sum, file) => sum + file.deletions, 0),
    filePaths: allSelected ? null : selected.map((file) => file.path),
  };
}

export function toggleExcluded(excluded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(excluded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** `vcs.switchRef`'s target for a ref: a remote ref is checked out as its local name (deriveLocalBranchNameFromRemoteRef). */
export function localBranchName(ref: { name: string; isRemote?: boolean; remoteName?: string }): string {
  if (!ref.isRemote) return ref.name;
  const prefix = ref.remoteName ? `${ref.remoteName}/` : null;
  if (prefix && ref.name.startsWith(prefix)) return ref.name.slice(prefix.length);
  const slash = ref.name.indexOf("/");
  return slash >= 0 ? ref.name.slice(slash + 1) : ref.name;
}

export interface BranchOption { value: string; title: string; current: boolean; isRemote: boolean }

/** `vcs.listRefs` rows as picker options: local branches first, a remote ref hidden when its local branch is listed. */
export function branchOptions(refs: readonly { name: string; isRemote?: boolean; remoteName?: string; current: boolean }[]): BranchOption[] {
  const local = new Set(refs.filter((ref) => !ref.isRemote).map((ref) => ref.name));
  const options: BranchOption[] = [];
  for (const ref of refs) {
    if (ref.isRemote && local.has(localBranchName(ref))) continue;
    options.push({ value: ref.name, title: ref.name, current: ref.current, isRemote: ref.isRemote === true });
  }
  return [...options.filter((option) => !option.isRemote), ...options.filter((option) => option.isRemote)];
}
