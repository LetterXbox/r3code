// Signals and side effects for the palette. Rows come from paletteLogic.ts;
// open state and the query stay in store.ts (App and the sidebar call into those).
import { findForMessageMatch, openThreadFindOnQuery } from "../thread/threadFindState";
import { Clipboard, computed, effect, host, platform, setColorScheme, signal, untracked } from "nsh";
import { canPickFolder, pickFolder } from "../../desktop/dialogs";
import { chooseTheme, themeForMode } from "../../pages/settings/Appearance";
import { THEME_CARDS } from "../../themePreviews";
import { currentPanelKey, currentWorkspace, panelStateFor } from "../rightPanel/panelState";
import { openFileAction } from "../rightPanel/panelState";
import { createPaletteSearch } from "./paletteSearch";
import { FILESYSTEM_READ_SCOPE, sessionScopeState } from "../../backend/sessionScopes";
import { openPalette } from "../../store";
import { SETTINGS_NAV, SETTINGS_SUBPAGES } from "../../settingsNav";
import { hasCommandHandler, readContext, runCommand, shortcutLabel } from "../../commands/registry";
import { serverEnvironment, serverManagedPolicy, serverSettings } from "../../pages/settings/settingsState";
import { canShareWithGuest, openGuestShareDialog } from "../header/guestShare";
import { openThemeEditor } from "../../pages/settings/ThemeLibrary";
import { allThemeIds, copyIdentity, themeFromCard } from "../../pages/settings/customThemes";
import { cardById, appearanceMode } from "../../pages/settings/themeSelection";
import { closeToast, errorToast, showToast } from "../toast/toastState";
import { environmentId as serverEnvironmentId, hostedThreadLink, factsFromConfig } from "../sidebar/serverFacts";
import { openLinkPullRequestDialog } from "../pullRequest/linkPullRequestState";
import { usageEnvironmentList } from "../usage/usageState";
import { environmentStatuses, savedEnvironments, savedEnvironmentStatus } from "../../pages/settings/environments/savedEnvironments";
import { activePullRequest, panelPullRequestUrl } from "../pullRequest/activePullRequest";
import { openUseInAnotherApp } from "../mcp/useInAnotherAppState";
import { buildPromptLink } from "./promptLinks";
import { openScratchProject } from "../thread/scratchProject";
import { SETTINGS_PANELS } from "../../settingsPanels";
import { resolveThreadStatusPill } from "../sidebar/threadStatus";
import { groupSidebarProjects, projectPickerEntries } from "../sidebar/projectGrouping";
import { sortSidebarProjects } from "../SidebarUtils";
import {
  addProjectIntent, allProjects, allThreads, backendStatus, closePalette, composerDraft, createThread, isProjectArchived, isServerThread, openSettings,
  refreshProviderStatuses, setComposerDraft,
  openThread, openThreadById, openUsage, openUtility, utilityPage, paletteQuery, projectOrganizationSupported, requestBackend,
  paletteShowsBackHint, paletteOpen, setPaletteQuery, setProjectPinned, settingValue, updateSetting,
  paletteBack as storePaletteBack,
} from "../../store";
import {
  addProjectConnected, addProjectEnvironmentId, addProjectFromPath, addProjectInitialQuery, browseCwd, browseListing, browsePending, cloneFlow, createNewProject as createProjectFromName,
  discoveredProviders, environmentPlatform, ghqCloneLayout, isCloning, isCreatingProject, isLookingUp, loadAddProjectFacts, loadBrowse, loadDiscovery,
  newProjectPublishKind, newProjectPublishes, newProjectsRoot, resetAddProjectFlow, setCloneFlow, submitCloneDestination, submitCloneRepository,
  setAddProjectEnvironment, setNewProjectPublishKind, toggleNewProjectPublishes, type CloneFlow,
} from "./addProject/addProjectState";
import {
  browseGroups, describeBrowse, environmentGroups, newProjectGroups, resolvedBrowsePath, sourceItems, willCreatePath, type AddProjectEnvironmentOption, type BrowseView, type NewProjectView,
} from "./addProject/addProjectGroups";
import {
  appendBrowsePathSegment, buildPaletteReadiness, hasTrailingPathSeparator, resolveProjectPathForDispatch, getBrowseDirectoryPath, getBrowseTabCompletion, getCloneDestinationBrowsePath, getCloneDestinationPath,
  getCloneDirectoryLeafName, getNewProjectPathPreview, getNewProjectPublishTarget, getNewProjectPublishTargets, getNewProjectRepository, isWindowsPlatform,
  remoteInputPlaceholder, URL_SOURCE,
} from "./addProject/addProjectLogic";
import {
  buildPaletteGroups, flattenGroups, PALETTE_SHORTCUTS, type Appearance, type PaletteLinkedThreads, type PaletteGroup, type PaletteInput, type PaletteItem, type PaletteMode,
} from "./paletteLogic";

// The views the palette has entered, innermost last; empty is the root list. Back pops one.
const stack = signal<PaletteMode[]>([]);
const mode = (): PaletteMode => stack().at(-1) ?? "root";
export const paletteMode = () => mode();

