// useChildThreadInputs (client-runtime state/threadShell.ts childThreadInputsAtom): the subagents and side chats under
// a thread, through its whole subtree, whose live run waits on a question or an approval. Pure over the store's threads.
import type { Thread } from "../../store";
import type { ChildInput } from "./bannerLogic";

/** An async question outlives the subagent's run; once that run ends the parent is no longer waiting on it. */
function childRunLive(thread: Thread): boolean {
  const meta = thread.meta;
  if (!meta) return thread.status === "running";
  if (meta.activityRunStatus !== undefined) return meta.activityRunStatus !== null;
  return thread.status === "running";
}

export function childThreadInputs(threads: readonly Thread[], parentId: string): ChildInput[] {
  const children = new Map<string, Thread[]>();
  for (const thread of threads) {
    const parent = thread.relations?.lineage?.parentThreadId ?? null;
    const lineage = thread.relations?.lineage;
    if (parent !== null && (lineage?.relationshipToParent === "subagent" || lineage?.sideChat === true)) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(thread); else children.set(parent, [thread]);
    }
  }
  const seen = new Set<string>([parentId]);
  const pending = [parentId];
  const result: ChildInput[] = [];
  for (const parent of pending) {
    for (const thread of children.get(parent) ?? []) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      pending.push(thread.id);
      const kind = thread.meta?.pendingRequestKind ?? null;
      const sideChat = thread.relations?.lineage?.sideChat === true;
      // A provider-native subagent takes no input of its own; auth refreshes are not a user request.
      if (kind === null || kind === "auth_refresh" || thread.relations?.providerSubagent || !childRunLive(thread)) continue;
      result.push({ id: thread.id, title: thread.title, sideChat, hasPendingApprovals: kind !== "user_input" });
    }
  }
  return result;
}
