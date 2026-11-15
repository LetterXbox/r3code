// The sidebar's rows as the tree keys see them: every row on screen, top to bottom, in the order
// Sidebar.tsx renders them.
import { allProjects, isCollapsed, openThread, sidebarDrafts, sidebarThreadQuery } from "../../store";
import { folderThreads, sidebarSections, visibleSettled, visibleSnoozed, visibleWorking } from "./sidebarModel";
import { settledShelfExpanded, snoozedShelfExpanded, workingShelfExpanded } from "./sidebarPrefs";
import { draftRowId, projectRowId, shelfRowId, threadRowId } from "./sidebarTree";
import type { TreeRow } from "./sidebarTree";

/** The rows on screen, top to bottom, in the order Sidebar.tsx renders them. */
export function visibleTreeRows(): TreeRow[] {
  if (sidebarThreadQuery().trim()) return [];
  const sections = sidebarSections();
  const open = openThread()?.id;
  const rows: TreeRow[] = [];
  const leaf = (id: string, parent: string | null = null) => rows.push({ id, parent, expanded: null });
  for (const draft of sidebarDrafts()) leaf(draftRowId(draft.id));
  for (const thread of sections.pinned) leaf(threadRowId(thread.id));
  for (const thread of sections.loose) leaf(threadRowId(thread.id));
  for (const project of sections.projects) {
    const closed = isCollapsed(project.id);
    const id = projectRowId(project.id);
    rows.push({ id, parent: null, expanded: !closed });
    const threads = folderThreads(project);
    for (const thread of closed ? threads.filter((item) => item.id === open) : threads) leaf(threadRowId(thread.id), id);
  }
  if (sections.working.length > 0) {
    const id = shelfRowId("working");
    rows.push({ id, parent: null, expanded: workingShelfExpanded() });
    for (const thread of visibleWorking(sections)) leaf(threadRowId(thread.id), id);
  }
  if (sections.snoozed.length > 0) {
    const id = shelfRowId("snoozed");
    rows.push({ id, parent: null, expanded: snoozedShelfExpanded() });
    for (const thread of visibleSnoozed(sections)) leaf(threadRowId(thread.id), id);
  }
  if (allProjects().length > 0) {
    const id = shelfRowId("settled");
    rows.push({ id, parent: null, expanded: settledShelfExpanded() });
    for (const thread of visibleSettled(sections)) leaf(threadRowId(thread.id), id);
  }
  return rows;
}