let searchRequest: (method: string, payload: unknown) => Promise<unknown> = (method, payload) => requestBackend(method, payload);
/** Tests answer the lookups without a server behind them. */
export function setPaletteSearchRequest(request: typeof searchRequest) {
  searchRequest = request;
}
export const paletteSearch = createPaletteSearch({ request: (method, payload) => searchRequest(method, payload), debounceMs: 0 });

function workspaceTarget(): { cwd: string; name: string } | null {
  const workspace = currentWorkspace();
  if (!workspace?.cwd) return null;
  const name = workspace.cwd.split("/").filter(Boolean).pop() ?? workspace.cwd;
  return { cwd: workspace.cwd, name };
}
export const paletteWorkspace = workspaceTarget;

// Child searches and message search follow the mode and the query.
effect(() => {
  const query = paletteQuery();
  const current = mode();
  const workspace = workspaceTarget();
  const open = paletteOpen();
  if (!open) { paletteSearch.reset(); return; }
  if (current === "files" && workspace) paletteSearch.searchFiles(workspace.cwd, query);
  else if (current === "content" && workspace) { if (sessionScopeState(FILESYSTEM_READ_SCOPE) === "granted") paletteSearch.searchContent(workspace.cwd, query); else paletteSearch.reset(); }
  else if (current === "root") paletteSearch.searchMessages(query);
  else paletteSearch.reset();
  paletteSearch.caseSensitive();
  paletteSearch.wholeWord();
  paletteSearch.useRegex();
});

export function paletteHasBackHint(): boolean {
  return mode() !== "root";
}

/** The environments an added project could go to: the live connection and the saved ones that are on and reachable. */
export function addProjectEnvironmentOptions(): AddProjectEnvironmentOption[] {
  const saved = savedEnvironments();
  const statuses = environmentStatuses();
  return usageEnvironmentList().flatMap((entry): AddProjectEnvironmentOption[] => {
    const environment = saved.find((candidate) => candidate.id === entry.id);
    const phase = environment ? statuses[environment.id]?.phase : undefined;
    // The ones the web lists are those that can create a project: connected, or still connecting.
    if (!entry.connected && phase !== "checking") return [];
    return [{
      id: environment ? environment.id : null, label: entry.label, connected: entry.connected, isPrimary: !environment,
      status: environment ? savedEnvironmentStatus(environment, statuses[environment.id]).text : "Connecting",
    }];
  });
}

/** resolveAddProjectEntry: with several environments the chooser comes first; with one, its sources. */
export function addProjectEntryMode(): PaletteMode {
  const options = addProjectEnvironmentOptions();
  if (options.length > 1) return "add-project-environment";
  const only = options[0];
  if (only) setAddProjectEnvironment(only.id);
  return "add-project";
}

/** The label of the environment the flow works on, shown on the New project summary only when there is a choice. */
export function addProjectEnvironmentLabel(): string | null {
  const options = addProjectEnvironmentOptions();
  if (options.length < 2) return null;
  const id = addProjectEnvironmentId();
  return options.find((option) => option.id === id)?.label ?? null;
}

/** The palette opens in a submenu when the store opened it on Add project. */
export function syncPaletteModeOnOpen() {
  const wanted = pendingMode;
  pendingMode = null;
  resetAddProjectFlow();
  loadAddProjectFacts();
  stack.set(wanted ? [wanted === "add-project" ? addProjectEntryMode() : wanted] : paletteShowsBackHint() ? [addProjectEntryMode()] : []);
  enterView(stack().at(-1) ?? "root");
}

let pendingMode: PaletteMode | null = null;
/** Opens the palette on a submenu (theme.select opens "Change theme"). */
export function openPaletteOn(next: PaletteMode) {
  pendingMode = next;
  openPalette();
}

/** filePicker.toggle / projectSearch.toggle (ToggleMode): the child search opens, and the same shortcut again closes the palette. */
export function togglePaletteMode(next: "files" | "content") {
  if (paletteOpen() && mode() === next) { closePalette(); return; }
  if (!paletteOpen()) { openPaletteOn(next); return; }
  stack.set([next]);
  setPaletteQuery("");
  paletteHighlight.set(null);
}

/** What the field held, and the linked-thread rows it showed, when a child search was entered from a row: Escape restores them. */
let parentSearch: { query: string; linked: PaletteLinkedThreads | null } | null = null;

/** The threads a pull request page opened the palette on; the rows show while the field holds exactly their query. */
const linkedThreadSearch = signal<PaletteLinkedThreads | null>(null);

/** commandPaletteBus openCommandPalette({ query, linkedThreads }): the palette opens on the query with those threads as its rows. */
export function openPaletteOnLinkedThreads(search: PaletteLinkedThreads) {
  parentSearch = null;
  linkedThreadSearch.set(search);
  openPalette();
  setPaletteQuery(search.query);
}

/** Escape: a child search (files, contents) goes back to the command list, with the query and linked threads it was entered from; anywhere else it closes the palette. */
export function paletteEscape() {
  const view = mode();
  if (view === "files" || view === "content") {
    const restored = parentSearch;
    parentSearch = null;
    stack.set([]);
    setPaletteQuery(restored?.query ?? "");
    linkedThreadSearch.set(restored?.linked ?? null);
    paletteHighlight.set(null);
    storePaletteBack();
    if (restored?.query) setPaletteQuery(restored.query);
    return;
  }
  closePalette();
}

