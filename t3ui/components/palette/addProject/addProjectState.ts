// Signals and server calls of the Add project flow. Rules live in addProjectLogic.ts; this file owns the
// state a flow keeps while the palette is open and the real RPCs behind it (packages/contracts):
// server.getConfig, server.discoverSourceControl, filesystem.browse, projects.mutate (project.create),
// projects.createNew, sourceControl.lookupRepository / publishRepository, projectClone.start / cancel / retry
// and the subscribeProjectClones stream.
import { signal } from "nsh";
import type { BannerItem } from "../../banners/bannerTypes";
import { projectFileCopies } from "../../../environments/addProjectToMachine";
import { parseDiscovery } from "../../../pages/settings/SourceControlDiscovery";
import { serverSettings } from "../../../pages/settings/settingsState";
import { environmentStatuses } from "../../../pages/settings/environments/savedEnvironments";
import { requestUsageEnvironment } from "../../usage/usageEnvironments";
import {
  allProjects, backendConnectionGeneration, backendStatus, backendUrl, closePalette, createThread, forgetProjectDrafts, isLocalDraft, isProjectArchived, openThread, openThreadById, requestBackend, subscribeBackend,
} from "../../../store";
import { parseFolderListing } from "../../SidebarFolderBrowserLogic";
import {
  browsePlatform, type BrowseEntry, type DiscoveredProvider, errorMessage, findProjectByPath, getDefaultCloneUrl, getNewProjectRepository,
  inferProjectTitleFromPath, isExplicitRelativeProjectPath, isUnsupportedWindowsProjectPath, normalizePastedCloneUrl,
  getCloneDestinationPath, getCloneDirectoryPath, getAddProjectInitialQuery, githubIncompleteOwnerRepositoryMessage, resolveProjectPathForDispatch,
  sourceProvider, type PublishTarget, type RemoteSource, type RepositoryInfo, URL_SOURCE,
} from "./addProjectLogic";
import { addToast, closeToast, errorToast, updateToast } from "../../toast/toastState";
import { suggestAppAccessForRemote } from "./appAccess";
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../../backend/sessionScopes";

// ---- Backend seam (tests answer the RPCs without a server) ----

