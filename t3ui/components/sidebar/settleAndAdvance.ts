// Sidebar.tsx attemptSettle / planForwardNavigation and settleAndAdvance.ts: settling the open thread moves on to the
// next card in sidebar order (wrapping) that is neither settled nor snoozed nor settling with it; with none, a new
// thread starts in the settled thread's project. The plan is taken before the settle changes the sections, a
// background settle (not the open thread) navigates nowhere, and a thread already settling is not settled twice.
import { createThread, openThread, openThreadById, threadById } from "../../store";
import { settleThread } from "./threadActions";
import { orderedThreadIds } from "./sidebarModel";
import { resolveSection } from "./threadStatus";

const settling = new Set<string>();

/** The next card after `id` in `ordered`, wrapping, skipping settled, snoozed and co-settling threads. */
export function nextCardAfter(ordered: readonly string[], id: string, isParked: (id: string) => boolean, coSettling?: ReadonlySet<string>): string | null {
  const index = ordered.indexOf(id);
  if (index === -1) return null;
  return [...ordered.slice(index + 1), ...ordered.slice(0, index)].find((key) => !isParked(key) && !coSettling?.has(key)) ?? null;
}

function planForwardNavigation(id: string, coSettling?: ReadonlySet<string>): (() => void) | null {
  if (openThread()?.id !== id) return null;
  const now = Date.now();
  const parked = (key: string) => {
    const thread = threadById(key);
    if (!thread) return false;
    const section = resolveSection(thread, now);
    return section === "settled" || section === "snoozed";
  };
  const next = nextCardAfter(orderedThreadIds(), id, parked, coSettling);
  const projectId = threadById(id)?.projectId ?? "";
  if (next) return () => openThreadById(next);
  return () => createThread(projectId || null);
}

/** Settles `id`; resolves false when it was already settling. Navigation runs only if the thread is still the open one. */
export async function settleAndAdvance(id: string, options: { coSettling?: ReadonlySet<string> } = {}): Promise<boolean> {
  if (settling.has(id)) return false;
  settling.add(id);
  const navigate = planForwardNavigation(id, options.coSettling);
  try {
    await settleThread(id);
  } finally {
    settling.delete(id);
  }
  if (openThread()?.id === id) navigate?.();
  return true;
}
