// The live dependencies of desktop/newThreadLink.ts: the store, the server RPCs (projects.ensureScratch, projectClone.start,
// pullRequests.linkedThreads, git.preparePullRequestThread) and the toasts, as the reference's NewThreadLinkView reaches them.
import {
  allProjects, allThreads, createThread, isProjectArchived, openThread, openThreadById, rawProviderRecords, requestBackend, setComposerDraft, setSelectedModel, setWorkspaceStrategy,
} from "../store";
import { showToast, updateToast } from "../components/toast/toastState";
import { suggestAppAccessForRemote } from "../components/palette/addProject/appAccess";
import { addProjectInitialQuery, ghqCloneLayout, loadAddProjectFacts, newProjectsRoot } from "../components/palette/addProject/addProjectState";
import { getCloneDestinationPath, getCloneDirectoryPath } from "../components/palette/addProject/addProjectLogic";
import { isScratchProjectPath, scratchWorkspaceRoot } from "../components/sidebar/serverFacts";
import { openScratchProject, scratchProjectAvailable } from "../components/thread/scratchProject";
import { createPullRequestCheckoutModel } from "../components/pullRequest/pullRequestCheckoutModel";
import { parseLinkedThreads } from "../components/pullRequest/pullRequestThreadLinks.logic";
import { visibleThreadPullRequests } from "../components/pullRequest/threadPullRequests.logic";
import { parseProvider, type ProviderView } from "../pages/settings/providers/logic";
import { createNewThreadLinkController, type LinkProject, type LinkThread, type NewThreadLinkDeps } from "./newThreadLink";
import type { LinkedPrompt } from "./promptLinkParse";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** recentProjects: the repository's projects most recently active first, the Scratch project and archived ones left out. */
export function recentLinkProjects(): LinkProject[] {
  const scratchRoot = scratchWorkspaceRoot();
  return allProjects()
    .filter((project) => !isProjectArchived(project.id) && !isScratchProjectPath(project.path, scratchRoot))
    .map((project) => ({ project, active: Math.max(project.updatedAt ?? 0, ...project.threads.map((thread) => thread.updatedAt)) }))
    .sort((a, b) => b.active - a.active)
    .map(({ project }) => ({ id: project.id, path: project.path ?? null, repositoryIdentity: project.repositoryIdentity }));
}

const linkThreads = (): LinkThread[] => allThreads().map((thread) => ({
  id: thread.id,
  updatedAt: thread.updatedAt,
  sideChat: thread.relations?.lineage?.sideChat === true,
  pullRequests: visibleThreadPullRequests(thread.relations?.pullRequests ?? []),
}));

export function createLiveNewThreadLink(hooks: { placePrompt: (prompt: LinkedPrompt, notes: readonly string[]) => void; warnHidden: (prompt: LinkedPrompt) => void }) {
  const deps: NewThreadLinkDeps = {
    threads: linkThreads,
    projects: recentLinkProjects,
    providers: () => rawProviderRecords().map(parseProvider).filter((provider): provider is ProviderView => provider !== null),
    openDraft: (projectId) => { createThread(projectId); return openThread() !== null && openThread() !== undefined; },
    openThread: openThreadById,
    setModel: (selection) => setSelectedModel(selection.instanceId, selection.model),
    placePrompt: hooks.placePrompt,
    openScratch: async () => (scratchProjectAvailable() ? await openScratchProject() : null),
    serverPullRequestThread: async (projectIds, pullRequest) => {
      for (const projectId of projectIds) {
        const found = parseLinkedThreads(await requestBackend("pullRequests.linkedThreads", { projectId, repository: `${pullRequest.owner}/${pullRequest.name}`, number: pullRequest.number })).find((thread) => thread.archivedAt === null);
        if (found) return found.id;
      }
      return null;
    },
    cloneFacts: async () => {
      // server.getConfig is read once per connection; the clone waits for it (up to 3 s).
      loadAddProjectFacts();
      for (let attempt = 0; attempt < 30 && newProjectsRoot() === null; attempt++) await wait(100);
      return { newProjectsRoot: newProjectsRoot(), destinationRoot: addProjectInitialQuery(), ghqCloneLayout: ghqCloneLayout() };
    },
    startClone: async (input) => { await requestBackend("projectClone.start", { ...input, createdAt: new Date().toISOString() }, { timeoutMs: 60_000 }); },
    directoryPath: (remoteUrl, ghq) => getCloneDirectoryPath(remoteUrl, ghq),
    destinationPath: getCloneDestinationPath,
    waitForProject: async (projectId, timeoutMs) => {
      const started = Date.now();
      while (!allProjects().some((project) => project.id === projectId)) {
        if (Date.now() - started >= timeoutMs) return false;
        await wait(50);
      }
      return true;
    },
    suggestAppAccess: (remoteUrl) => { void suggestAppAccessForRemote(requestBackend, remoteUrl); },
    newId: () => crypto.randomUUID(),
    checkout: ({ projectId, url }) => {
      const model = createPullRequestCheckoutModel({
        request: requestBackend,
        subject: () => ({ url, projectId, term: "pull request" }),
        projectPath: (id) => allProjects().find((project) => project.id === id)?.path ?? null,
        newThread: (id) => { createThread(id); return openThread()?.id ?? null; },
        selectWorkspace: (workspace) => setWorkspaceStrategy(workspace),
        toasts: { show: showToast, update: updateToast },
      });
      return model.start("worktree", controller.link()?.prompt != null);
    },
    setDraft: setComposerDraft,
    warnHidden: hooks.warnHidden,
    toast: (input) => { showToast(input); },
  };
  const controller: ReturnType<typeof createNewThreadLinkController> = createNewThreadLinkController(deps);
  return controller;
}
