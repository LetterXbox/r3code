// The selected settings scope and the reads and writes that follow it (SettingsScopeContext.tsx,
// useScopedSettings.ts). The selection is kept across pages like the web's `?project=&machine=` search;
// a page reads `readScoped` and writes `writeScoped`, which lay a project's overrides over the environment's
// and send a project write as `projectSettingsOverrides[projectId]`.
import { effect, signal, untracked } from "nsh";
import { allProjects, backendStatus, backendUrl } from "../../store";
import { savedEnvironments } from "./environments/savedEnvironments";
import { showToast } from "../../components/toast";
import { serverEnvironment, serverSettings } from "./settingsState";
import { acceptServerSettings, configureSettingsTarget, currentServerSettings, isServerConnected, readSetting, requestServer, writeSetting, type SettingScope } from "./settingsSync";
import { environmentConnections } from "../../environments/connectionManager";
import { replaceServerSettings } from "./settingsState";
import {
  inheritanceLayers, inheritanceSummary, isProjectScopedKey, listProjectOverrides, planClear, planPatch, resolveEffective, resolveScope, settingSource,
  WORKTREE_RULE_KEYS, resolveWorktreeCleanup, projectCleanupMode, parseT3File,
  type T3File,
  type Dict, type InheritanceLayer, type ResolvedScope, type ScopeEnvironment, type ScopeProject, type ScopeSearch, type SettingSource,
} from "./scopeCore";
import { defaultOfSetting, scopeOfSetting } from "./settingsDefaults";
import { settingsWriteDenied } from "./settingsWriteAccess";

const search = signal<ScopeSearch>({});
const remembered = signal<ScopeEnvironment | null>(null);

export const scopeSearch = () => search();
export function selectScope(next: ScopeSearch) { search.set(next); }
export function resetScope() { search.set({}); }

/**
 * The environments the scope bar lists: the one this client is connected to (the live one, else the last it saw, so
 * "Reconnect" can name it), then the saved ones. This client holds one live connection at a time, so only the live
 * environment can be read or changed; choosing a saved one shows the "Reconnect <machine> to change its settings."
 * notice.
 */
export function scopeEnvironments(): ScopeEnvironment[] {
  const connected = backendStatus() === "connected";
  const live = serverEnvironment();
  let primary: ScopeEnvironment | null = null;
  if (live && typeof live.environmentId === "string") {
    primary = { environmentId: live.environmentId, label: typeof live.label === "string" && live.label ? live.label : "This machine", connected };
  } else {
    const last = remembered();
    if (last) primary = { ...last, connected: false };
  }
  // A saved environment with a live session (environments/connectionManager.ts) can be read and changed too.
  const sessions = environmentConnections();
  const saved = savedEnvironments().filter((item) => item.url !== backendUrl()).map((item): ScopeEnvironment => ({ environmentId: `saved:${item.id}`, label: item.label, connected: item.enabled && sessions[item.id]?.phase === "connected" }));
  return [...(primary ? [primary] : []), ...saved];
}

effect(() => {
  const live = serverEnvironment();
  if (live && typeof live.environmentId === "string") {
    remembered.set({ environmentId: live.environmentId, label: typeof live.label === "string" && live.label ? live.label : "This machine", connected: true });
  }
});

export function scopeProjects(): ScopeProject[] {
  return allProjects().map((project) => ({ id: project.id, name: project.name, ...(project.path ? { path: project.path } : {}) }));
}

/** The t3.json of each project read so far, by project id: undefined until read, null when missing or invalid. */
const projectFiles = signal<Record<string, T3File | null>>({});
const invalidFiles = signal<string[]>([]);
/** A t3.json exists in the checkout but fails to parse (the Actions card says so). */
export const projectFileInvalid = (projectId: string | null) => projectId !== null && invalidFiles().includes(projectId);
export const projectFileOf = (projectId: string | null): T3File | null | undefined => (projectId === null ? undefined : projectFiles()[projectId]);

