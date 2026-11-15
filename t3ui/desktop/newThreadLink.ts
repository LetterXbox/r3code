// promptLinks/NewThreadLinkView.tsx and @t3tools/client-runtime promptLinks.ts: what an incoming `/new?prompt` or `/new?pr` link does.
// The link opens the thread of its pull request when one is linked; with no repository it opens a draft in the Scratch project;
// with a repository it opens a draft in the repository's most recently active project, or (nothing cloned) asks to clone it;
// a pull request link with a project asks before it checks the code out in a worktree. The page the user sees for the states
// that need an answer is desktop/NewThreadLinkPage.tsx. Single environment: the reference's per-machine choices (the last active
// environment, every reachable shell) collapse to the one this app is connected to.
import { signal } from "nsh";
import type { LinkedPrompt, NewThreadLink, PromptLinkPullRequest, PromptLinkRepository } from "./promptLinkParse";

export const promptLinkPullRequestUrl = (pullRequest: PromptLinkPullRequest) => `https://github.com/${pullRequest.owner}/${pullRequest.name}/pull/${pullRequest.number}`;

// A link's `owner/name` is GitHub's. GitCafe syncs a repository two-way with GitHub under the same path.
const PROMPT_LINK_REPOSITORY_HOSTS = ["github.com", "git.cafe", "staging.git.cafe"];

const dict = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** repositoryGroupingKeyOf: the origin's canonical key, else the identity's own. */
export function repositoryGroupingKey(identity: unknown): string | null {
  const value = dict(identity);
  const origin = dict(value?.origin);
  const key = typeof origin?.canonicalKey === "string" ? origin.canonicalKey : typeof value?.canonicalKey === "string" ? value.canonicalKey : null;
  return key && key.length > 0 ? key : null;
}

/** findPromptLinkProjects: the repository's projects in the order given (callers pass the most recently active first). */
export function findPromptLinkProjects<P extends { repositoryIdentity?: unknown }>(projects: readonly P[], repository: PromptLinkRepository): P[] {
  const path = `${repository.owner}/${repository.name}`.toLowerCase();
  const keys = new Set(PROMPT_LINK_REPOSITORY_HOSTS.map((host) => `${host}/${path}`));
  return projects.filter((project) => {
    const key = repositoryGroupingKey(project.repositoryIdentity);
    return key !== null && keys.has(key.toLowerCase());
  });
}

export interface LinkThread {
  id: string;
  updatedAt: number;
  sideChat?: boolean;
  /** The thread's linked pull requests, dismissed ones already left out. */
  pullRequests: readonly { host: string; repository: string; number: number }[];
}

/** findPromptLinkPullRequestThread: the most recently updated visible thread linked to the pull request (side chats stay hidden). */
export function findPromptLinkPullRequestThread<T extends LinkThread>(threads: readonly T[], pullRequest: PromptLinkPullRequest): T | undefined {
  const repository = `${pullRequest.owner}/${pullRequest.name}`.toLowerCase();
  let latest: T | undefined;
  for (const thread of threads) {
    if (latest !== undefined && thread.updatedAt <= latest.updatedAt) continue;
    if (thread.sideChat === true) continue;
    if (thread.pullRequests.some((link) => link.host.trim().toLowerCase() === "github.com" && link.repository.trim().toLowerCase() === repository && link.number === pullRequest.number)) latest = thread;
  }
  return latest;
}

export interface LinkProviderModel { slug: string; name: string; isDefault?: boolean; aliases?: readonly string[] }
export interface LinkProvider { instanceId: string; driver: string; enabled: boolean; available: boolean; status: string; models: readonly LinkProviderModel[] }

const PROVIDER_ALIASES: Record<string, string> = { claude: "claudeagent" };

/** resolveSelectableModel: a model by slug, name or alias, case-insensitive for the last two. */
function resolveModel(value: string | null, models: readonly LinkProviderModel[]): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  return (models.find((m) => m.slug === trimmed) ?? models.find((m) => m.name.toLowerCase() === lower) ?? models.find((m) => m.aliases?.some((alias) => alias.toLowerCase() === lower)))?.slug ?? null;
}

