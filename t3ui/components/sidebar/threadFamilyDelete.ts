// useThreadActions.ts deleteThread, the two server reads behind it (orchestration.ts threadFamily / worktreeThreadIds).
// A server advertising `shellThreadFamilies` may leave idle subagent children out of the shell, so the local thread
// list cannot prove a worktree is unused or name every side chat of a thread: the server's answer decides.
type Request = (method: string, payload: unknown) => Promise<unknown>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);

export async function serverHasThreadFamilies(request: Request): Promise<boolean> {
  try { return record(await request("server.getConfig", {}))?.shellThreadFamilies === true; } catch { return false; }
}

/**
 * The orphaned worktree after the server's check: kept only when `orchestration.getWorktreeThreadIds` names no other
 * thread on it (outside those deleted with it). A failed read keeps the worktree (returns null).
 */
export async function confirmOrphanedWorktree(worktreePath: string | null, threadId: string, deletedIds: ReadonlySet<string> | undefined, request: Request): Promise<string | null> {
  if (worktreePath === null || !(await serverHasThreadFamilies(request))) return worktreePath;
  try {
    const ids = record(await request("orchestration.getWorktreeThreadIds", { worktreePath }))?.threadIds;
    if (!Array.isArray(ids)) return null;
    return ids.some((id) => id !== threadId && deletedIds?.has(String(id)) !== true) ? null : worktreePath;
  } catch {
    return null;
  }
}

export interface FamilyEntry { id: string; sideChat: boolean; parentThreadId: string | null }

/** The threads whose drafts go with a deleted thread that is not in the shell: its own and its side chats'. */
export async function sideChatsOfDeletedThread(threadId: string, local: readonly FamilyEntry[], request: Request): Promise<string[]> {
  let threads = local;
  if (await serverHasThreadFamilies(request)) {
    try {
      const family = record(await request("orchestration.getThreadFamily", { threadId }))?.threads;
      if (Array.isArray(family)) {
        threads = family.flatMap((item) => {
          const shell = record(item);
          const lineage = record(shell?.lineage);
          return typeof shell?.id === "string" ? [{ id: shell.id, sideChat: lineage?.sideChat === true, parentThreadId: typeof lineage?.parentThreadId === "string" ? lineage.parentThreadId : null }] : [];
        });
      }
    } catch { /* a failed read keeps the local list */ }
  }
  return threads.filter((entry) => entry.sideChat && entry.parentThreadId === threadId).map((entry) => entry.id);
}
