// SidebarThreadRow.tsx rowSurfaceClassName (web): the row's surface by state, in the web's order of precedence. Files
// dragged over a plain row light it with the hover surface; an unsent composer draft on a thread that is not open
// tints it with draftSurfaceClassName (`bg-warning/4 hover:bg-warning/8`).
export function threadRowSurface(state: { active: boolean; selected: boolean; fileOver: boolean; unsentDraft: boolean }): string {
  if (state.active) return "bg-sidebar-row-active";
  if (state.selected) return "bg-sidebar-row-selected";
  if (state.fileOver) return "bg-sidebar-row-hover";
  if (state.unsentDraft) return "bg-warning-4 hover:bg-warning-8";
  return "bg-transparent hover:bg-sidebar-row-hover";
}