interface Backend {
  connected: () => boolean;
  request: (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
  subscribe: typeof subscribeBackend;
}

// Which environment the flow works on: null is the live connection; a saved environment's id sends every call through
// a session of its own (the Usage page's requestUsageEnvironment), the way the web's environment chooser scopes the flow.
const environmentId = signal<string | null>(null);
export const addProjectEnvironmentId = () => environmentId();
/** A project added to another environment does not appear in this client's sidebar, so nothing opens afterwards. */
export const addsToOtherEnvironment = () => environmentId() !== null;

export function setAddProjectEnvironment(id: string | null) {
  if (environmentId() === id) return;
  environmentId.set(id);
  loadedFactsKey = "";
  facts.set(NO_FACTS);
  discovered.set(null);
  resetBrowse();
}

function defaultBackend(): Backend {
  return {
    connected: () => {
      const id = environmentId();
      return id === null ? backendStatus() === "connected" : environmentStatuses()[id]?.phase === "connected";
    },
    request: (method, payload, options) => {
      const id = environmentId();
      return id === null ? requestBackend(method, payload, options) : requestUsageEnvironment(id, method, payload, options);
    },
    subscribe: subscribeBackend,
  };
}

let backend: Backend = defaultBackend();

/** Replaces the connection the flow talks to; `null` restores the app's own. */
export function setAddProjectBackend(next: Partial<Backend> | null) {
  backend = next === null ? defaultBackend() : { ...backend, ...next };
  loadedFactsKey = "";
}

export const addProjectConnected = () => backend.connected();

// ---- Server facts: newProjectsRoot, platform, clone layout ----

interface Facts { newProjectsRoot: string | null; os: string | null; addProjectBaseDirectory: string; ghqCloneLayout: boolean }
const NO_FACTS: Facts = { newProjectsRoot: null, os: null, addProjectBaseDirectory: "", ghqCloneLayout: false };
const facts = signal<Facts>(NO_FACTS);
let loadedFactsKey = "";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function factsFromConfig(config: unknown): Facts {
  const root = record(config);
  const settings = record(root?.settings);
  const platform = record(record(root?.environment)?.platform);
  return {
    newProjectsRoot: typeof root?.newProjectsRoot === "string" && root.newProjectsRoot.length > 0 ? root.newProjectsRoot : null,
    os: typeof platform?.os === "string" ? platform.os : null,
    addProjectBaseDirectory: typeof settings?.addProjectBaseDirectory === "string" ? settings.addProjectBaseDirectory : "",
    ghqCloneLayout: settings?.ghqCloneLayout === true,
  };
}

/** Reads server.getConfig once per connection. */
export function loadAddProjectFacts() {
  if (!backend.connected()) return;
  const key = `${backendUrl()}|${backendConnectionGeneration()}|${environmentId() ?? ""}`;
  if (key === loadedFactsKey) return;
  loadedFactsKey = key;
  void backend.request("server.getConfig", {}).then((config) => {
    if (loadedFactsKey === key) facts.set(factsFromConfig(config));
  }).catch(() => {
    if (loadedFactsKey === key) loadedFactsKey = "";
  });
}

/** The projects root a new project goes into; null when the server offers none (the New project source is then absent). */
export const newProjectsRoot = (): string | null => (backend.connected() ? facts().newProjectsRoot : null);
export const environmentPlatform = (): string => browsePlatform(facts().os);
export const ghqCloneLayout = (): boolean => serverSettings()?.ghqCloneLayout === true || facts().ghqCloneLayout;
export function addProjectInitialQuery(): string {
  const settings = serverSettings();
  const base = typeof settings?.addProjectBaseDirectory === "string" ? settings.addProjectBaseDirectory : facts().addProjectBaseDirectory;
  return getAddProjectInitialQuery(base);
}

// ---- Source control discovery ("Setup Required") ----

const discovered = signal<DiscoveredProvider[] | null>(null);
export const discoveredProviders = () => discovered();
let discoverySerial = 0;
let discoveryInFlight = false;

export function loadDiscovery() {
  if (!backend.connected() || discoveryInFlight) return;
  discoveryInFlight = true;
  const mine = ++discoverySerial;
  void backend.request("server.discoverSourceControl", {}).then((value) => {
    if (mine !== discoverySerial) return;
    discovered.set(parseDiscovery(value).sourceControlProviders.map((item): DiscoveredProvider => ({
      kind: item.kind, label: item.label, status: item.status, installHint: item.installHint, auth: item.auth,
    })));
  }).catch(() => {
    if (mine === discoverySerial) discovered.set(null);
  }).finally(() => {
    discoveryInFlight = false;
  });
}

// ---- Folder browsing (filesystem.browse) ----

export interface Listing { partialPath: string; cwd: string | null; parentPath: string; entries: BrowseEntry[] }
const listing = signal<Listing | null>(null);
const pending = signal(false);
let browseSerial = 0;
export const browseListing = () => listing();
export const browsePending = () => pending();

/** The project whose folder relative browse paths resolve against. */
export function browseCwd(): string | null {
  return openThread() ? (allProjects().find((project) => project.id === openThread()?.projectId)?.path ?? null) : null;
}

export function loadBrowse(partialPath: string, cwd: string | null) {
  const current = listing();
  if (current && current.partialPath === partialPath && current.cwd === cwd) return;
  const mine = ++browseSerial;
  pending.set(true);
  void backend.request("filesystem.browse", cwd ? { partialPath, cwd } : { partialPath }).then((value) => {
    if (mine !== browseSerial) return;
    const result = parseFolderListing(value);
    listing.set({ partialPath, cwd, parentPath: result.parentPath, entries: result.entries });
    pending.set(false);
  }).catch(() => {
    if (mine !== browseSerial) return;
    listing.set(null);
    pending.set(false);
  });
}

export function resetBrowse() {
  browseSerial += 1;
  listing.set(null);
  pending.set(false);
}

// ---- Flow state ----

export type CloneFlow =
  | { step: "repository"; source: RemoteSource }
  | { step: "confirm"; source: RemoteSource; repositoryInput: string; repository: RepositoryInfo | null; remoteUrl: string };

const clone = signal<CloneFlow | null>(null);
export const cloneFlow = () => clone();
export const setCloneFlow = (flow: CloneFlow | null) => clone.set(flow);

const lookingUp = signal(false);
const cloning = signal(false);
const creating = signal(false);
export const isLookingUp = () => lookingUp();
export const isCloning = () => cloning();
export const isCreatingProject = () => creating();

const publishes = signal(false);
const publishKind = signal<string | null>(null);
export const newProjectPublishes = () => publishes();
export const toggleNewProjectPublishes = () => publishes.update((on) => !on);
export const newProjectPublishKind = () => publishKind();
export const setNewProjectPublishKind = (kind: string | null) => publishKind.set(kind);

export function resetAddProjectFlow() {
  resetBrowse();
  clone.set(null);
  lookingUp.set(false);
  cloning.set(false);
  creating.set(false);
  publishes.set(false);
  publishKind.set(null);
  cloneLookupSerial += 1;
}

// ---- Toasts and project lookups ----

function waitForProject(projectId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (allProjects().some((project) => project.id === projectId)) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

function openProjectThread(projectId: string) {
  createThread(projectId);
}

const newId = () => crypto.randomUUID();
const commandId = () => `command:${crypto.randomUUID()}`;

// ---- Local folder: Add ----

export interface AddProjectContext { platform: string; currentProjectCwd: string | null }

/** handleAddProjectForEnvironment: validates the path, opens an existing project or creates one, then opens a thread in it. */
export async function addProjectFromPath(rawCwd: string, context: AddProjectContext): Promise<boolean> {
  const otherEnvironment = addsToOtherEnvironment();
  if (!backend.connected()) {
    errorToast("Environment unavailable", "The selected environment is not connected.");
    return false;
  }
  if (isUnsupportedWindowsProjectPath(rawCwd.trim(), context.platform)) {
    errorToast("Failed to add project", "Windows-style paths are only supported on Windows.");
    return false;
  }
  if (isExplicitRelativeProjectPath(rawCwd.trim()) && !context.currentProjectCwd) {
    errorToast("Failed to add project", "Relative paths require an active project.");
    return false;
  }
  const cwd = resolveProjectPathForDispatch(rawCwd, context.currentProjectCwd);
  if (cwd.length === 0) return false;

  // The projects this client lists belong to the live environment: another one's are not known here.
  const existing = otherEnvironment ? undefined : findProjectByPath(allProjects(), cwd);
  if (existing) {
    // Adding an archived project's folder again brings the project back.
    if (isProjectArchived(existing.id)) {
      void backend.request("projects.mutate", { type: "project.update", commandId: commandId(), projectId: existing.id, archived: false })
        .catch((error: unknown) => errorToast("Failed to unarchive project", errorMessage(error)));
    }
    const latest = [...existing.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) {
      openThreadById(latest.id);
    } else {
      openProjectThread(existing.id);
    }
    closePalette();
    return true;
  }

  const projectId = newId();
  try {
    await backend.request("projects.mutate", {
      type: "project.create", commandId: commandId(), projectId, title: inferProjectTitleFromPath(cwd), workspaceRoot: cwd,
      createWorkspaceRootIfMissing: true, defaultModelSelection: null,
    });
  } catch (error) {
    errorToast("Failed to add project", errorMessage(error));
    return false;
  }
  if (otherEnvironment) {
    addToast({ type: "success", title: `Added ${inferProjectTitleFromPath(cwd)}`, description: cwd });
    closePalette();
    return true;
  }
  await waitForProject(projectId, 3000);
  openProjectThread(projectId);
  closePalette();
  return true;
}

// ---- New project ----

/** Creations in flight: projects.createNew queues behind the running one (projectScheduler serial per environment). */
let creatingCount = 0;

/** useNewProject: projects.createNew, then the optional private repository, then a thread in the project. */
export async function createNewProject(name: string, publishTo: PublishTarget | null): Promise<boolean> {
  const otherEnvironment = addsToOtherEnvironment();
  creatingCount += 1;
  creating.set(true);
  try {
    let created: Record<string, unknown> | null;
    try {
      created = record(await backend.request("projects.createNew", { name }, { timeoutMs: 60000 }));
    } catch (error) {
      errorToast("Could not create the project", errorMessage(error));
      return false;
    }
    const projectId = typeof created?.projectId === "string" ? created.projectId : "";
    const workspaceRoot = typeof created?.workspaceRoot === "string" ? created.workspaceRoot : "";
    const commitError = typeof created?.commitError === "string" ? created.commitError : undefined;
    if (commitError === undefined) addToast({ type: "success", title: `Created ${name}`, description: workspaceRoot });
    else addToast({ type: "warning", title: `Created ${name} without a first commit`, description: `${commitError} The project is in ${workspaceRoot}.` });
    if (publishTo) void publishNewRepository(workspaceRoot, publishTo);
    closePalette();
    if (projectId && !otherEnvironment) {
      const arrived = await waitForProject(projectId, 10000);
      if (arrived) openProjectThread(projectId);
      else errorToast("Failed to open project", "It will appear in the sidebar once this client catches up.");
    }
    return true;
  } finally {
    creatingCount -= 1;
    if (creatingCount === 0) creating.set(false);
  }
}

async function publishNewRepository(workspaceRoot: string, target: PublishTarget) {
  const label = target.host.label;
  try {
    const result = record(await backend.request("sourceControl.publishRepository", {
      cwd: workspaceRoot, provider: target.host.kind, repository: getNewProjectRepository(target, workspaceRoot), visibility: "private",
    }, { timeoutMs: 120000 }));
    const repository = record(result?.repository);
    addToast({ type: "success", title: `Published to ${label}`, ...(typeof repository?.nameWithOwner === "string" ? { description: repository.nameWithOwner } : {}) });
    if (typeof result?.remoteUrl === "string") void suggestAppAccessForRemote(backend.request, result.remoteUrl);
  } catch (error) {
    errorToast(`Could not create the ${label} repository`, `${errorMessage(error)} Use Publish Repository in the Git menu to try again.`);
  }
}

// ---- Clone ----

let cloneLookupSerial = 0;

function parseRepository(value: unknown): RepositoryInfo | null {
  const repository = record(value);
  if (!repository) return null;
  const { provider, nameWithOwner, url, sshUrl } = repository;
  if (typeof provider !== "string" || typeof nameWithOwner !== "string" || typeof url !== "string" || typeof sshUrl !== "string") return null;
  return { provider, nameWithOwner, url, sshUrl };
}

function defaultCloneDestination(remoteUrl: string, repository: string): string {
  return getCloneDestinationPath(addProjectInitialQuery(), getCloneDirectoryPath(remoteUrl, ghqCloneLayout(), repository));
}

/**
 * The repository step: a Git URL goes straight to the destination; a host's owner/repo is looked up first
 * (sourceControl.lookupRepository). Returns the destination to show in the field, or null when the step stays.
 */
export async function submitCloneRepository(flow: Extract<CloneFlow, { step: "repository" }>, rawInput: string): Promise<string | null> {
  const rawRepository = rawInput.trim();
  if (rawRepository.length === 0 || lookingUp()) return null;
  if (!backend.connected()) {
    errorToast("Environment unavailable", "The selected environment is not connected.");
    return null;
  }
  const incomplete = githubIncompleteOwnerRepositoryMessage(flow.source, rawRepository);
  if (incomplete) {
    errorToast("Repository name incomplete", incomplete);
    return null;
  }
  const provider = sourceProvider(flow.source);
  if (!provider) {
    const remoteUrl = normalizePastedCloneUrl(rawRepository);
    clone.set({ step: "confirm", source: flow.source, repositoryInput: rawRepository, repository: null, remoteUrl });
    return defaultCloneDestination(remoteUrl, rawRepository);
  }
  lookingUp.set(true);
  const mine = ++cloneLookupSerial;
  try {
    const repository = parseRepository(await backend.request("sourceControl.lookupRepository", { provider, repository: rawRepository }, { timeoutMs: 60000 }));
    if (mine !== cloneLookupSerial) return null;
    if (!repository) {
      errorToast("Repository lookup failed", "The environment returned an invalid repository.");
      return null;
    }
    const remoteUrl = getDefaultCloneUrl(repository);
    clone.set({ step: "confirm", source: flow.source, repositoryInput: rawRepository, repository, remoteUrl });
    return defaultCloneDestination(remoteUrl, repository.nameWithOwner);
  } catch (error) {
    if (mine === cloneLookupSerial) errorToast("Repository lookup failed", errorMessage(error));
    return null;
  } finally {
    if (mine === cloneLookupSerial) lookingUp.set(false);
  }
}

/** The destination step: projectClone.start, then open the project once it arrives while progress toasts follow the stream. */
export async function submitCloneDestination(flow: Extract<CloneFlow, { step: "confirm" }>, rawDestination: string, context: AddProjectContext): Promise<boolean> {
  if (!backend.connected()) {
    errorToast("Environment unavailable", "The selected environment is not connected.");
    return false;
  }
  const otherEnvironment = addsToOtherEnvironment();
  const destination = rawDestination.trim();
  // CommandPalette's clone step: the session needs both scopes (the live connection's; another environment's session is not read here).
  if (!otherEnvironment && (!scopeAllows("source-control:write") || !scopeAllows(ORCHESTRATION_OPERATE_SCOPE))) {
    errorToast("Clone unavailable", "This connection needs permission to write source control and add projects.");
    return false;
  }
  if (destination.length === 0 || cloning()) return false;
  if (isUnsupportedWindowsProjectPath(destination, context.platform)) {
    errorToast("Clone failed", "Windows-style paths are only supported on Windows.");
    return false;
  }
  if (isExplicitRelativeProjectPath(destination) && !context.currentProjectCwd) {
    errorToast("Clone failed", "Relative paths require an active project.");
    return false;
  }
  const destinationPath = resolveProjectPathForDispatch(destination, context.currentProjectCwd);
  if (destinationPath.length === 0) return false;
  const projectId = newId();
  cloning.set(true);
  try {
    await backend.request("projectClone.start", {
      projectId, title: inferProjectTitleFromPath(destinationPath), createdAt: new Date().toISOString(), remoteUrl: flow.remoteUrl, destinationPath,
    }, { timeoutMs: 60000 });
  } catch (error) {
    errorToast("Clone failed", errorMessage(error));
    return false;
  } finally {
    cloning.set(false);
  }
  closePalette();
  void suggestAppAccessForRemote(backend.request, flow.remoteUrl);
  if (!otherEnvironment) void waitForProject(projectId, 3000).then(() => openProjectThread(projectId));
  return true;
}

export { URL_SOURCE };

// ---- Clone progress toasts (ProjectCloneToastCoordinator) ----

interface CloneSnapshot {
  projectId: string;
  destinationPath: string;
  repository: { nameWithOwner: string } | null;
  phase: string;
  stage: string;
  percent: number | null;
  detail: string | null;
  stalled: boolean;
  error: string | null;
}

const STAGE_LABEL: Record<string, string> = {
  connecting: "Connecting", counting: "Counting objects", receiving: "Receiving objects", resolving: "Resolving deltas", checkout: "Checking out files",
};

export function cloneDisplayName(snapshot: Pick<CloneSnapshot, "repository" | "destinationPath">): string {
  if (snapshot.repository) return snapshot.repository.nameWithOwner;
  const segments = snapshot.destinationPath.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? snapshot.destinationPath;
}

export function cloneProgressSummary(snapshot: Pick<CloneSnapshot, "stage" | "percent" | "detail" | "stalled">): string {
  const parts = [STAGE_LABEL[snapshot.stage] ?? snapshot.stage];
  if (snapshot.percent !== null) parts.push(`${snapshot.percent}%`);
  if (snapshot.stalled) parts.push("Stalled");
  else if (snapshot.detail) parts.push(snapshot.detail);
  return parts.join(" · ");
}

function parseSnapshots(value: unknown): CloneSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CloneSnapshot[] => {
    const item = record(raw);
    if (!item || typeof item.projectId !== "string" || typeof item.destinationPath !== "string" || typeof item.phase !== "string") return [];
    const repository = record(item.repository);
    return [{
      projectId: item.projectId,
      destinationPath: item.destinationPath,
      repository: typeof repository?.nameWithOwner === "string" ? { nameWithOwner: repository.nameWithOwner } : null,
      phase: item.phase,
      stage: typeof item.stage === "string" ? item.stage : "connecting",
      percent: typeof item.percent === "number" ? item.percent : null,
      detail: typeof item.detail === "string" ? item.detail : null,
      stalled: item.stalled === true,
      error: typeof item.error === "string" ? item.error : null,
    }];
  });
}

