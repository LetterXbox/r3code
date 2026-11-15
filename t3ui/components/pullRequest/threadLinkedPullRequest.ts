// useThreadLinkedPullRequest.ts (mounted by ChatView for the open thread): a thread whose persisted linked pull request
// was merged or closed is relinked to the newer open request on the thread's branch (thread.metadata.update
// linkedPullRequest), an open panel on the replaced request follows it, and a failed write toasts "Unable to update the
// thread pull request". The persisted request's state comes from useLinkedThreadPullRequest, which reads the linked
// summary (pullRequests.summary) only for an environment without multiple linked pull requests (no server config yet).
import { computed, effect, signal, untracked } from "nsh";
import { allProjects, backendStatus, isServerThread, openThread, requestBackend, subscribeBackend } from "../../store";
import { watchVcsStatus } from "../header/gitRuntime";
import type { VcsStatus } from "../header/gitLogic";
import { openPullRequestSurface, panelKeyFor, panelStateFor } from "../rightPanel/panelState";
import { showToast } from "../toast";
import { pullRequestsSupported } from "./pullRequestsSupported";
import { createThreadLinkedPullRequestRelinker, sharedPullRequestSummary, threadLinkedPullRequestReplacement, useLinkedPullRequestSummary, type ThreadLinkedPullRequest } from "./pullRequestState";
import { PRIMARY_ROUTING_ENVIRONMENT } from "./pullRequestRoutingInstall";

/** sourceControlClients.repositorySelector (the default selector: displayName, else owner/name). */
export function projectRepositorySelector(identity: unknown): string | null {
  if (typeof identity !== "object" || identity === null) return null;
  const value = identity as { displayName?: unknown; owner?: unknown; name?: unknown };
  if (typeof value.displayName === "string" && value.displayName) return value.displayName;
  return typeof value.owner === "string" && value.owner && typeof value.name === "string" && value.name ? `${value.owner}/${value.name}` : null;
}

/** linkedPullRequestReference: the host comes from the link's URL. */
function linkedReference(link: ThreadLinkedPullRequest) {
  let host: string | undefined;
  try { host = new URL(link.url).host || undefined; } catch { host = undefined; }
  return { projectId: link.projectId, repository: link.repository, number: link.number, ...(host ? { host } : {}) };
}

let installed = false;

export function installThreadLinkedPullRequest() {
  if (installed) return;
  installed = true;
  const thread = () => { const current = openThread(); return current && isServerThread(current.id) ? current : null; };
  const threadId = computed(() => thread()?.id ?? null);
  const persisted = computed(() => thread()?.linkedPullRequest ?? null, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const connected = () => backendStatus() === "connected";
  // useLinkedThreadPullRequest(environmentId, persisted): with server config known the link list answers instead, so
  // the persisted request has no status of its own and nothing is relinked.
  const fallback = computed(() => (pullRequestsSupported() ? null : persisted()), { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  useLinkedPullRequestSummary({
    environmentId: () => PRIMARY_ROUTING_ENVIRONMENT,
    reference: () => { const link = fallback(); return link ? linkedReference(link) : null; },
    connected,
    request: requestBackend,
    subscribe: subscribeBackend,
  });
  const persistedState = () => { const link = fallback(); return link ? sharedPullRequestSummary(PRIMARY_ROUTING_ENVIRONMENT, link)?.state ?? null : null; };
  // The thread's checkout status (ChatView's gitStatusQuery), read only while a replacement is possible.
  const status = signal<VcsStatus | null>(null);
  const statusCwd = computed(() => {
    const state = persistedState();
    if (!connected() || (state !== "merged" && state !== "closed")) return null;
    const current = thread();
    return current?.path ?? allProjects().find((project) => project.id === current?.projectId)?.path ?? null;
  });
  effect(() => {
    const cwd = statusCwd();
    status.set(null);
    if (!cwd) return;
    return watchVcsStatus(cwd, subscribeBackend, (next) => status.set(next), () => status.set(null));
  });
  const step = createThreadLinkedPullRequestRelinker({
    updateMetadata: ({ threadId: id, linkedPullRequest }) => requestBackend("orchestration.dispatchCommand", { type: "thread.metadata.update", commandId: `command:${crypto.randomUUID()}`, threadId: id, linkedPullRequest }),
    openSurface: (id) => {
      const state = panelStateFor(panelKeyFor(id));
      const surface = state.surfaces.find((item) => item.id === state.activeId) as { kind: string; projectId?: string; repository?: string; number?: number } | undefined;
      return surface ?? null;
    },
    openPullRequest: (_id, target) => openPullRequestSurface(target),
    toast: (input) => { showToast(input); },
  });
  effect(() => {
    const current = thread();
    const project = current ? allProjects().find((item) => item.id === current.projectId) : undefined;
    const git = status();
    const replacement = threadLinkedPullRequestReplacement({
      persisted: persisted(),
      persistedState: persistedState(),
      projectId: project?.id ?? null,
      projectRepository: projectRepositorySelector(project?.repositoryIdentity),
      threadBranch: current?.branch ?? null,
      gitStatus: git ? { refName: git.refName, pr: git.pr } : null,
    });
    const id = threadId();
    untracked(() => void step(id, persisted(), replacement));
  });
}