/** Reads a project's t3.json through `projects.readFile` (the file tier of resolveProjectSettings). */
export async function loadProjectFile(project: ScopeProject, request: (method: string, payload: unknown) => Promise<unknown> = requestServer): Promise<void> {
  if (!project.path) return;
  try {
    const result = (await request("projects.readFile", { cwd: project.path, relativePath: "t3.json", allowMissing: true })) as Dict | null;
    const usable = result && result.exists !== false && result.truncated !== true && typeof result.contents === "string";
    const parsed = usable ? parseT3File(result!.contents as string) : null;
    projectFiles.update((all) => ({ ...all, [project.id]: parsed }));
    invalidFiles.update((all) => (usable && parsed === null ? [...all.filter((id) => id !== project.id), project.id] : all.filter((id) => id !== project.id)));
  } catch {
    projectFiles.update((all) => ({ ...all, [project.id]: null }));
  }
}

export const currentScope = (): ResolvedScope => resolveScope(search(), scopeProjects(), scopeEnvironments());
/** The saved environment the scope selects (scope ids are `saved:<savedEnvironmentId>`), or null for the primary. */
export function scopeSavedEnvironmentId(): string | null {
  const scope = currentScope();
  const id = scope.kind === "environment" || scope.kind === "project" ? scope.environmentId : null;
  return id && id.startsWith("saved:") && savedEnvironments().some((item) => `saved:${item.id}` === id) ? id.slice("saved:".length) : null;
}
configureSettingsTarget(scopeSavedEnvironmentId);
export function legacyFieldsOf(projectId: string | null) {
  return projectId === null ? null : (allProjects().find((project) => project.id === projectId)?.legacyDefaults ?? null);
}
/** What resolveEffective needs beyond the server's settings for the selected project. */
const extraFor = () => ({ legacy: legacyFieldsOf(scopeProjectId()), file: projectFileOf(scopeProjectId()) });

export const isProjectScope = () => currentScope().kind === "project";
export const scopeProjectId = () => { const scope = currentScope(); return scope.kind === "project" ? scope.project.id : null; };
export const scopeEnvironmentLabel = () => scopeEnvironments()[0]?.label ?? "environment";

/** The server's settings the scope reads from, or null while disconnected. */
const environmentSettings = (): Dict | null => (isServerConnected() ? (currentServerSettings() as Dict | null) : null);

/** Whether this field takes the scope: a project-scoped server setting read while a project is selected. */
function followsProject(field: string): boolean {
  return isProjectScope() && isProjectScopedKey(field);
}

/** The value a row shows: the project's effective value in a project scope, else the plain setting. */
export function readScoped(field: string, scope: SettingScope): unknown {
  // The cleanup rules of one project: the environment's rules with the project's own laid over them.
  if (field === "storageCleanup" && isProjectScope()) return { ...(readSetting(field, scope) as Dict | null), ...resolveWorktreeCleanup(environmentSettings(), scopeProjectId()) };
  if (!followsProject(field)) return readSetting(field, scope);
  const value = resolveEffective(environmentSettings(), scopeProjectId(), extraFor()).settings[field];
  return value === undefined ? readSetting(field, scope) : value;
}

/** Where the value comes from, for the inheritance mark and the "Reset to inherited value" button. */
export function sourceOf(keys: readonly string[]): SettingSource {
  return settingSource(currentScope(), environmentSettings(), keys, extraFor());
}

export function overridingProjectIds(keys: readonly string[]): string[] {
  return isProjectScope() ? [] : listProjectOverrides(environmentSettings(), keys);
}

export function layersFor(key: string): InheritanceLayer[] {
  return inheritanceLayers(currentScope(), environmentSettings(), scopeEnvironmentLabel(), key, defaultOfSetting(key) ?? null, extraFor());
}

export function inheritanceFor(keys: readonly string[]) {
  const scope = currentScope();
  const settings = environmentSettings();
  const scoped = scope.kind === "project" && keys.some(isProjectScopedKey);
  const customized = keys.some((key) => settings?.[key] !== undefined && JSON.stringify(settings[key]) !== JSON.stringify(defaultOfSetting(key) ?? null));
  return inheritanceSummary(settingSource(scope, settings, keys, extraFor()), scoped, customized, scopeEnvironmentLabel());
}

/** useUpdateScopedSettings' failure toast: "Could not save on <environment>: <reason>". */
function saveFailed(title: string, reason: string) {
  showToast({ type: "error", title, description: `Could not save on ${scopeEnvironmentLabel()}: ${reason}` });
}

/** A session without settings:write cannot save server settings (requiredScopesForServerSettingsPatch). */
function deniedWrite(): boolean {
  if (!settingsWriteDenied()) return false;
  saveFailed("Setting not saved", "This connection lacks permission to change these settings.");
  return true;
}