interface Tracked { toastId: string; key: string; phase: string }
const silencedCloneToasts = new Set<string>();
/** state/projectClones.ts silenceProjectCloneToasts: keeps a clone's progress out of toasts once its project is on screen. */
export function silenceProjectCloneToasts(projectId: string) { silencedCloneToasts.add(projectId); }
const tracked = new Map<string, Tracked>();

function renderKey(clone: CloneSnapshot): string {
  return `${clone.phase}:${clone.stage}:${clone.percent ?? ""}:${clone.detail ?? ""}:${clone.stalled}:${clone.error ?? ""}`;
}

async function cloneAction(method: string, projectId: string, title: string) {
  try {
    await backend.request(method, { projectId });
  } catch (error) {
    errorToast(title, errorMessage(error));
  }
}

async function removeClonedProject(projectId: string) {
  try {
    // Deletion stays unforced so a thread created since the failed clone cannot be silently deleted.
    await backend.request("projects.mutate", { type: "project.delete", commandId: commandId(), projectId });
    forgetProjectDrafts(projectId);
  } catch (error) {
    errorToast("Failed to remove project", errorMessage(error));
  }
}

/** Opens, updates and closes one toast per clone to match the stream's latest list. */
export function applyCloneSnapshots(value: unknown) {
  const clones = parseSnapshots(value);
  cloneSnapshots.set(clones);
  const seen = new Set<string>();
  for (const snapshot of clones) {
    seen.add(snapshot.projectId);
    const key = renderKey(snapshot);
    const existing = tracked.get(snapshot.projectId);
    const name = cloneDisplayName(snapshot);
    const close = () => {
      const current = tracked.get(snapshot.projectId);
      if (!current) return;
      closeToast(current.toastId);
      tracked.delete(snapshot.projectId);
    };
    // ProjectCloneToastCoordinator: once the project's own draft is on screen its composer banner shows the progress, so
    // the toast goes and stays away for running and done; a failure or cancel toasts again whenever it is not on screen.
    const viewing = openThread();
    if (viewing && viewing.projectId === snapshot.projectId && isLocalDraft(viewing.id)) {
      silenceProjectCloneToasts(snapshot.projectId);
      close();
      continue;
    }
    if (existing?.key === key) continue;
    if (silencedCloneToasts.has(snapshot.projectId) && (snapshot.phase === "running" || snapshot.phase === "done")) {
      close();
      continue;
    }
    let input: Parameters<typeof addToast>[0];
    if (snapshot.phase === "running") {
      input = {
        type: "loading", title: `Cloning ${name}`, description: cloneProgressSummary(snapshot), timeoutMs: 0,
        actions: [{ label: "Cancel", run: () => void cloneAction("projectClone.cancel", snapshot.projectId, "Failed to cancel clone") }],
      };
    } else if (snapshot.phase === "done") {
      input = {
        type: "success", title: `Cloned ${name}`, description: snapshot.destinationPath, timeoutMs: 8000,
        actions: [{ label: "Open project", run: () => { close(); openProjectThread(snapshot.projectId); } }],
      };
    } else {
      const cancelled = snapshot.phase === "cancelled";
      input = {
        type: cancelled ? "info" : "error", title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
        description: cancelled ? snapshot.destinationPath : (snapshot.error ?? "The clone failed."), timeoutMs: 0,
        // The web puts the secondary action (Remove project) before the primary one (Retry).
        actions: [
          { label: "Remove project", run: () => void removeClonedProject(snapshot.projectId) },
          { label: "Retry", run: () => void cloneAction("projectClone.retry", snapshot.projectId, "Failed to retry clone") },
        ],
      };
    }
    if (existing) {
      updateToast(existing.toastId, input);
      tracked.set(snapshot.projectId, { ...existing, key, phase: snapshot.phase });
    } else {
      tracked.set(snapshot.projectId, { toastId: addToast(input), key, phase: snapshot.phase });
    }
  }
  for (const [projectId, entry] of tracked) {
    if (seen.has(projectId)) continue;
    if (entry.phase !== "done") closeToast(entry.toastId);
    tracked.delete(projectId);
  }
}

