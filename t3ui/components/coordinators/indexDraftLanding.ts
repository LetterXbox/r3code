// IndexDraftLanding (apps/web/src/routes/_chat.index.tsx): on the root view (no thread open, no Settings, Usage or
// utility page over it) with projects loaded, start a draft in the most recent non-archived project
// (sortScopedProjectsForSidebar, "updated_at": no pinned priority, ties by title then id). One attempt per retry
// request; a failure shows DraftStartError ("Couldn't start a new thread" + Try again).
import { effect, signal, untracked } from "nsh";
import { allProjects, backendStatus, createThread, isProjectArchived, openThread, settingsOpen, shellSnapshotLoaded, usageOpen, utilityPage, type Project } from "../../store";

const failed = signal(false);
const retryRequest = signal(0);
let startedAttempt: number | null = null;

export const draftStartFailed = () => failed();

/** DraftStartError's Try again. */
export function retryDraftStart() {
  failed.set(false);
  retryRequest.update((value) => value + 1);
}

/** Test hook. */
export function resetIndexDraftLanding() {
  failed.set(false);
  retryRequest.set(0);
  startedAttempt = null;
}

function projectTimestamp(project: Project): number {
  if (project.threads.length === 0) return project.updatedAt || project.createdAt || 0;
  return project.threads.reduce((latest, thread) => Math.max(latest, thread.latestUserMessageAt || thread.updatedAt || thread.createdAt || 0), 0);
}

export function mostRecentProject(projects: readonly Project[]): Project | null {
  return projects
    .filter((project) => !isProjectArchived(project.id))
    .map((project) => ({ project, timestamp: projectTimestamp(project) }))
    .sort((a, b) => b.timestamp - a.timestamp || a.project.name.localeCompare(b.project.name) || (a.project.environmentId ?? "").localeCompare(b.project.environmentId ?? "") || a.project.id.localeCompare(b.project.id))[0]?.project ?? null;
}

const onIndex = () => !openThread() && !settingsOpen() && !usageOpen() && !utilityPage();

/** One pass of the landing effect; returns whether it started a draft. */
export function runIndexDraftLanding(start: (projectId: string) => void = createThread): boolean {
  const attempt = retryRequest();
  if (backendStatus() !== "connected" || !shellSnapshotLoaded()) return false;
  const project = mostRecentProject(allProjects());
  if (project === null || startedAttempt === attempt || failed() || !untracked(onIndex)) return false;
  startedAttempt = attempt;
  try {
    untracked(() => start(project.id));
    return true;
  } catch {
    failed.set(true);
    return false;
  }
}

let installed = false;
export function installIndexDraftLanding() {
  if (installed) return;
  installed = true;
  effect(() => {
    // Re-run when the root view comes back (a thread closed or deleted), as the reference's route remounts.
    if (!onIndex()) {
      untracked(() => { startedAttempt = null; if (failed()) failed.set(false); });
      return;
    }
    runIndexDraftLanding();
  });
}
