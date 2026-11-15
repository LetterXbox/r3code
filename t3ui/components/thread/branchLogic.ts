// The pure parts of the branch toolbar's combobox (BranchToolbar.logic.ts, shared git.ts and
// BranchPicker.tsx): ref names, which picker items a query keeps, the badge each ref wears, where
// a checkout runs, and the trigger's label.
import { checkoutContainsProject } from "./workspaceRefs";

export interface PickerRef {
  name: string; current: boolean; isRemote: boolean; isDefault: boolean; worktreePath: string | null;
}

/** BranchToolbarBranchSelector: the error toast's title for a failed checkout or create-and-switch. */
export const branchActionFailureTitle = (action: "switch" | "create") => (action === "create" ? "Failed to create and switch ref." : "Failed to switch ref.");

/** sanitizeNewRefName: refs cannot contain whitespace. */
export const sanitizeNewRefName = (raw: string) => raw.trim().replace(/[ \t\n\r\f\v]+/g, "-");

/** deriveLocalBranchNameFromRemoteRef: "origin/feature" is checked out as "feature". */
export function localNameFromRemoteRef(name: string): string {
  const slash = name.indexOf("/");
  return slash <= 0 || slash === name.length - 1 ? name : name.slice(slash + 1);
}

export const CREATE_PREFIX = "__create_new_branch__:";
export const CHECKOUT_PR_PREFIX = "__checkout_pull_request__:";

/**
 * parsePullRequestReference (client-runtime pullRequestLinkInput.ts): `#12` / `12` or the URL of a
 * pull / merge request. The query keeps being a branch search when it is neither.
 */
export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const number = /^#?(\d+)$/.exec(trimmed);
  if (number?.[1]) return number[1];
  if (/^https?:\/\/\S+$/i.test(trimmed) && /\/(?:-\/)?(?:pull|pulls|merge_requests|pull-requests)\/\d+(?:[/?#].*)?$/i.test(trimmed)) return trimmed;
  return null;
}

export function parsePickerRefs(value: unknown): { isRepo: boolean; refs: PickerRef[]; nextCursor: number | null; totalCount: number } {
  const result = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const refs = Array.isArray(result.refs) ? result.refs.flatMap((item): PickerRef[] => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name.trim()) return [];
    return [{
      name: entry.name, current: entry.current === true, isRemote: entry.isRemote === true, isDefault: entry.isDefault === true,
      worktreePath: typeof entry.worktreePath === "string" && entry.worktreePath.trim() ? entry.worktreePath : null,
    }];
  }) : [];
  return {
    isRepo: result.isRepo === true, refs,
    nextCursor: typeof result.nextCursor === "number" ? result.nextCursor : null,
    totalCount: typeof result.totalCount === "number" ? result.totalCount : refs.length,
  };
}

/** The items the list offers: refs, then the create row when the query names a ref that does not exist. */
export function pickerItems(input: { refs: PickerRef[]; query: string; canCreate: boolean; canCheckoutPullRequest?: boolean }): { items: string[]; createValue: string | null; checkoutValue: string | null } {
  const query = input.query.trim();
  const reference = input.canCheckoutPullRequest ? parsePullRequestReference(query) : null;
  const checkoutValue = reference ? `${CHECKOUT_PR_PREFIX}${reference}` : null;
  const sanitized = sanitizeNewRefName(query);
  const exact = input.refs.some((ref) => ref.name === sanitized);
  const createValue = input.canCreate && query.length > 0 && !exact ? `${CREATE_PREFIX}${query}` : null;
  const normalized = query.toLowerCase();
  const kept = input.refs.map((ref) => ref.name).filter((name) => {
    if (!normalized) return true;
    const lower = name.toLowerCase();
    return lower.includes(normalized) || (sanitized.length > 0 && sanitized !== normalized && lower.includes(sanitized.toLowerCase()));
  });
  return { items: [...(checkoutValue ? [checkoutValue] : []), ...kept, ...(createValue ? [createValue] : [])], createValue, checkoutValue };
}

/** The word on the right of a row: current, worktree, remote or default. */
export function refBadge(ref: PickerRef, projectCwd: string | null): "current" | "worktree" | "remote" | "default" | null {
  const secondaryWorktree = ref.worktreePath && projectCwd && !checkoutContainsProject(ref.worktreePath, projectCwd);
  if (ref.current) return "current";
  if (secondaryWorktree) return "worktree";
  if (ref.isRemote) return "remote";
  return ref.isDefault ? "default" : null;
}

/** resolveBranchSelectionTarget: another worktree's branch is reused in place; any other ref is checked out where the thread runs. */
export function selectionTarget(input: { projectCwd: string; activeWorktreePath: string | null; ref: PickerRef }): { checkoutCwd: string; nextWorktreePath: string | null; reuseExistingWorktree: boolean } {
  const { projectCwd, activeWorktreePath, ref } = input;
  if (ref.worktreePath) {
    return { checkoutCwd: ref.worktreePath, nextWorktreePath: checkoutContainsProject(ref.worktreePath, projectCwd) ? null : ref.worktreePath, reuseExistingWorktree: true };
  }
  const nextWorktreePath = activeWorktreePath !== null && ref.isDefault ? null : activeWorktreePath;
  return { checkoutCwd: nextWorktreePath ?? projectCwd, nextWorktreePath, reuseExistingWorktree: false };
}

/** resolveBranchTriggerLabel. */
export function triggerLabel(input: { selectingWorktreeBase: boolean; branch: string | null; startFromOrigin?: boolean; branchIsRemote?: boolean | null }): string {
  if (!input.branch) return "Select ref";
  if (!input.selectingWorktreeBase) return input.branch;
  // Only the server knows a local branch's remote, so the suffix needs a known-local branch.
  return input.startFromOrigin === true && input.branchIsRemote === false ? `From ${input.branch} (remote)` : `From ${input.branch}`;
}

export const statusText = (input: { loading: boolean; loadingMore: boolean; shown: number; total: number; hasMore: boolean }): string | null =>
  input.loading ? "Loading refs..." : input.loadingMore ? "Loading more refs..." : input.hasMore ? `Showing ${input.shown} of ${input.total} refs` : null;
