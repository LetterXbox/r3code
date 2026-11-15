// ChatView.tsx's parentThreadLink: the divider at the top of a child thread (a side chat, a subagent, a thread another
// environment's agent delegated), naming the thread it came from. Pure, so it is tested without an engine.
import type { ThreadRelations } from "../../header/threadRelations";

export interface ParentThreadLink {
  title: string;
  /** A side chat reads "Context from"; a subagent or delegated thread "Subagent of". */
  sideChat: boolean;
  /** Set for a delegated thread: the linked environment it came from. */
  environmentLabel?: string;
  open?: () => void;
}

export function parentThreadLinkFor(
  relations: ThreadRelations | undefined,
  titleOf: (threadId: string) => string | undefined,
  openThread: (threadId: string) => void,
): ParentThreadLink | null {
  const lineage = relations?.lineage;
  if (lineage?.sideChat === true && lineage.parentThreadId !== null) {
    const parent = lineage.parentThreadId;
    return { title: titleOf(parent) ?? "Parent thread", sideChat: true, open: () => openThread(parent) };
  }
  const subagentParent = lineage?.relationshipToParent === "subagent" ? relations?.parentThreadId ?? null : null;
  if (subagentParent !== null) return { title: titleOf(subagentParent) ?? "Parent thread", sideChat: false, open: () => openThread(subagentParent) };
  const delegated = relations?.delegatedFrom;
  if (!delegated) return null;
  const label = relations?.linkOrigin ?? "";
  return { title: delegated.title, sideChat: false, ...(label ? { environmentLabel: label } : {}) };
}

/** The divider's detail: `<title>`, or `<title> on <environment>`. */
export const parentThreadLinkDetail = (link: ParentThreadLink) => (link.environmentLabel === undefined ? link.title : `${link.title} on ${link.environmentLabel}`);
