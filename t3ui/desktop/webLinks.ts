// DesktopClerk.ts (open-url, open-file, second-instance) + DesktopWebLinks.ts + DesktopWebLinkCoordinator.tsx +
// promptLinks/linkedPrompt.ts: links the OS hands the app (`app.openUrls` from host patch 0010) open a thread, place a
// linked prompt, add a backend from a pairing link, or open a page / .html file in the preview browser. Links that
// arrive before the backend is connected wait for it, in order, as the reference's ready handshake does.
import { effect, signal, untracked } from "nsh";
import { allProjects, allThreads, activeProjectId, backendStatus, closeSettings, completeProviderAuth, openSettings, requestBackend, settingValue, composerDraft, createThread, openThread, openThreadById, setComposerDraft, shellSnapshotLoaded } from "../store";
import { closeToast, showToast } from "../components/toast/toastState";
import { confirm } from "../components/toast/confirmDialog";
import { openFileInPreview, openUrlInPreviewTab } from "../components/browser/previewOpeners";
import { addEnvironment } from "../pages/settings/environments/savedEnvironments";
import { onDesktopHostEvent, revealWindow } from "./desktopHost";
import { applyPendingMaximize, currentPanelKey, openPullRequestSurface, panelStateFor, requestPanelMaximize, surfaceAvailability, updatePanel } from "../components/rightPanel/panelState";
import { previewScopeState, watchPreviewScope } from "../components/rightPanel/previewScope";
import { openWelcomePage } from "../components/onboarding/firstRunState";
import { serverEnvironment } from "../pages/settings/settingsState";
import { isWebLink, isWebPageFile, parseNewThreadLink, parseThreadLinkPrompt, promptLinkAppPath, providerAuthReturnPath, readPairingAppLink, type LinkedPrompt } from "./promptLinkParse";
import { parsePullRequestLink } from "../components/pullRequest/pullRequestLinkPreview.logic";
import { createLiveNewThreadLink } from "./newThreadLinkLive";
import type { NewThreadLink } from "./promptLinkParse";
import { readCodexAuthDelivery, readCodexAuthHandoff, startCodexAuthHandoff, type CodexAuthDelivery, type CodexAuthHandoff } from "./codexAuth";

export interface WebLinkDeps {
  ready: () => boolean;
  reveal: () => void;
  openThreadById: (id: string) => void;
  threadExists: (id: string) => boolean;
  newThread: (projectId: string | null) => void;
  projectFor: (repository: { owner: string; name: string } | null) => string | null;
  draft: () => string;
  setDraft: (text: string) => void;
  hasOpenThread: () => boolean;
  /** threadShowingBrowser: the open thread's right panel shows a browser, so the link goes there. */
  threadShowingBrowser: () => boolean;
  /** startThread: a new thread in the environment's Scratch project, its right panel maximized; null after a failure toast. */
  startThread: () => Promise<boolean>;
  maximizePanel?: () => void;
  openUrl: (url: string) => void;
  openFile: (threadId: string, path: string) => Promise<unknown>;
  openThreadId: () => string | null;
  pair: (pairingUrl: string) => Promise<unknown>;
  confirm: (message: string) => Promise<boolean>;
  /** resumeProviderAuth: Settings (or the Welcome page) at the provider sign-in's return path. */
  openAppPage: (path: string) => void;
  /** useOpenChangeRequestLink: a pull request link of a project's repository opens in the app; false leaves it to the browser. */
  openPullRequest: (url: string) => boolean;
  /** startProviderAuthHandoff: the launcher receives the ChatGPT callback; false when it cannot. */
  codexHandoff: (handoff: CodexAuthHandoff) => Promise<boolean>;
  /** providerAuthDelivery: hands a delivered sign-in code to its environment. */
  completeCodexAuth: (delivery: CodexAuthDelivery) => Promise<void>;
  toast: typeof showToast;
  closeToast: (id: string) => void;
  /** NewThreadLinkView: a `/new` link resolves its project, thread, clone or checkout (desktop/newThreadLink.ts); without it the link opens a draft in the matching project. */
  openNewThreadLink?: (link: NewThreadLink) => void;
}