export function resetPaletteMode() {
  parentSearch = null;
  linkedThreadSearch.set(null);
  stack.set([]);
  setAddProjectEnvironment(null);
  paletteHighlight.set(null);
  resetAddProjectFlow();
}

/** What a view needs the moment it is shown: the server's facts and discovery behind Add project and New project. */
function enterView(view: PaletteMode) {
  if (view === "add-project" || view === "new-project") {
    loadAddProjectFacts();
    loadDiscovery();
  }
}

/** Enter a view: the field restarts with that view's own text (a path browser starts at the add-project base directory). */
export function pushMode(next: PaletteMode, initialQuery = "") {
  if (next === "new-project") resetAddProjectFlow();
  stack.update((views) => [...views, next]);
  setPaletteQuery(initialQuery);
  paletteHighlight.set(null);
  enterView(next);
}

/** Leave the innermost view; leaving the last one is back to the root list. The palette stays open. */
export function goBack() {
  resetAddProjectFlow();
  stack.update((views) => views.slice(0, -1));
  if (stack().length === 0) storePaletteBack();
  setPaletteQuery("");
  paletteHighlight.set(null);
}

// Add project, asked for from outside the open palette (the sidebar button, an empty state), lands on the Sources view.
effect(() => {
  addProjectIntent();
  if (!untracked(() => paletteOpen())) return;
  untracked(() => {
    resetAddProjectFlow();
    stack.set([addProjectEntryMode()]);
    setPaletteQuery("");
    paletteHighlight.set(null);
    enterView("add-project");
  });
});

/** The row the keys act on, by flat index; null is "nothing highlighted" (Enter then submits the field). */
export const paletteHighlight = signal<number | null>(null);

interface SettingsEntry { id: string; title: string; section: string; path: string }

function settingsEntries(): SettingsEntry[] {
  const labels = [...SETTINGS_NAV.flatMap((group) => group.sections), ...SETTINGS_SUBPAGES];
  const out: SettingsEntry[] = [];
  for (const panel of SETTINGS_PANELS) {
    if (panel.path === "/settings/secrets") continue;
    const section = labels.find((entry) => entry.path === panel.path)?.label ?? panel.name;
    for (const sectionDef of panel.sections) {
      for (const row of sectionDef.rows) out.push({ id: row.id ?? `${panel.path}:${row.title}`, title: row.title, section, path: panel.path });
    }
  }
  return out;
}

let settingsCache: SettingsEntry[] | null = null;

/** The badge of every palette command from the registry's resolved bindings (the defaults plus the user's overrides). */
export function resolvedShortcutLabels(): Record<string, string> {
  const context = readContext();
  const labels: Record<string, string> = {};
  for (const command of Object.keys(PALETTE_SHORTCUTS)) {
    const label = shortcutLabel(command, context);
    if (label) labels[command] = label;
  }
  return labels;
}

/**
 * resolveThreadReferenceCopyTarget: on the Pull requests page only an open pull request has a link to copy; otherwise the pull
 * request open there, else the thread's current linked pull request, is "Copy PR link", and a thread with none is "Copy thread".
 */
function referenceTarget(current: NonNullable<ReturnType<typeof openThread>>, server: boolean, environment: string | null | undefined) {
  if (utilityPage() !== "pull-requests") {
    // useOpenPanelPullRequestUrl: a pull request tab open in the right panel is the link; null while its URL is unknown.
    const state = panelStateFor(currentPanelKey());
    const surface = state.open ? state.surfaces.find((entry) => entry.id === state.activeId) : undefined;
    if (surface?.kind === "pull-request") {
      const url = panelPullRequestUrl(surface as { id: string; url?: string });
      return url ? { text: url, description: url, notice: "PR link copied", kind: "pull-request" as const } : null;
    }
  }
  const open = activePullRequest()?.url;
  if (utilityPage() === "pull-requests" && !open) return null;
  const linked = (current.relations?.pullRequests ?? []).find((link) => link.source !== "stack-dismissed")?.url;
  const url = open ?? linked;
  if (url) return { text: url, description: url, notice: "PR link copied", kind: "pull-request" as const };
  return server && environment ? { text: hostedThreadLink(environment, current.id), description: current.title, notice: "Thread copied" } : null;
}

