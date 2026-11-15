// What deleting a thread does about its worktree (useThreadActions.ts deleteThread, worktreeCleanup.ts): when the
// thread is the only one on its worktree the user is asked whether to delete the worktree too, and after the thread
// is gone the worktree is removed and the project's Git status refreshed. Pure rules plus the two server calls.

/** normalizeProjectPathForComparison: the same folder with or without a trailing slash, any case on a case-insensitive path is left to the server. */
const normalize = (path: string) => (path.trim().length > 1 ? path.trim().replace(/\\/g, "/").replace(/\/+$/, "") : path.trim());

/**
 * getOrphanedWorktreePathForThread: the thread's worktree when no other thread (outside `deletedIds`, which go with it)
 * runs in it; confirming force-removes the checkout for every thread on it.
 */
export function orphanedWorktreePath(threads: readonly { id: string; path?: string | undefined }[], threadId: string, deletedIds?: ReadonlySet<string>): string | null {
  const target = threads.find((thread) => thread.id === threadId)?.path?.trim();
  if (!target) return null;
  const key = normalize(target);
  const shared = threads.some((thread) => thread.id !== threadId && deletedIds?.has(thread.id) !== true && thread.path !== undefined && normalize(thread.path) === key);
  return shared ? null : target;
}

/** formatWorktreePathForDisplay: the folder's own name. */
export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) return worktreePath;
  const last = trimmed.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()?.trim() ?? "";
  return last.length > 0 ? last : trimmed;
}

/** The question the confirmation asks (a destructive confirm). */
export function worktreeDeleteQuestion(worktreePath: string): string {
  return ["This thread is the only one linked to this worktree:", formatWorktreePathForDisplay(worktreePath) || worktreePath, "", "Delete the worktree too?"].join("\n");
}

export interface WorktreeCleanupFacts {
  worktreePath: string | null;
  /** The project's folder, where the worktree is removed from. */
  projectCwd: string | null;
  isScratchProject: boolean;
  canWriteSourceControl: boolean;
  /** `resolveWorktreeCleanup(...).worktreeOnDelete`: the server removes it on its own, so no question is asked. */
  automaticCleanup: boolean;
}

/** Whether to ask: an orphaned worktree of a real project, a connection that may remove it, and no automatic cleanup. */
export function shouldAskToDeleteWorktree(facts: WorktreeCleanupFacts): boolean {
  return facts.worktreePath !== null && facts.projectCwd !== null && !facts.isScratchProject && facts.canWriteSourceControl && !facts.automaticCleanup;
}

export type WorktreeCleanupFailure = { title: string; description: string };

/**
 * After the thread is deleted: `vcs.removeWorktree` (force) from the project folder, then `vcs.refreshStatus`. A failed removal
 * is "Failed to delete worktree"; a failed refresh after a removal is "Worktree deleted, but Git status refresh failed".
 * Returns null on success.
 */
export async function removeWorktreeAfterDelete(
  input: { projectCwd: string; worktreePath: string; canWriteSourceControl: boolean },
  request: (method: string, payload: unknown) => Promise<unknown>,
): Promise<WorktreeCleanupFailure | null> {
  const message = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : "An error occurred.");
  try {
    if (!input.canWriteSourceControl) throw new Error("This connection can no longer remove worktrees.");
    await request("vcs.removeWorktree", { cwd: input.projectCwd, path: input.worktreePath, force: true });
  } catch (cause) {
    return { title: "Failed to delete worktree", description: `Could not remove ${formatWorktreePathForDisplay(input.worktreePath) || input.worktreePath}. ${message(cause)}` };
  }
  try {
    await request("vcs.refreshStatus", { cwd: input.projectCwd });
  } catch (cause) {
    return { title: "Worktree deleted, but Git status refresh failed", description: message(cause) };
  }
  return null;
}

// --- Server capability and state guards (useThreadActions.ts: the Thread*UnsupportedError / BlockedError messages) ---

export const THREAD_ACTION_ERRORS = {
  archiveBlocked: "Cannot archive while the provider is active.",
  settleUnsupported: "This environment's server does not support settling yet. Update the server to use Settle.",
  snoozeUnsupported: "This environment's server does not support snoozing yet. Update the server to use Snooze.",
  snoozeBlocked: "This thread is waiting on you. Respond to the pending request before snoozing it.",
  autoSettleUnsupported: "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.",
  pinUnsupported: "This environment's server does not support pinning yet. Update the server to use Pin.",
} as const;

/** threadRuntimeCanArchive: a thread whose run is preparing, starting or running cannot be archived. */
export function archiveBlockedReason(thread: { status: string; meta?: { activityRunStatus: string | null } | undefined }): string | null {
  const active = thread.meta?.activityRunStatus;
  return active === "preparing" || active === "starting" || active === "running" || thread.status === "running" ? THREAD_ACTION_ERRORS.archiveBlocked : null;
}