async function send(patch: Dict, failedTitle: string) {
  if (deniedWrite()) return;
  try {
    acceptServerSettings(await requestServer("server.updateSettings", { patch }));
  } catch (cause) {
    saveFailed(failedTitle, cause instanceof Error && cause.message ? cause.message : "The save failed. Try reconnecting and saving again.");
  }
}

/** Writes one setting for the selected scope. Outside a project scope this is the plain write. */
export async function writeScoped(field: string, scope: SettingScope, value: string | boolean | number | null): Promise<void> {
  // A rule edited in a project scope becomes that project's custom cleanup rules (updateWorktree of StorageSettings).
  if (field === "storageCleanup" && isProjectScope() && typeof value === "object" && value !== null) {
    const rules = Object.fromEntries(Object.entries(value as Dict).filter(([key]) => (WORKTREE_RULE_KEYS as readonly string[]).includes(key)));
    const merged = { ...resolveWorktreeCleanup(environmentSettings(), scopeProjectId()), ...rules };
    return writeScopedPatch({ worktreeCleanup: { mode: "custom", rules: merged } });
  }
  if (!followsProject(field)) {
    if (isProjectScope() && scopeOfSetting(field) === "server") {
      showToast({ type: "warning", title: "Setting not saved", description: "This setting is environment-wide and cannot be overridden by a project." });
      return;
    }
    if (scope === "server" && deniedWrite()) return;
    return writeSetting(field, scope, value);
  }
  const plan = planPatch(currentScope(), environmentSettings(), { [field]: value }, isServerConnected());
  if (plan.unavailableReason) {
    showToast({ type: "warning", title: "Setting not saved", description: plan.unavailableReason });
    return;
  }
  if (plan.patch) await send(plan.patch, "Setting not saved");
}

/** Writes several project-scoped keys at once (a nested control that edits one setting through many rows). */
export async function writeScopedPatch(patch: Dict): Promise<void> {
  const scope = currentScope();
  const plan = planPatch(scope, environmentSettings(), patch, isServerConnected());
  if (plan.unavailableReason) {
    showToast({ type: "warning", title: "Setting not saved", description: plan.unavailableReason });
    return;
  }
  if (plan.patch) await send(plan.patch, "Setting not saved");
}

/** useClearScopedSettings: remove the project's overrides for these keys so it inherits again. */
export async function clearOverrides(keys: readonly string[]): Promise<void> {
  const plan = planClear(currentScope(), environmentSettings(), keys);
  if (plan.unavailableReason) {
    showToast({ type: "warning", title: "Setting not saved", description: plan.unavailableReason });
    return;
  }
  if (plan.patch) await send(plan.patch, "Setting not saved");
}

/** useClearProjectOverrides: clear these keys from every project that overrides them. */
export async function clearProjectOverrides(projectIds: readonly string[], keys: readonly string[]): Promise<void> {
  const settings = environmentSettings();
  const overrides = settings?.projectSettingsOverrides as Dict | undefined;
  if (!settings || !overrides) {
    showToast({ type: "warning", title: "Setting not saved", description: "Connect the environments to reset these overrides." });
    return;
  }
  const next: Dict = {};
  for (const id of projectIds) {
    const entry = { ...((overrides[id] as Dict | undefined) ?? {}) };
    for (const key of keys) delete entry[key];
    next[id] = Object.keys(entry).length === 0 ? null : entry;
  }
  await send({ projectSettingsOverrides: next }, "Setting not saved");
}

/** One project's stored override of a key, for the "Overridden by" list. */
export function settingsOverrideValue(projectId: string, key: string): unknown {
  const entry = (environmentSettings()?.projectSettingsOverrides as Dict | undefined)?.[projectId] as Dict | undefined;
  return entry?.[key];
}

/** The Automatic worktree cleanup mode of the selected project. */
export function cleanupMode(): "inherit" | "off" | "custom" {
  const id = scopeProjectId();
  return id === null ? "inherit" : projectCleanupMode(environmentSettings(), id);
}

// Read the selected project's t3.json once connected, and again when the selection changes.
effect(() => {
  const scope = currentScope();
  if (scope.kind !== "project" || !isServerConnected()) return;
  const project = scope.project;
  if (projectFiles()[project.id] === undefined) void untracked(() => loadProjectFile(project));
});
