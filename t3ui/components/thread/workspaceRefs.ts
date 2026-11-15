export interface WorkspaceRef {
  name: string;
  current: boolean;
  isRemote: boolean;
  worktreePath: string | null;
}

export interface WorkspaceRefs {
  isRepo: boolean;
  refs: WorkspaceRef[];
  hasMore: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function parseWorkspaceRefs(value: unknown): WorkspaceRefs {
  const result = record(value);
  if (!result || typeof result.isRepo !== "boolean" || !Array.isArray(result.refs)) {
    throw new Error("The environment returned an invalid branch list.");
  }
  const refs = result.refs.flatMap((item): WorkspaceRef[] => {
    const entry = record(item);
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) return [];
    return [{
      name: entry.name,
      current: entry.current === true,
      isRemote: entry.isRemote === true,
      worktreePath: typeof entry.worktreePath === "string" && entry.worktreePath.trim() ? entry.worktreePath : null,
    }];
  });
  return { isRepo: result.isRepo, refs, hasMore: typeof result.nextCursor === "number" && Number.isInteger(result.nextCursor) && result.nextCursor >= 0 };
}

export function checkoutContainsProject(checkout: string, project: string): boolean {
  const root = checkout.replace(/[\\/]+$/, "");
  if (!root) return project.startsWith("/");
  return project === root || project.startsWith(`${root}/`) || project.startsWith(`${root}\\`);
}

// ---- Labels of the branch toolbar (BranchToolbar.logic.ts) ----
export type WorkspaceLike =
  | { type: "root"; branch?: string }
  | { type: "worktree"; baseRef: string }
  | { type: "existing_worktree"; worktreePath: string; branch?: string };

/** The environment-mode control: resolveEnvModeLabel / resolveCurrentWorkspaceLabel. */
export function envModeLabel(strategy: WorkspaceLike): string {
  if (strategy.type === "worktree") return "New worktree";
  if (strategy.type === "existing_worktree") return "Current worktree";
  return "Current checkout";
}

/** A thread that already exists has its mode locked: resolveLockedWorkspaceLabel. */
export function lockedEnvModeLabel(hasWorktree: boolean): string {
  return hasWorktree ? "Worktree" : "Local checkout";
}

/** The branch control: resolveBranchTriggerLabel. */
export function branchTriggerLabel(strategy: WorkspaceLike): string {
  if (strategy.type === "worktree") return `From ${strategy.baseRef}`;
  const branch = strategy.branch;
  return branch ? branch : "Select ref";
}

// ---- Previous worktree (BranchToolbar.logic.ts resolvePreviousWorktreeSeed) ----

export interface PreviousWorktreeSeed { branch: string | null; worktreePath: string }

/**
 * The worktree the project's most recently updated thread ran in, other than the one this thread is
 * on. The shell snapshot carries a thread's worktree path but not its branch, so the branch is read
 * back from the refs that hold that worktree.
 */
export function resolvePreviousWorktreeSeed(input: {
  threads: readonly { path?: string | undefined; updatedAt: number }[];
  currentWorktreePath: string | null;
  branchOf?: (worktreePath: string) => string | null;
}): PreviousWorktreeSeed | null {
  let latest: { path: string; updatedAt: number } | null = null;
  for (const thread of input.threads) {
    if (!thread.path || thread.path === input.currentWorktreePath) continue;
    if (latest === null || thread.updatedAt > latest.updatedAt) latest = { path: thread.path, updatedAt: thread.updatedAt };
  }
  return latest === null ? null : { branch: input.branchOf?.(latest.path) ?? null, worktreePath: latest.path };
}

/** resolvePreviousWorktreeLabel. */
export function previousWorktreeLabel(seed: PreviousWorktreeSeed): string {
  return seed.branch ? `Previous worktree (${seed.branch})` : "Previous worktree";
}