function threadFacts(current: ReturnType<typeof openThread>): PaletteInput["thread"] {
  if (!current) return undefined;
  const server = isServerThread(current.id);
  const promptLink = buildPromptLink(composerDraft());
  const environment = serverEnvironmentId();
  return {
    serverThread: server,
    canShareWithGuest: canShareWithGuest({ settings: serverSettings(), managedPolicy: serverManagedPolicy(), connected: backendStatus() === "connected" }),
    canFind: hasCommandHandler("chat.find"),
    promptLink,
    promptLinkWithContext: null,
    canLinkPullRequest: serverEnvironment() !== null,
    // visibleThreadPullRequests: the links that were not dismissed from a stack.
    linkedPullRequests: (current.relations?.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed").length,
    reference: referenceTarget(current, server, environment),
  };
}

/** thread.copyReference: copies the open thread's hosted link, as the Copy thread row does. False when the thread has none. */
export function copyActiveThreadReference(): boolean {
  const reference = threadFacts(openThread())?.reference;
  if (!reference) return false;
  void copyToClipboard(reference.text, reference.notice, reference.description, "Could not copy thread");
  return true;
}

/**
 * canBrowsePaths: every view but the clone's repository step and the New project name (CommandPalette.tsx), so a path typed
 * anywhere browses folders. Files and Content search are this port's own views, whose text is a search, not a path.
 */
function browseEligible(): boolean {
  const view = mode();
  if (view === "new-project" || view === "files" || view === "content") return false;
  return view === "clone" ? cloneFlow()?.step === "confirm" : true;
}

/** The path field read as a folder browser (Local folder, the destination of a clone, or a path typed in any view). */
export const browseView = computed<BrowseView>(() => {
  const view = mode();
  const flow = cloneFlow();
  const enabled = view === "add-project-browse" || browseEligible();
  return describeBrowse({
    query: paletteQuery(), platform: environmentPlatform(), cwd: browseCwd(), listing: browseListing(), pending: browsePending(),
    pinnedDirectoryName: pinnedCloneName(), enabled,
  });
});

export const paletteGroups = computed<PaletteGroup[]>(() => {
  const current = openThread();
  const colorScheme = settingValue("colorScheme");
  const appearance: Appearance = colorScheme === "light" || colorScheme === "dark" ? colorScheme : "system";
  const query = paletteQuery();
  const view = mode();
  // A path typed (or pasted) in any view lists the server's directories, as CommandPalette.tsx's root-browse and submenu-browse.
  if (view !== "clone" && view !== "add-project-browse" && browseEligible() && browseView().isBrowsing) return browseGroups(browseView(), "Directories");
  if (view === "add-project-environment") return environmentGroups(addProjectEnvironmentOptions(), query);
  if (view === "add-project" && addProjectConnected()) {
    return sourceItems({ readiness: buildPaletteReadiness(discoveredProviders()), newProjectsRoot: newProjectsRoot(), query });
  }
  if (view === "add-project-browse") return browseGroups(browseView(), "Directories");
  if (view === "clone") return cloneFlow()?.step === "confirm" ? browseGroups(browseView(), "Select where to clone") : [];
  if (view === "new-project") return newProjectGroups(newProjectView());
  if (mode() === "root" && query.trim() && !settingsCache) settingsCache = settingsEntries();
  let projects = allProjects();
  if (view === "new-thread-in") {
    const grouping = {
      environmentId: String(serverEnvironment()?.environmentId ?? ""),
      globalMode: settingValue("sidebarProjectGroupingMode"),
      overrides: settingValue("sidebarProjectGroupingOverrides"),
    };
    const availableProjects = projects.filter((project) => !isProjectArchived(project.id));
    const pickerEntries = projectPickerEntries(availableProjects, grouping, current?.projectId ?? null);
    const sortedGroups = sortSidebarProjects(groupSidebarProjects(availableProjects, grouping), settingValue("sidebarProjectSortOrder"));
    const orderByRepresentative = new Map(sortedGroups.map((group, index) => [group.id, index]));
    const orderOf = (entry: (typeof pickerEntries)[number]) => entry.members.reduce((order, member) => Math.min(order, orderByRepresentative.get(member.id) ?? Infinity), Infinity);
    projects = pickerEntries.slice().sort((a, b) => {
      if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
      return orderOf(a) - orderOf(b);
    }).map((entry) => ({ ...entry.target, name: entry.name, pinned: entry.members.some((member) => member.pinned) }));
  }
  return buildPaletteGroups({
    mode: mode(),
    query,
    projects: projects.map((project) => ({
      id: project.id, name: project.name, path: project.path, pinned: project.pinned, updatedAt: project.updatedAt,
    })),
    threads: allThreads().map((thread) => ({ ...thread, statusPill: resolveThreadStatusPill(thread) })),
    currentThreadId: current?.id ?? null,
    currentProjectId: current?.projectId || null,
    connected: backendStatus() === "connected",
    canPin: projectOrganizationSupported(),
    appearance,
    themes: THEME_CARDS,
    currentThemeId: themeForMode(appearance === "light" ? "light" : "dark"),
    workspace: workspaceTarget(),
    shortcuts: resolvedShortcutLabels(),
    thread: threadFacts(current),
    linkedThreads: linkedThreadSearch(),
    canTriage: backendStatus() === "connected" && serverEnvironment()?.capabilities !== undefined && (serverEnvironment()?.capabilities as Record<string, unknown>).triage === true,
    canCreateProject: newProjectsRoot() !== null,
    serverConfigLoaded: serverEnvironment() !== null,
    files: mode() === "files" ? paletteSearch.files() : [],
    contentMatches: mode() === "content" ? paletteSearch.content() : [],
    messageMatches: mode() === "root" ? paletteSearch.messages() : [],
    settings: mode() === "root" && query.trim() ? settingsCache ?? [] : [],
    now: Date.now(),
  });
});

export const paletteItems = computed<PaletteItem[]>(() => flattenGroups(paletteGroups()));

export function runPaletteItem(item: PaletteItem) {
  const action = item.action;
  switch (action.kind) {
    case "new-thread":
      createThread(action.projectId);
      return;
    case "submenu":
      if (action.mode === "files" || action.mode === "content") parentSearch = { query: paletteQuery(), linked: linkedThreadSearch() };
      pushMode(action.mode === "add-project" ? addProjectEntryMode() : action.mode);
      return;
    case "add-project":
      pushMode(addProjectEntryMode());
      return;
    case "add-environment":
      setAddProjectEnvironment(action.id);
      pushMode("add-project");
      return;
    case "add-source":
      startSource(action.source);
      return;
    case "setup-required":
      return;
    case "browse-up":
      void browseUp();
      return;
    case "browse-into":
      void browseTo(action.name);
      return;
    case "toggle-publish":
      toggleNewProjectPublishes();
      return;
    case "existing-project":
      showExistingProjectSources();
      return;
    case "settings":
      openSettings(action.path);
      closePalette();
      return;
    case "usage":
      openUsage();
      closePalette();
      return;
    case "pull-requests":
      openUtility("pull-requests");
      closePalette();
      return;
    case "issues":
      openUtility("issues");
      closePalette();
      return;
    case "open-thread":
      openThreadById(action.id);
      if (action.find) openThreadFindOnQuery(action.id, findForMessageMatch(action.find, action.find.query));
      closePalette();
      return;
    case "open-project": {
      const project = allProjects().find((candidate) => candidate.id === action.id);
      if (project) {
        const latest = [...project.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (latest) openThreadById(latest.id);
        else createThread(project.id);
      }
      closePalette();
      return;
    }
    case "pin-project":
      void setProjectPinned(action.id, action.pinned).catch((error: unknown) => errorToast("Unable to run command", error instanceof Error ? error.message : "An unexpected error occurred."));
      closePalette();
      return;
    case "open-file":
      openFileAtLine(action.path, action.line);
      closePalette();
      return;
    case "command":
      closePalette();
      runCommand(action.id);
      return;
    case "copy":
      closePalette();
      void copyToClipboard(action.text, action.notice, action.description, action.failureTitle);
      return;
    case "restart-session":
      closePalette();
      void restartAgentSession(action.threadId);
      return;
    case "triage":
      closePalette();
      void startTriage();
      return;
    case "link-pull-request":
      closePalette();
      openLinkPullRequestDialog(action.threadId);
      return;
    case "show-pull-requests":
      openUtility("pull-requests");
      closePalette();
      return;
    case "theme-editor":
      closePalette();
      toggleThemeEditor();
      return;
    case "share-guest":
      closePalette();
      openGuestShareDialog(action.threadId);
      return;
    case "mcp":
      closePalette();
      openUseInAnotherApp();
      return;
    case "create-project":
      void submitNewProject();
      return;
    case "theme":
      for (const themeMode of action.modes) chooseTheme(themeMode, action.id);
      closePalette();
      return;
    case "appearance":
      setColorScheme(action.value);
      updateSetting("colorScheme", action.value);
      closePalette();
      return;
  }
}

/** Opens the file in the right panel files surface at the matching line, as the web's content search does. */
export function openFileAtLine(path: string, line?: number) {
  (openFileAction as (relativePath: string, line?: number) => void)(path, line);
}

async function copyToClipboard(text: string, notice: string, description?: string, failureTitle = "Could not copy") {
  try {
    await Clipboard.writeText(text);
    showToast({ type: "success", title: notice, ...(description ? { description } : {}) });
  } catch (error) {
    errorToast(failureTitle, error instanceof Error ? error.message : "An error occurred.");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Restart agent session: detaches the thread's provider sessions, then refreshes its provider fresh. */
export async function restartAgentSession(threadId: string): Promise<void> {
  try {
    const projection = record(await requestBackend("orchestration.getThreadProjection", { threadId }));
    const sessions = Array.isArray(projection?.providerSessions) ? projection.providerSessions : [];
    for (const session of sessions) {
      const id = record(session)?.id;
      if (typeof id !== "string") continue;
      await requestBackend("orchestration.dispatchCommand", {
        type: "provider-session.detach", commandId: `cmd:${crypto.randomUUID()}`, threadId, providerSessionId: id, reason: "client-requested",
      });
    }
    showToast({ type: "success", title: "Agent session will restart", description: "Your next message starts a fresh session." });
    await refreshProviderStatuses({ fresh: true });
  } catch (error) {
    // CommandPalette's run().catch: any command that throws raises this toast.
    errorToast("Unable to run command", error instanceof Error && error.message ? error.message : "An unexpected error occurred.");
  }
}

export const TRIAGE_CLI_COMMAND = "npx t3 triage";

/** Triage an issue: the server writes the playbook, then a No project draft opens with it linked (useStartTriage). */
export async function startTriage(): Promise<void> {
  const fail = (description: string) => showToast({
    type: "error",
    title: "Could not start triage",
    description: `${description} Run ${TRIAGE_CLI_COMMAND} in a terminal on that machine instead.`,
    timeoutMs: 0,
    hideCopyButton: true,
    actions: [{ label: "Copy command", run: () => { void Clipboard.writeText(TRIAGE_CLI_COMMAND).catch(() => undefined); } }],
  });
  // The palette is already closed, so say something when the draft does not open at once.
  let pendingToast: string | undefined;
  const pendingTimer = setTimeout(() => { pendingToast = showToast({ type: "loading", title: "Starting triage…", timeoutMs: 0 }); }, 400);
  try {
    // useStartTriage: the draft is a No project one, so a server without a scratch workspace cannot open it.
    if (factsFromConfig(await requestBackend("server.getConfig", {})).scratchRoot === null) throw new Error("This machine cannot start threads without a project.");
    const prepared = record(await requestBackend("server.prepareTriage", { client: { label: "T3 Code", deviceType: "desktop", os: "macOS" } }));
    const prompt = typeof prepared?.prompt === "string" ? prepared.prompt : null;
    if (prompt === null) throw new Error("The environment returned no triage prompt.");
    // useStartTriage: the draft opens in the Scratch project (openScratch), so the draft hero knows it for a triage one
    // (isTriagePrompt: its prompt links the playbook); the user going to another thread while this waited keeps it closed.
    const requestingThread = openThread()?.id;
    const projectId = await openScratchProject();
    if (openThread()?.id !== requestingThread) return;
    try {
      createThread(projectId, { prompt });
    } catch {
      throw new Error("T3 Code could not open a new thread.");
    }
  } catch (error) {
    fail(error instanceof Error && error.message ? error.message : "An error occurred.");
  } finally {
    clearTimeout(pendingTimer);
    if (pendingToast !== undefined) closeToast(pendingToast);
  }
}

/** Toggle theme editor: the Appearance page with the editor open on a copy of the current theme (the themeEditor.toggle command does the same). */
export function toggleThemeEditor() {
  const mode = appearanceMode();
  const appearance = mode === "light" ? "light" : "dark";
  const seed = cardById(themeForMode(appearance));
  const theme = themeFromCard(seed, appearance, allThemeIds());
  openSettings("/settings/appearance");
  openThemeEditor({ ...theme, ...copyIdentity("My theme", allThemeIds()), label: "My theme" }, true);
}

export { paletteOpen };

// ---- Add project: the views after Sources ----

/** Sources -> the step of the chosen source. */
function startSource(source: string) {
  if (source === "new") pushMode("new-project");
  else if (source === "local") pushMode("add-project-browse", addProjectInitialQuery());
  else {
    pushMode("clone");
    setCloneFlow({ step: "repository", source });
  }
}

/** "Add existing project": back to Sources, whether New project was entered from there or from the root list. */
function showExistingProjectSources() {
  if (stack().at(-2) === "add-project") {
    goBack();
    return;
  }
  goBack();
  pushMode("add-project");
}

export function pinnedCloneName(): string {
  const flow = cloneFlow();
  return flow?.step === "confirm" ? getCloneDirectoryLeafName(flow.remoteUrl, ghqCloneLayout(), flow.repository?.nameWithOwner ?? flow.remoteUrl) : "";
}

// The folder the path names is listed by the server (filesystem.browse) whenever the field moves into another directory.
effect(() => {
  if (!paletteOpen()) return;
  const view = browseView();
  if (!view.isBrowsing || view.directoryPath.length === 0 || view.relativeNeedsProject) return;
  untracked(() => loadBrowse(view.directoryPath, browseCwd()));
});

function newProjectView(): NewProjectView {
  const name = paletteQuery().trim();
  const targets = getNewProjectPublishTargets(discoveredProviders());
  const target = getNewProjectPublishTarget(targets, newProjectPublishKind());
  const root = newProjectsRoot();
  const pathPreview = root === null ? null : getNewProjectPathPreview(root, name);
  return {
    name, pathPreview, targets, target, publishes: newProjectPublishes(), creating: isCreatingProject(),
    repositoryName: target && pathPreview ? getNewProjectRepository(target, pathPreview) : null,
  };
}

export async function submitNewProject(): Promise<void> {
  const view = newProjectView();
  if (view.name.length === 0 || view.creating || !addProjectConnected()) return;
  await createProjectFromName(view.name, view.publishes ? view.target : null);
}

const addContext = () => ({ platform: environmentPlatform(), currentProjectCwd: browseCwd() });

/** The folder step's submit: add the project at the path, or clone into it. */
export async function submitBrowsePath(): Promise<void> {
  const view = browseView();
  const path = resolvedBrowsePath(paletteQuery(), view);
  const flow = cloneFlow();
  if (flow?.step === "confirm") await submitCloneDestination(flow, path, addContext());
  else await addProjectFromPath(path, addContext());
}

/** The repository step's submit: a Git URL moves on to the destination, a host's owner/repo is looked up first. */
export async function submitRepositoryStep(): Promise<void> {
  const flow = cloneFlow();
  if (flow?.step !== "repository") return;
  const destination = await submitCloneRepository(flow, paletteQuery());
  if (destination === null) return;
  paletteHighlight.set(null);
  setPaletteQuery(destination);
}

export async function browseTo(name: string): Promise<void> {
  const view = browseView();
  const pinned = pinnedCloneName();
  const query = paletteQuery();
  const next = pinned
    ? getCloneDestinationBrowsePath({ browseDirectoryPath: view.directoryPath, selectedDirectoryName: name, cloneDirectoryName: pinned, caseSensitive: !isWindowsPlatform(environmentPlatform()) })
    : appendBrowsePathSegment(query, name);
  paletteHighlight.set(null);
  setPaletteQuery(next);
}

export async function browseUp(): Promise<void> {
  const view = browseView();
  if (view.parentPath === null) return;
  paletteHighlight.set(null);
  setPaletteQuery(getCloneDestinationPath(view.parentPath, pinnedCloneName()));
}

/** Tab in a folder browser: a single match enters it, several extend to their common prefix. */
export function completeBrowsePath(highlighted: PaletteItem | null) {
  const view = browseView();
  if (!view.isBrowsing || view.relativeNeedsProject) return;
  if (highlighted?.value === "browse:up") { void browseUp(); return; }
  const entry = highlighted ? view.visibleEntries.find((candidate) => `browse:${candidate.fullPath}` === highlighted.value) : undefined;
  const completion = entry ? { name: entry.name, isComplete: true } : getBrowseTabCompletion(view.visibleEntries, view.filterQuery);
  if (completion?.isComplete) void browseTo(completion.name);
  else if (completion && !pinnedCloneName()) {
    paletteHighlight.set(null);
    setPaletteQuery(`${getBrowseDirectoryPath(paletteQuery())}${completion.name}`);
  }
}

/** Typing in the field. Clearing a path browser (which starts with text) leaves it, as popView does for a view with an initial query. */
export function onPaletteQueryChange(next: string) {
  paletteHighlight.set(null);
  if (next === "" && mode() === "add-project-browse") {
    goBack();
    return;
  }
  setPaletteQuery(next);
}

// ---- What the card shows around the rows, by view ----

export interface PaletteAccessory { label: string; shortcut: string; disabled: boolean; submit: () => void }
export type PaletteHeader =
  | { kind: "new-project"; name: string; pathPreview: string; projectsRoot: string | null; environmentLabel: string | null }
  | { kind: "repository"; source: string; title: string; description: string };

const isCloneConfirm = (): boolean => mode() === "clone" && cloneFlow()?.step === "confirm";
const isCloneRepository = (): boolean => mode() === "clone" && cloneFlow()?.step === "repository";
const isFolderBrowser = (): boolean => mode() === "add-project-browse" || isCloneConfirm() || (browseEligible() && browseView().isBrowsing);

/** Whether the highlighted row is a folder of the browser (Enter then enters it instead of submitting the path). */
function browseRowHighlighted(): boolean {
  const index = paletteHighlight();
  return index !== null && (paletteItems()[index]?.value.startsWith("browse:") ?? false);
}

function canSubmitBrowsePath(): boolean {
  const view = browseView();
  return view.isBrowsing && !view.relativeNeedsProject && addProjectConnected();
}

/** Enter in the field: submit the step the field belongs to, or run the highlighted row. */
export function runPaletteEnter(highlighted: PaletteItem | null) {
  if (isCloneRepository()) { void submitRepositoryStep(); return; }
  if (mode() === "new-project" && highlighted === null) { void submitNewProject(); return; }
  if (isFolderBrowser() && !(highlighted?.value.startsWith("browse:") ?? false) && canSubmitBrowsePath()) { void submitBrowsePath(); return; }
  if (highlighted && !highlighted.disabled) runPaletteItem(highlighted);
}

/** Cmd+Enter submits the path even with a folder highlighted. */
export function runPaletteModEnter() {
  if (mode() === "new-project") void submitNewProject();
  else if (isFolderBrowser() && canSubmitBrowsePath()) void submitBrowsePath();
}

export const paletteAccessory = computed<PaletteAccessory | null>(() => {
  const view = mode();
  const mod = "\u2318 Enter";
  if (view === "new-project") {
    const name = paletteQuery().trim();
    return {
      label: isCreatingProject() ? "Creating" : "Create", shortcut: paletteHighlight() !== null ? mod : "Enter",
      disabled: name.length === 0 || isCreatingProject() || !addProjectConnected(), submit: () => void submitNewProject(),
    };
  }
  if (isCloneRepository()) {
    const flow = cloneFlow();
    const label = flow?.source === URL_SOURCE ? "Continue" : "Lookup";
    return {
      label: isLookingUp() ? "Working" : label, shortcut: "Enter",
      disabled: paletteQuery().trim().length === 0 || !addProjectConnected() || isLookingUp(), submit: () => void submitRepositoryStep(),
    };
  }
  if (isFolderBrowser()) {
    const confirm = isCloneConfirm();
    const query = paletteQuery();
    const willCreate = willCreatePath(query, browseView(), browseRowHighlighted(), canSubmitBrowsePath());
    const label = confirm ? (willCreate ? "Create & Clone" : "Clone") : (willCreate ? "Create & Add" : "Add");
    return {
      label: confirm && isCloning() ? "Cloning" : label, shortcut: browseRowHighlighted() ? mod : "Enter",
      disabled: !addProjectConnected() || browseView().relativeNeedsProject || (confirm && isCloning()), submit: () => void submitBrowsePath(),
    };
  }
  return null;
});

/** The label after Enter in the footer; undefined hides it (the field's own submit button shows the key). */
export const paletteFooterAction = computed<string | undefined>(() => {
  const view = mode();
  if (view === "new-project") {
    const index = paletteHighlight();
    if (index === null) return "Create";
    return paletteItems()[index]?.value === "new-project:publish" ? "Toggle" : "Select";
  }
  if (isCloneRepository()) return cloneFlow()?.source === URL_SOURCE ? "Continue" : "Lookup";
  return !canSubmitBrowsePath() || browseRowHighlighted() ? "Select" : undefined;
});

export const paletteHeader = computed<PaletteHeader | null>(() => {
  if (mode() === "new-project") {
    const root = newProjectsRoot();
    if (root === null) return null;
    const name = paletteQuery().trim();
    return { kind: "new-project", name, pathPreview: getNewProjectPathPreview(root, name), projectsRoot: root, environmentLabel: addProjectEnvironmentLabel() };
  }
  const flow = cloneFlow();
  if (mode() === "clone" && flow?.step === "confirm") {
    return { kind: "repository", source: flow.source, title: flow.repository?.nameWithOwner ?? flow.repositoryInput, description: flow.repository?.url ?? flow.remoteUrl };
  }
  return null;
});

/** The field's placeholder for the view and step. */
export function paletteInputPlaceholder(): string | null {
  const flow = cloneFlow();
  if (mode() === "clone" && flow?.step === "repository") return remoteInputPlaceholder(flow.source);
  if (isCloneConfirm()) return "Enter path (e.g. ~/projects/my-app)";
  return null;
}

/** The message the empty list shows for the step, or null for the view's own. */
export function paletteStepEmptyMessage(): string | null {
  const flow = cloneFlow();
  if (mode() === "clone" && flow?.step === "repository") {
    return flow.source === URL_SOURCE ? "Enter a Git clone URL and press Enter to continue." : "Enter a repository path and press Enter to look it up.";
  }
  if (isCloneConfirm()) return "Choose a destination path and press Enter to clone.";
  if (isFolderBrowser()) {
    const view = browseView();
    if (view.relativeNeedsProject) return "Relative paths require an active project.";
    if (willCreatePath(paletteQuery(), view, browseRowHighlighted(), canSubmitBrowsePath())) return "Press Enter to create this folder and add it as a project.";
  }
  return null;
}

/** Folder rows are not highlighted until an arrow key reaches them; Sources and the root list start on the first row. */
export function paletteAutoHighlights(): boolean {
  return !isFolderBrowser() && mode() !== "new-project" && !isCloneRepository();
}

export type { CloneFlow };

/** Whether the field is a folder path (Local folder, or the destination of a clone). */
export const paletteBrowsing = (): boolean => isFolderBrowser();

/** The host picker of the New project options row: with several ready hosts, each press moves to the next. */
export function cyclePublishHost() {
  const targets = getNewProjectPublishTargets(discoveredProviders());
  const current = getNewProjectPublishTarget(targets, newProjectPublishKind());
  if (!current || targets.length < 2) return;
  setNewProjectPublishKind(targets[(targets.indexOf(current) + 1) % targets.length]!.host.kind);
}

// ---- Open in Finder: the native folder picker of the footer ----

/** getLocalFileManagerName: what the footer calls the system's file manager. */
export function fileManagerName(): string {
  return platform.os === "macos" ? "Finder" : platform.os === "windows" ? "File Explorer" : "Files";
}

const pickingFolder = signal(false);
export const isPickingProjectFolder = () => pickingFolder();

/**
 * canOpenProjectFromFileManager: a folder step of the live environment, with an embedding app that can show the system's folder
 * dialog. NSH has no picker of its own for folders, so it is the host's `dialogs.pickFolder` (granted in nsh.json `capabilities.host`).
 */
export function canOpenProjectFromFileManager(): boolean {
  return isFolderBrowser() && addProjectEnvironmentId() === null && (host.available() || canPickFolder());
}

/** The folder the dialog opens in: the one the field names, else none. */
export function fileManagerInitialPath(): string | undefined {
  const query = paletteQuery();
  const trimmed = query.trim();
  if (trimmed.length === 0) return undefined;
  const view = browseView();
  const initial = hasTrailingPathSeparator(query) ? (view.result?.parentPath ?? trimmed) : (view.directoryPath || trimmed);
  const resolved = resolveProjectPathForDispatch(initial, browseCwd());
  return resolved.length > 0 ? resolved : undefined;
}

/** handleOpenProjectFromFileManager: the system's folder dialog, then the picked folder is added as a project. */
export async function openProjectFromFileManager(): Promise<void> {
  if (!canOpenProjectFromFileManager() || pickingFolder()) return;
  pickingFolder.set(true);
  let picked: unknown = null;
  try {
    const initialPath = fileManagerInitialPath();
    picked = host.available() ? await host.call("dialogs.pickFolder", initialPath ? { initialPath } : {}, { timeout: 0 }) : await pickFolder(initialPath ? { initialPath } : {});
  } catch (error) {
    errorToast(`Could not open ${fileManagerName()}`, error instanceof Error && error.message ? error.message : "The folder dialog is not available.");
    return;
  } finally {
    pickingFolder.set(false);
  }
  if (typeof picked !== "string" || picked.length === 0) return;
  await addProjectFromPath(picked, addContext());
}