const reportFailure = (deps: WebLinkDeps, description: string) => {
  return deps.toast({ type: "error", title: "Could not open the link", description });
};

export function warnAboutHiddenCharacters(deps: WebLinkDeps, prompt: LinkedPrompt) {
  if (prompt.hiddenCharacters === 0) return;
  deps.toast({
    type: "warning",
    title: "This prompt had hidden characters, it may be malicious",
    description: `T3 Code removed ${prompt.hiddenCharacters} hidden character${prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.`,
    timeoutMs: 0,
  });
}

export function placeLinkedPrompt(deps: WebLinkDeps, prompt: LinkedPrompt, notes: readonly string[] = []) {
  warnAboutHiddenCharacters(deps, prompt);
  const place = () => {
    deps.setDraft(prompt.text);
    deps.toast({ type: "info", title: "Prompt added from a link", description: ["Read it before you send.", ...notes].join(" ") });
  };
  const existing = deps.draft();
  if (existing.trim().length === 0 || existing === prompt.text) { place(); return; }
  const id = deps.toast({
    type: "info",
    title: "Linked prompt ready",
    description: "This thread already has a draft. Replace it with the linked prompt?",
    timeoutMs: 0,
    actionLayout: "inline",
    actions: [{ label: "Replace draft", run: () => { deps.closeToast(id); place(); } }],
  });
}

export function createWebLinkRouter(deps: WebLinkDeps) {
  const pending: string[] = [];
  const paired = new Set<string>();
  let chain = Promise.resolve();

  const openAppPath = (appPath: string) => {
    const url = new URL(appPath, "https://app.invalid");
    if (url.pathname === "/new") {
      const link = parseNewThreadLink(url.search);
      if (!link.ok) { reportFailure(deps, link.error); return; }
      if (deps.openNewThreadLink) { deps.openNewThreadLink(link.value); return; }
      if (link.value.kind === "pull-request") {
        reportFailure(deps, "T3 Code could not open a new thread.");
        return;
      }
      deps.newThread(deps.projectFor(link.value.repository));
      placeLinkedPrompt(deps, link.value.prompt);
      return;
    }
    const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    const threadId = match?.[2] ? decodeURIComponent(match[2]) : null;
    if (!threadId || !deps.threadExists(threadId)) { reportFailure(deps, appPath); return; }
    deps.openThreadById(threadId);
    const prompt = parseThreadLinkPrompt(url.search);
    if (!prompt.ok) { deps.toast({ type: "error", title: "Could not open the linked prompt", description: prompt.error }); return; }
    if (prompt.value) placeLinkedPrompt(deps, prompt.value);
  };

  const pairFromLink = async (pairingUrl: string) => {
    if (paired.has(pairingUrl)) return;
    let origin: string;
    try { origin = new URL(pairingUrl).origin; } catch (error) {
      deps.toast({ type: "error", title: "Could not add backend", description: error instanceof Error ? error.message : "Failed to add backend." });
      return;
    }
    if (!(await deps.confirm(`Add the backend at ${origin}?`))) return;
    try { await deps.pair(pairingUrl); } catch (error) {
      deps.toast({ type: "error", title: "Could not add backend", description: error instanceof Error ? error.message : "Failed to add backend." });
      return;
    }
    paired.add(pairingUrl);
    deps.toast({ type: "success", title: "Backend added", description: "The environment is saved and will reconnect on app startup." });
  };

  const openInBrowser = async (url: string) => {
    // threadShowingBrowser (the open thread's panel shows a page), else a new Scratch-project thread.
    if (!deps.threadShowingBrowser() && !(await deps.startThread())) return;
    try {
      if (url.startsWith("file:")) {
        const threadId = deps.openThreadId();
        if (!threadId) { reportFailure(deps, url); return; }
        await deps.openFile(threadId, decodeURIComponent(new URL(url).pathname));
      } else deps.openUrl(url);
      deps.maximizePanel?.();
    } catch (error) {
      reportFailure(deps, error instanceof Error && error.message ? error.message : url);
    }
  };

  const openLink = async (url: string) => {
    const returnPath = providerAuthReturnPath(url);
    if (returnPath !== null) {
      // providerAuthDelivery: the code leaves the address before the page sees it.
      const delivery = readCodexAuthDelivery(url);
      deps.openAppPage(delivery ? providerAuthReturnPath(delivery.returnUrl) ?? returnPath : returnPath);
      if (delivery) await deps.completeCodexAuth(delivery);
      return;
    }
    const pairingUrl = readPairingAppLink(url);
    if (pairingUrl !== null) { await pairFromLink(pairingUrl); return; }
    const appPath = promptLinkAppPath(url);
    if (appPath !== null) { openAppPath(appPath); return; }
    if (deps.openPullRequest(url)) return;
    await openInBrowser(url);
  };

  /** DesktopClerk's handleOpenUrl + open-file: which OS links the app takes. */
  const accepts = (url: string) => {
    if (providerAuthReturnPath(url) !== null || readPairingAppLink(url) !== null || promptLinkAppPath(url) !== null || isWebLink(url)) return true;
    if (url.startsWith("file:")) { try { return isWebPageFile(new URL(url).pathname); } catch { return false; } }
    return false;
  };

  const flush = () => {
    if (!deps.ready()) return;
    const urls = pending.splice(0);
    if (urls.length === 0) return;
    for (const url of urls) chain = chain.then(() => openLink(url)).catch(() => undefined);
    deps.reveal();
  };

  return {
    receive(urls: readonly string[]) {
      for (const url of urls) {
        // A sign-in handoff runs at once (DesktopClerk handleOpenUrl's first case), not after the backend is ready.
        const handoff = readCodexAuthHandoff(url);
        if (handoff) { void deps.codexHandoff(handoff).then((started) => { if (!started) console.warn("Could not complete ChatGPT desktop handoff."); }).catch(() => console.warn("Could not complete ChatGPT desktop handoff.")); continue; }
        if (accepts(url)) pending.push(url);
      }
      flush();
    },
    flush,
    settled: () => chain,
  };
}

