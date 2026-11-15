// Dropping a row inside Pinned or Active (Sidebar.tsx's reorder-pinned / move-active plans): the new
// order is the visible rows with the dragged one moved, and planReorder turns it into key writes sent
// as thread.pin.reorder / thread.active.reorder.
import type { Thread } from "../../store";
import { sidebarSections } from "./sidebarModel";
import { moveToIndex, planReorder } from "./threadOrder";
import type { OrderAssignment } from "./threadOrder";
import { reorderThread, threadActionNotice } from "./threadActions";
import { configLoaded } from "./serverFacts";

export const REORDER_UNSUPPORTED: Record<ReorderSection, string> = {
  pinned: "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.",
  active: "Update this environment's server to reorder active threads.",
};

export type ReorderSection = "pinned" | "active";

/** The key writes a drop at `index` among the other rows of `section` needs; empty when the order holds. */
export function planSectionReorder(threads: readonly Thread[], movedId: string, section: ReorderSection, index: number): OrderAssignment[] {
  const ids = threads.map((thread) => thread.id);
  if (!ids.includes(movedId)) return [];
  const order = moveToIndex(ids, movedId, index);
  if (order.every((id, position) => id === ids[position])) return [];
  const keysById = new Map(threads.map((thread) => [thread.id, section === "pinned" ? thread.meta?.pinOrderKey : thread.meta?.activeOrderKey] as const));
  return planReorder({ orderedIds: order, keysById, movedId });
}

export async function reorderWithinSection(thread: Thread, section: ReorderSection, index: number): Promise<void> {
  const sections = sidebarSections();
  const threads = section === "pinned" ? sections.pinned : sections.loose;
  const assignments = planSectionReorder(threads, thread.id, section, index);
  // useThreadActions: a server that has sent no config (an older one) cannot reorder (ThreadPinReorderUnsupportedError /
  // ThreadActiveReorderUnsupportedError).
  if (assignments.length > 0 && !configLoaded()) {
    threadActionNotice.failure(section === "pinned" ? "Failed to reorder pinned threads" : "Failed to reorder active threads", new Error(REORDER_UNSUPPORTED[section]));
    return;
  }
  try {
    for (const assignment of assignments) await reorderThread(section, assignment.id, assignment.orderKey);
  } catch (error) {
    threadActionNotice.failure(section === "pinned" ? "Failed to reorder pinned threads" : "Failed to reorder active threads", error);
  }
}
