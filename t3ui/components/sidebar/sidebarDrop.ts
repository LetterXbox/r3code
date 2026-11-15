// What dragging a thread between the sidebar's sections does, from Sidebar.logic.ts
// (resolveSidebarDropVerb). Rows drag between Pinned, Active and the Settled shelf; Snoozed
// takes no drops (it needs a wake time) and Working rows only drag out as chat context.
export type DragSection = "pinned" | "active" | "snoozed" | "settled";

export type DropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

/** The verb for dropping a row from `from` on `to`; null when nothing would change. */
export function resolveSidebarDropVerb(from: DragSection, to: DragSection | null): DropVerb | null {
  if (to === null || to === from || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export const DROP_VERB_LABEL: Record<DropVerb, string> = {
  pin: "Pin",
  unpin: "Unpin",
  settle: "Settle",
  unsettle: "Un-settle",
  wake: "Wake",
};

export interface DropZoneBounds {
  section: DragSection;
  top: number;
  bottom: number;
}

/** The section whose zone holds `y`; null between zones. Zones that overlap give the later one. */
export function sectionAtY(zones: readonly DropZoneBounds[], y: number): DragSection | null {
  let found: DragSection | null = null;
  for (const zone of zones) if (y >= zone.top && y < zone.bottom) found = zone.section;
  return found;
}

/** The slot a row dropped at `y` takes among peers with these centres (top to bottom): 0 is the top. */
export function insertionIndex(centers: readonly number[], y: number): number {
  return centers.filter((center) => center < y).length;
}