/** resolvePromptLinkModelSelection: `exact` is false when the instance exists but the model does not (its default stands in); null when no usable instance exists. */
export function resolvePromptLinkModelSelection(providers: readonly LinkProvider[], request: { provider: string; model: string | null }): { selection: { instanceId: string; model: string }; exact: boolean } | null {
  const driver = PROVIDER_ALIASES[request.provider] ?? request.provider;
  const usable = providers.filter((provider) => provider.driver.toLowerCase() === driver && provider.enabled && provider.available);
  const instance = usable.find((provider) => provider.status === "ready") ?? usable.find((provider) => provider.status === "warning");
  if (instance === undefined) return null;
  const requested = request.model === null ? null : resolveModel(request.model, instance.models);
  const model = requested ?? (instance.models.find((candidate) => candidate.isDefault) ?? instance.models[0])?.slug;
  if (model === undefined) return null;
  return { selection: { instanceId: instance.instanceId, model }, exact: request.model === null || requested !== null };
}

export type NewThreadLinkState =
  | { status: "opening" }
  | { status: "failed"; message: string; title?: string }
  | { status: "missing-repository"; repository: PromptLinkRepository }
  | { status: "pull-request-checkout"; projectId: string };

export interface LinkProject { id: string; path: string | null; repositoryIdentity?: unknown }

export interface NewThreadLinkDeps {
  threads: () => readonly LinkThread[];
  /** Projects, most recently active first, the Scratch project left out. */
  projects: () => readonly LinkProject[];
  providers: () => readonly LinkProvider[];
  /** Opens a draft in the project; false when none opened. */
  openDraft: (projectId: string) => boolean;
  openThread: (threadId: string) => void;
  setModel: (selection: { instanceId: string; model: string }) => void;
  placePrompt: (prompt: LinkedPrompt, notes: readonly string[]) => void;
  /** The Scratch project's id, null when this environment offers none. */
  openScratch: () => Promise<string | null>;
  /** pullRequests.linkedThreads: the first thread of the pull request that is not archived. */
  serverPullRequestThread: (projectIds: readonly string[], pullRequest: PromptLinkPullRequest) => Promise<string | null>;
  /** projectClone.start; throws the server's error. */
  cloneFacts: () => Promise<{ newProjectsRoot: string | null; destinationRoot: string; ghqCloneLayout: boolean }>;
  startClone: (input: { projectId: string; title: string; remoteUrl: string; destinationPath: string }) => Promise<void>;
  directoryPath: (remoteUrl: string, ghq: boolean) => string;
  destinationPath: (root: string, directory: string) => string;
  waitForProject: (projectId: string, timeoutMs: number) => Promise<boolean>;
  suggestAppAccess: (remoteUrl: string) => void;
  newId: () => string;
  /** The worktree checkout of a pull request (createPullRequestCheckoutModel.start); true once the thread sits on it. */
  checkout: (input: { projectId: string; url: string }) => Promise<boolean>;
  setDraft: (text: string) => void;
  warnHidden: (prompt: LinkedPrompt) => void;
  toast: (input: { type: "error"; title: string; description: string }) => void;
}

