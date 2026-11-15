// Which threads the sidebar lists, in which section and order. The section rule is
// resolveSidebarThreadSection (snoozed, then settled, then pinned, else active); the order
// is what Sidebar.tsx's orderedThreads builds and what thread.previous / thread.next walk.
import {
  allProjects,
  allThreads,
  generalSettings,
  isCollapsed,
  openThread,
  sidebarProjects,
  settingValue,
  sidebarThreadQuery,
  threadMatchesQuery,
  unpinnedLooseThreads,
  visibleProjectThreads,
} from "../../store";
import type { Project, Thread } from "../../store";
import { unloadedOlderSettledCount } from "../../store";
import { sortSidebarProjects } from "../SidebarUtils";
import { groupSidebarProjects } from "./projectGrouping";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { minuteNow } from "./clock";
import { resolveSection, threadSettledAt } from "./threadStatus";
import { configLoaded } from "./serverFacts";
import { partitionActive, sortWorkingBySend } from "./workingShelf";
import { withOptimisticWorking } from "./optimisticWorking";
import { holdsWorkingPlace, workingReturnAt } from "./workingState";
import { listedWithSubagentRequests } from "./subagentRequests";

/** What the lists show: no subagents or side chats, a child's approval flagged on its parent, a send in flight Working. */
const listedThreads = (threads: readonly Thread[]) => withOptimisticWorking(listedWithSubagentRequests(threads));
import { localThreadId, sortActiveByKey, sortPinnedByKey } from "./threadOrder";
import { inProjectScope, projectScopeIds } from "./projectScope";
import {
  settledShelfExpanded,
  settledVisibleCount,
  snoozedShelfExpanded,
  workingShelfExpanded,
} from "./sidebarPrefs";

export interface SidebarSections {
  pinned: Thread[];
  loose: Thread[];
  /** The Working shelf: active threads that hold a run. Empty in the project-folder (boring) layout. */
  working: Thread[];
  snoozed: Thread[];
  settled: Thread[];
  projects: Project[];
}

const bySettled = (a: Thread, b: Thread) => threadSettledAt(b) - threadSettledAt(a) || (localThreadId(a) < localThreadId(b) ? -1 : localThreadId(a) > localThreadId(b) ? 1 : 0);

/** The folder's own rows: active threads only, newest first. */
export function folderThreads(project: Project, now = minuteNow()): Thread[] {
  return sortWorkingBySend(listedThreads(visibleProjectThreads(project)).filter((thread) => resolveSection(thread, now, configLoaded()) === "active"));
}

/** boringSidebarEnabled: project folders in place of one flat active list and no Working shelf. */
export const boringSidebar = () => settingValue("boringSidebarEnabled") === true;

/**
 * keepEmptyFolders (Sidebar.tsx): a folder with no active thread stays only while the list is narrowed to a
 * project scope, or for a pinned project; otherwise it drops out.
 */
export function keepsEmptyFolder(project: Pick<Project, "pinned">, scope: readonly string[], activeThreadCount: number): boolean {
  return activeThreadCount > 0 || scope.length > 0 || project.pinned === true;
}

export function sidebarSections(now = minuteNow()): SidebarSections {
  const scope = projectScopeIds();
  const matching = listedThreads(allThreads()).filter((thread) => threadMatchesQuery(thread.title) && inProjectScope(scope, thread.projectId));
  const loaded = configLoaded();
  const sectionOf = (thread: Thread) => resolveSection(thread, now, loaded);
  const common = {
    pinned: sortPinnedByKey(matching.filter((thread) => sectionOf(thread) === "pinned")),
    snoozed: matching.filter((thread) => sectionOf(thread) === "snoozed")
      .sort((a, b) => (a.meta?.snoozedUntil ?? 0) - (b.meta?.snoozedUntil ?? 0)),
    settled: matching.filter((thread) => sectionOf(thread) === "settled").sort(bySettled),
  };
  if (boringSidebar()) {
    return {
      ...common,
      loose: sortWorkingBySend(listedThreads(unpinnedLooseThreads()).filter((thread) => threadMatchesQuery(thread.title) && inProjectScope(scope, thread.projectId) && sectionOf(thread) === "active")),
      working: [],
      projects: sortSidebarProjects(groupSidebarProjects(sidebarProjects(), { environmentId: String(serverEnvironment()?.environmentId ?? ""), globalMode: settingValue("sidebarProjectGroupingMode"), overrides: settingValue("sidebarProjectGroupingOverrides") }), settingValue("sidebarProjectSortOrder"))
        .filter((project) => inProjectScope(scope, project.id))
        .filter((project) => keepsEmptyFolder(project, scope, folderThreads(project, now).length)),
    };
  }
  // The default layout: every active thread is a card in one list, and the ones holding a run
  // move to the Working shelf when it is enabled (partitionSidebarThreads).
  const active = listedThreads([...allProjects().flatMap((project) => project.threads), ...unpinnedLooseThreads()])
    .filter((thread) => threadMatchesQuery(thread.title) && inProjectScope(scope, thread.projectId) && sectionOf(thread) === "active");
  const shelf = generalSettings().sidebarWorkingShelfEnabled;
  const { working, rest } = partitionActive(active, shelf, holdsWorkingPlace, workingReturnAt);
  return {
    ...common,
    loose: shelf ? rest : sortActiveByKey(rest),
    working,
    projects: [],
  };
}

/** A closed shelf still lists the open thread, so the row you are on never disappears. */
function routeOnly(threads: Thread[]): Thread[] {
  const open = openThread()?.id;
  return threads.filter((thread) => thread.id === open);
}

export function visibleWorking(sections: SidebarSections): Thread[] {
  return workingShelfExpanded() ? sections.working : routeOnly(sections.working);
}

export function visibleSnoozed(sections: SidebarSections): Thread[] {
  return snoozedShelfExpanded() ? sections.snoozed : routeOnly(sections.snoozed);
}

export function visibleSettled(sections: SidebarSections): Thread[] {
  if (!settledShelfExpanded()) return routeOnly(sections.settled);
  return sections.settled.slice(0, settledVisibleCount());
}

/** The shelf count includes older settled threads omitted from the shell snapshot. */
export function settledThreadCount(sections: SidebarSections): number {
  return sections.settled.length + unloadedOlderSettledCount(new Set(projectScopeIds()));
}

export function hiddenSettledCount(sections: SidebarSections): number {
  // Sidebar.tsx: settled rows not shown plus the older settled threads the shell left out (olderSettledShelf unloadedCount).
  return settledShelfExpanded() ? Math.max(0, sections.settled.length - settledVisibleCount()) + unloadedOlderSettledCount(new Set(projectScopeIds())) : 0;
}

/** Top-to-bottom ids of every row on screen: pinned, loose, folders, working, snoozed, settled. */
export function orderedThreadIds(): string[] {
  const now = Date.now();
  const sections = sidebarSections(now);
  const open = openThread()?.id;
  const searching = sidebarThreadQuery().trim().length > 0;
  const folders = sections.projects.flatMap((project) => {
    const threads = folderThreads(project, now);
    return isCollapsed(project.id) && !searching ? threads.filter((thread) => thread.id === open) : threads;
  });
  return [
    ...sections.pinned,
    ...sections.loose,
    ...folders,
    ...visibleWorking(sections),
    ...visibleSnoozed(sections),
    ...visibleSettled(sections),
  ].map((thread) => thread.id);
}