/** The controller of the `/new` link page (NewThreadLinkPage), set once the links are installed. */
const newThreadLink = signal<ReturnType<typeof createLiveNewThreadLink> | null>(null);
export const newThreadLinkController = () => newThreadLink();

let installed = false;

export function installWebLinks() {
  if (installed) return;
  installed = true;
  const webDeps: WebLinkDeps = {
    ready: () => backendStatus() === "connected" && shellSnapshotLoaded(),
    reveal: () => { revealWindow(); },
    openThreadById,
    threadExists: (id) => allThreads().some((thread) => thread.id === id),
    newThread: createThread,
    projectFor: (repository) => {
      if (!repository) return activeProjectId();
      const name = repository.name.toLowerCase();
      return allProjects().find((project) => project.name.toLowerCase() === name)?.id ?? null;
    },
    draft: composerDraft,
    setDraft: setComposerDraft,
    hasOpenThread: () => openThread() !== null && openThread() !== undefined,
    threadShowingBrowser: () => {
      if (!openThread() || !surfaceAvailability().rightPanel || previewScopeState() === "denied") return false;
      const state = panelStateFor(currentPanelKey());
      return state.open && state.surfaces.find((surface) => surface.id === state.activeId)?.kind === "preview";
    },
    maximizePanel: () => { const key = currentPanelKey(); if (key) updatePanel(key, (state) => ({ ...state, open: true, maximized: state.surfaces.length > 0 })); },
    startThread: async () => {
      try {
        const answer = await requestBackend("projects.ensureScratch", {});
        const projectId = typeof answer === "object" && answer !== null ? (answer as { projectId?: unknown }).projectId : undefined;
        if (typeof projectId !== "string") throw new Error("The environment did not return its Scratch project.");
        // openScratch resolves once the project is in the client store (10 s).
        for (let i = 0; i < 40 && !allProjects().some((project) => project.id === projectId); i++) await new Promise((resolve) => setTimeout(resolve, 250));
        if (!allProjects().some((project) => project.id === projectId)) throw new Error("The Scratch project did not appear.");
        createThread(projectId);
        // requestMaximize: the new thread's panel maximizes once a tab opens in it (consumed by applyPendingMaximize).
        const key = currentPanelKey();
        if (key) requestPanelMaximize(key);
        return true;
      } catch (error) {
        showToast({ type: "error", title: "Could not open the link", description: error instanceof Error ? error.message : "An error occurred." });
        return false;
      }
    },
    // The reference opens a scratch-project thread with the panel maximized; here the open thread's panel must take it
    // (a draft without a project has no right panel), else the reference's failure toast names the link.
    openUrl: (url) => { if (!surfaceAvailability().rightPanel) throw new Error(url); openUrlInPreviewTab(url); },
    openFile: async (threadId, filePath) => {
      if (!surfaceAvailability().rightPanel) throw new Error(`file://${filePath}`);
      return openFileInPreview({ threadId, filePath, workspaceRoot: undefined });
    },
    openThreadId: () => openThread()?.id ?? null,
    pair: (pairingUrl) => addEnvironment({ host: pairingUrl, pairingCode: "" }),
    confirm: (message) => confirm(message),
    openAppPage: (path) => {
      if (path.startsWith("/welcome")) { closeSettings(); openWelcomePage(); return; }
      openSettings(path.split(/[?#]/, 1)[0] || "/settings/general");
    },
    codexHandoff: (handoff) => startCodexAuthHandoff(handoff),
    completeCodexAuth: async (delivery) => {
      // Waits for its environment, as startProviderAuthDelivery subscribes to the presentation.
      for (let i = 0; i < 240 && !(backendStatus() === "connected" && serverEnvironment()?.environmentId === delivery.environmentId); i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!(backendStatus() === "connected" && serverEnvironment()?.environmentId === delivery.environmentId)) {
        showToast({ type: "error", title: "ChatGPT sign-in couldn't finish", description: "Reconnect to the environment and try again." });
        return;
      }
      try {
        await completeProviderAuth(delivery.instanceId, delivery.flowId, delivery.callbackUrl);
      } catch {
        showToast({ type: "error", title: "ChatGPT sign-in couldn't finish", description: "Return to the provider and try again." });
      }
    },
    openPullRequest: (url) => {
      if (settingValue("pullRequestLinksOpenInApp") === false) return false;
      const link = parsePullRequestLink(url);
      if (!link) return false;
      const [owner, name] = link.repository.toLowerCase().split("/");
      const project = allProjects().find((candidate) => {
        const identity = candidate.repositoryIdentity as { owner?: string; name?: string; locator?: { host?: string } } | undefined;
        return identity?.owner?.toLowerCase() === owner && identity?.name?.toLowerCase() === name;
      });
      if (!project) return false;
      if (openThread()?.projectId !== project.id || !surfaceAvailability().rightPanel) createThread(project.id);
      openPullRequestSurface({ projectId: project.id, host: link.host, repository: link.repository, number: link.number, url });
      return true;
    },
    toast: showToast,
    closeToast,
  };
  const controller = createLiveNewThreadLink({
    placePrompt: (prompt, notes) => placeLinkedPrompt(webDeps, prompt, notes),
    warnHidden: (prompt) => warnAboutHiddenCharacters(webDeps, prompt),
  });
  webDeps.openNewThreadLink = (link) => { void controller.open(link); };
  newThreadLink.set(controller);
  const router = createWebLinkRouter(webDeps);
  watchPreviewScope();
  onDesktopHostEvent<unknown>("app.openUrls", (urls) => {
    if (Array.isArray(urls)) router.receive(urls.filter((u): u is string => typeof u === "string"));
  });
  // DesktopClerk handleSecondInstance: a relaunch with nothing to open reveals the window.
  onDesktopHostEvent<unknown>("app.reopen", () => { revealWindow(); });
  effect(() => {
    const ready = backendStatus() === "connected" && shellSnapshotLoaded();
    if (ready) untracked(() => router.flush());
  });
  // ChatView consumeMaximizeRequest: the requested panel maximizes as soon as it is open with a tab.
  effect(() => { applyPendingMaximize(); });
}