export function createNewThreadLinkController(deps: NewThreadLinkDeps) {
  const state = signal<NewThreadLinkState | null>(null);
  const checkingOut = signal(false);
  let current: NewThreadLink | null = null;
  const done = () => state.set(null);

  async function openDraft(link: NewThreadLink, projectId: string, extraPrompt?: string) {
    if (!deps.openDraft(projectId)) { state.set({ status: "failed", message: "T3 Code could not open a new thread." }); return; }
    done();
    const notes: string[] = [];
    if (link.kind === "new" && link.provider !== null) {
      const resolved = resolvePromptLinkModelSelection(deps.providers(), { provider: link.provider, model: link.model });
      if (resolved !== null) deps.setModel(resolved.selection);
      if (resolved === null || !resolved.exact) {
        notes.push(resolved === null
          ? `The link asked for ${link.provider}, which is not set up here, so your default model is used.`
          : `The link asked for ${link.model}, which ${link.provider} does not offer here, so its default model is used.`);
      }
    }
    const text = [link.prompt?.text, extraPrompt].filter(Boolean).join("\n\n");
    if (text.length === 0) return;
    deps.placePrompt({ text, hiddenCharacters: link.prompt?.hiddenCharacters ?? 0 }, notes);
  }

  async function openScratchDraft(link: NewThreadLink) {
    const projectId = await deps.openScratch().catch(() => null);
    if (projectId === null) { state.set({ status: "failed", message: "None of your machines can start a thread without a project right now." }); return; }
    await openDraft(link, projectId, link.kind === "pull-request" ? promptLinkPullRequestUrl(link.pullRequest) : undefined);
  }

  async function open(link: NewThreadLink) {
    current = link;
    state.set({ status: "opening" });
    const recent = deps.projects();
    const repository = link.kind === "new" ? link.repository : link.pullRequest;
    const project = repository === null ? undefined : findPromptLinkProjects(recent, repository)[0];
    let threadId: string | null = null;
    if (link.kind === "pull-request") {
      threadId = findPromptLinkPullRequestThread(deps.threads(), link.pullRequest)?.id ?? null;
      // A pull request's thread can be an older settled thread no shell holds, so the server is asked too.
      const lookups = findPromptLinkProjects(recent, link.pullRequest).map((candidate) => candidate.id);
      if (threadId === null && lookups.length > 0) threadId = await deps.serverPullRequestThread(lookups, link.pullRequest).catch(() => null);
    }
    if (threadId !== null) {
      done();
      deps.openThread(threadId);
      if (link.prompt !== null) deps.placePrompt(link.prompt, []);
      return;
    }
    if (repository === null) { await openScratchDraft(link); return; }
    if (project === undefined) { state.set({ status: "missing-repository", repository }); return; }
    if (link.kind === "pull-request") {
      state.set({ status: "pull-request-checkout", projectId: project.id });
      if (link.prompt !== null) deps.warnHidden(link.prompt);
      return;
    }
    await openDraft(link, project.id);
  }

  async function cloneRepository(repository: PromptLinkRepository) {
    const link = current;
    if (link === null) return;
    const facts = await deps.cloneFacts();
    if (facts.newProjectsRoot === null) {
      state.set({ status: "failed", message: "This machine cannot clone from a link. Update T3 Code on it, or clone the repository from the command palette." });
      return;
    }
    state.set({ status: "opening" });
    const projectId = deps.newId();
    const remoteUrl = `https://github.com/${repository.owner}/${repository.name}.git`;
    try {
      await deps.startClone({
        projectId,
        title: repository.name,
        remoteUrl,
        destinationPath: deps.destinationPath(facts.ghqCloneLayout ? facts.destinationRoot : facts.newProjectsRoot, deps.directoryPath(remoteUrl, facts.ghqCloneLayout)),
      });
    } catch (error) {
      deps.toast({ type: "error", title: "Clone failed", description: error instanceof Error ? error.message : "An error occurred." });
      state.set({ status: "missing-repository", repository });
      return;
    }
    deps.suggestAppAccess(remoteUrl);
    if (!(await deps.waitForProject(projectId, 5_000))) {
      state.set({ status: "failed", message: "The clone started, but its project did not appear." });
      return;
    }
    if (link.kind === "pull-request") {
      state.set({ status: "failed", title: `Cloning ${repository.owner}/${repository.name}`, message: "Open this link again when the clone finishes." });
      return;
    }
    await openDraft(link, projectId);
  }

  const useWithoutProject = () => { if (current) { state.set({ status: "opening" }); void openScratchDraft(current); } };

  /** PullRequestLinkCheckout: checkout runs setup from PR code, so a link alone never starts it. */
  async function checkout() {
    const link = current;
    const page = state();
    if (link === null || link.kind !== "pull-request" || page?.status !== "pull-request-checkout" || checkingOut()) return;
    checkingOut.set(true);
    const ready = await deps.checkout({ projectId: page.projectId, url: promptLinkPullRequestUrl(link.pullRequest) });
    checkingOut.set(false);
    if (!ready) return;
    if (link.prompt !== null) deps.setDraft(link.prompt.text);
    done();
  }

  return { state, checkingOut, open, cloneRepository, useWithoutProject, checkout, dismiss: done, link: () => current };
}

export type NewThreadLinkController = ReturnType<typeof createNewThreadLinkController>;