// ---- The composer's clone banner and send block (useProjectCloneBanner) ----

/** The stream's latest clone list, for the composer of the project being cloned. */
const cloneSnapshots = signal<CloneSnapshot[]>([]);

/** Why sending waits on the project: "Cloning repository", "Repository not cloned", "Copying files", or null. */
export function projectCloneSendBlockReason(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const clone = cloneSnapshots().find((item) => item.projectId === projectId);
  if (clone?.phase === "running") return "Cloning repository";
  if (clone && clone.phase !== "done") return "Repository not cloned";
  const copies = Object.entries(projectFileCopies()).filter(([key]) => key.endsWith(`:${projectId}`)).map(([, copy]) => copy);
  return copies.some((copy) => copy.phase === "copying") ? "Copying files" : null;
}

/** The composer banner for a project still being cloned or copied into place, with cancel, retry and remove. */
export function projectCloneBannerItem(projectId: string | null | undefined): BannerItem | null {
  if (!projectId) return null;
  const copy = Object.entries(projectFileCopies()).find(([key, value]) => key.endsWith(`:${projectId}`) && value.phase === "failed");
  if (copy && copy[1].phase === "failed") {
    const key = copy[0];
    return {
      id: `project-file-copy:${projectId}`, variant: "error", icon: "download", title: copy[1].title, description: copy[1].failures.join("\n"), actions: [],
      onDismiss: () => projectFileCopies.update((all) => { const next = { ...all }; delete next[key]; return next; }),
    };
  }
  const clone = cloneSnapshots().find((item) => item.projectId === projectId);
  if (!clone || clone.phase === "done") return null;
  const name = cloneDisplayName(clone);
  if (clone.phase === "running") {
    return {
      id: `project-clone:${projectId}`, variant: "info", icon: "download", title: `Cloning ${name}`, description: cloneProgressSummary(clone),
      actions: [{ id: "cancel", label: "Cancel", run: () => void cloneAction("projectClone.cancel", projectId, "Failed to cancel clone") }],
    };
  }
  const cancelled = clone.phase === "cancelled";
  return {
    id: `project-clone:${projectId}`, variant: cancelled ? "warning" : "error", icon: "download",
    title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
    description: cancelled ? "Retry to bring in the repository." : clone.error ?? undefined,
    actions: [
      { id: "remove", label: "Remove project", run: () => void removeClonedProject(projectId) },
      { id: "retry", label: "Retry", run: () => void cloneAction("projectClone.retry", projectId, "Failed to retry clone") },
    ],
  };
}

let unsubscribeClones: (() => void) | null = null;
let subscribedKey = "";

/** Follows the project clones of the connected environment; call again after a reconnect. */
export function followProjectClones() {
  if (!backend.connected()) {
    unsubscribeClones?.();
    unsubscribeClones = null;
    subscribedKey = "";
    return;
  }
  const key = `${backendUrl()}|${backendConnectionGeneration()}`;
  if (key === subscribedKey) return;
  unsubscribeClones?.();
  subscribedKey = key;
  unsubscribeClones = backend.subscribe("subscribeProjectClones", {}, applyCloneSnapshots, () => { subscribedKey = ""; });
}
