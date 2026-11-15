// composerDraftStore.ts clearComposerDraftsEnvironment / hasDraftThreadsInEnvironment for the port: drafts of a saved
// environment are the unsent drafts in its projects (scoped "<environmentId>:<projectId>") plus the composer drafts
// of its server threads (scoped thread ids). Removing the environment drops them (platform.ts removeEnvironment).
import { allProjects, forgetProjectDrafts, releaseThreadDraft, sidebarDrafts } from "../store";
import { parseScopedKey, remoteShell, scopedKey } from "./connectionManager";

const inEnvironment = (id: string | null | undefined, environmentId: string) => Boolean(id) && parseScopedKey(id!)?.environmentId === environmentId;

export function hasDraftThreadsInEnvironment(environmentId: string): boolean {
  return sidebarDrafts().some((draft) => inEnvironment(draft.projectId, environmentId));
}

export function clearComposerDraftsEnvironment(environmentId: string): void {
  for (const project of allProjects()) if (project.environmentId === environmentId || inEnvironment(project.id, environmentId)) forgetProjectDrafts(project.id);
  const shell = remoteShell(environmentId);
  for (const thread of shell?.threads ?? []) if (typeof thread.id === "string") releaseThreadDraft(scopedKey(environmentId, thread.id));
}
