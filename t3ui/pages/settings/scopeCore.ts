// The settings scope engine, ported from components/settings/settingsScope.ts, scopedSettings.ts and
// packages/shared/src/projectSettings.ts. A page edits settings for one target: every project on the
// environment ("all"), the environment itself, or one project. A project's settings are the environment's
// with the project's own overrides (`projectSettingsOverrides[projectId]`) laid over them.
//
// This client holds one live environment at a time, so the environment axis lists that one. The module is
// pure: it takes the server's ServerSettings and says what to read or send.

/** PROJECT_SCOPED_SERVER_SETTING_KEYS (contracts settings.ts): the keys a project may override. */
export const PROJECT_SCOPED_KEYS: readonly string[] = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "pullRequestMergeMethod",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
  "speechProjectCustomWords",
];

/** Override keys whose null is itself a value (isNullableProjectSettingsOverride); null elsewhere removes the override. */
const NULLABLE_OVERRIDES = new Set([
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "pullRequestMergeMethod",
  "sidebarAutoSettleAfterDays",
]);

/** PROJECT_FILE_BACKED_SETTINGS: a null environment value falls back to t3.json, then to this built-in. */
export const FILE_BACKED_BUILT_INS: Record<string, unknown> = { defaultThreadEnvMode: "local", worktreeSubmodules: "recursive" };

/** SETTINGS_DEVICE_ONLY_PATHS: pages with no scope, because they edit this device. */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/chat",
  "/settings/diffs",
  "/settings/snap-shot",
  "/settings/connections",
  "/settings/access",
  "/settings/about",
]);

export type Dict = Record<string, unknown>;
export interface ScopeSearch { project?: string; machine?: string }
export interface ScopeEnvironment { environmentId: string; label: string; connected: boolean }
export interface ScopeProject { id: string; name: string; path?: string }

export type ResolvedScope =
  | { kind: "all"; label: string; environmentIds: string[] }
  | { kind: "environment"; label: string; environmentId: string; environmentIds: string[] }
  | { kind: "project"; label: string; project: ScopeProject; environmentId: string | null; environmentIds: string[] }
  | { kind: "unavailable"; label: string; message: string; reason: "project-missing" | "environment-missing"; environmentIds: string[] };

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
export const isProjectScopedKey = (key: string) => PROJECT_SCOPED_KEYS.includes(key);

/** A stale id stays visible so a removed target reads as unavailable, never as "all". */
export function resolveScope(search: ScopeSearch, projects: readonly ScopeProject[], environments: readonly ScopeEnvironment[]): ResolvedScope {
  const environment = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !environment) {
    return { kind: "unavailable", reason: "environment-missing", label: "Unavailable selection", message: "This environment is no longer available.", environmentIds: [] };
  }
  if (search.project) {
    const project = projects.find((candidate) => candidate.id === search.project);
    if (!project) return { kind: "unavailable", reason: "project-missing", label: "Unavailable selection", message: "This project is no longer available.", environmentIds: [] };
    return {
      kind: "project",
      project,
      environmentId: environment?.environmentId ?? null,
      label: `${project.name} / ${environment?.label ?? "All checkouts"}`,
      environmentIds: environments.map((candidate) => candidate.environmentId),
    };
  }
  if (environment) return { kind: "environment", environmentId: environment.environmentId, label: environment.label, environmentIds: [environment.environmentId] };
  return { kind: "all", label: "All environments", environmentIds: environments.map((candidate) => candidate.environmentId) };
}

export function scopeTargetsConnected(scope: ResolvedScope, environments: readonly ScopeEnvironment[]): boolean {
  return environments.some((environment) => scope.environmentIds.includes(environment.environmentId) && environment.connected);
}

export type SettingSource = "environment" | "project" | "t3.json";

/** The keys of a project's t3.json the settings read (T3ProjectFile): file-backed settings and the scripts. */
export interface T3File { defaultThreadEnvMode?: string; worktreeSubmodules?: string; scripts?: unknown[]; iconPath?: string }

/** The legacy per-project fields of the shell snapshot, used until the server folds them into overrides (LegacyProjectSettingsFields). */
export interface LegacyProjectFields { defaultModelSelection?: unknown; defaultThreadEnvMode?: unknown; autoPull?: boolean }

/** parseT3ProjectFile: t3.json is lenient JSON (comments and trailing commas); a file that does not parse is null. */
export function parseT3File(contents: string): T3File | null {
  const withoutComments = contents.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_all, quoted) => quoted ?? "");
  const withoutTrailing = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    const value = JSON.parse(withoutTrailing) as unknown;
    if (!isDict(value)) return null;
    const out: T3File = {};
    if (value.defaultThreadEnvMode === "local" || value.defaultThreadEnvMode === "worktree") out.defaultThreadEnvMode = value.defaultThreadEnvMode;
    if (value.worktreeSubmodules === "recursive" || value.worktreeSubmodules === "top-level" || value.worktreeSubmodules === "none") out.worktreeSubmodules = value.worktreeSubmodules;
    if (Array.isArray(value.scripts)) out.scripts = value.scripts;
    if (typeof value.iconPath === "string") out.iconPath = value.iconPath;
    return out;
  } catch {
    return null;
  }
}

/**
 * resolveProjectSettings: the environment's settings with one project's overrides laid over them, then, for the
 * file-backed keys the environment leaves null, the project's t3.json, then the built-in. `file` undefined means
 * the file has not been read; null a missing or invalid one.
 */
export function resolveEffective(settings: Dict | null, projectId: string | null, extra?: { legacy?: LegacyProjectFields | null; file?: T3File | null }): { settings: Dict; sources: Record<string, SettingSource>; overrides: Dict } {
  const base = settings ?? {};
  const stored = projectId === null ? undefined : (base.projectSettingsOverrides as Dict | undefined)?.[projectId];
  let overrides: Dict = isDict(stored) ? stored : {};
  const legacy = extra?.legacy;
  if (projectId !== null && legacy && base.projectSettingsFolded !== true) {
    const autoPull = (base.projectAutoPullOverrides as Dict | undefined)?.[projectId];
    overrides = {
      ...(legacy.defaultModelSelection != null ? { defaultModelSelection: legacy.defaultModelSelection } : {}),
      ...(legacy.defaultThreadEnvMode != null ? { defaultThreadEnvMode: legacy.defaultThreadEnvMode } : {}),
      ...(typeof autoPull === "boolean" ? { defaultAutoPull: autoPull } : {}),
      ...overrides,
    };
  }
  const effective: Dict = { ...base };
  const sources: Record<string, SettingSource> = {};
  for (const key of PROJECT_SCOPED_KEYS) {
    if (Object.hasOwn(overrides, key) && overrides[key] !== undefined) {
      effective[key] = overrides[key];
      sources[key] = "project";
    } else {
      sources[key] = "environment";
    }
  }
  for (const [key, builtIn] of Object.entries(FILE_BACKED_BUILT_INS)) {
    if (effective[key] !== null && effective[key] !== undefined) continue;
    const fromFile = projectId === null ? undefined : (extra?.file as Dict | null | undefined)?.[key];
    effective[key] = fromFile ?? builtIn;
    if (fromFile !== undefined) sources[key] = "t3.json";
  }
  return { settings: effective, sources, overrides };
}

export interface ScopedPlan { patch: Dict | null; unavailableReason: string | null }

/**
 * planScopedSettingsPatch for one environment. An environment or all-environments scope sends the patch as it
 * is; a project scope turns each key into an override entry and refuses a key a project cannot override.
 */
export function planPatch(scope: ResolvedScope, settings: Dict | null, patch: Dict, connected: boolean): ScopedPlan {
  if (Object.keys(patch).length === 0) return { patch: null, unavailableReason: null };
  if (scope.kind === "unavailable") return { patch: null, unavailableReason: scope.message };
  if (!connected || settings === null) {
    return { patch: null, unavailableReason: scope.kind === "project" ? "Connect the selected checkouts, or update their environments, to save a project override." : `Connect ${scope.kind === "environment" ? scope.label : "an environment"} to save this setting.` };
  }
  if (scope.kind !== "project") return { patch, unavailableReason: null };
  if (Object.keys(patch).some((key) => !isProjectScopedKey(key))) {
    return { patch: null, unavailableReason: "This setting is environment-wide and cannot be overridden by a project." };
  }
  const projectId = scope.project.id;
  const current = (settings.projectSettingsOverrides as Dict | undefined)?.[projectId];
  const entry: Dict = isDict(current) ? { ...current } : {};
  const effective = resolveEffective(settings, projectId).settings;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && !NULLABLE_OVERRIDES.has(key)) {
      delete entry[key];
      continue;
    }
    const base = effective[key];
    // A new model must not inherit the previous model's options.
    if (isDict(value) && isDict(base) && key.endsWith("ModelSelection") && (value.instanceId !== undefined || value.model !== undefined)) {
      entry[key] = { instanceId: base.instanceId, model: base.model, ...value };
      continue;
    }
    entry[key] = isDict(value) && isDict(base) ? { ...base, ...value } : value;
  }
  return { patch: { projectSettingsOverrides: { [projectId]: Object.keys(entry).length === 0 ? null : entry } }, unavailableReason: null };
}

/** planScopedSettingsClear: remove a project's overrides for these keys so it inherits again. */
export function planClear(scope: ResolvedScope, settings: Dict | null, keys: readonly string[]): ScopedPlan {
  if (scope.kind !== "project" || settings === null) return { patch: null, unavailableReason: "Connect the selected checkouts, or update their environments, to reset this override." };
  const current = (settings.projectSettingsOverrides as Dict | undefined)?.[scope.project.id];
  if (!isDict(current)) return { patch: null, unavailableReason: null };
  const entry = { ...current };
  for (const key of keys) delete entry[key];
  return { patch: { projectSettingsOverrides: { [scope.project.id]: Object.keys(entry).length === 0 ? null : entry } }, unavailableReason: null };
}

/** The projects whose overrides set any of these keys (listProjectOverrides). */
export function listProjectOverrides(settings: Dict | null, keys: readonly string[]): string[] {
  const scoped = keys.filter(isProjectScopedKey);
  const all = settings?.projectSettingsOverrides;
  if (scoped.length === 0 || !isDict(all)) return [];
  return Object.entries(all).filter(([, entry]) => isDict(entry) && scoped.some((key) => Object.hasOwn(entry, key) && entry[key] !== undefined)).map(([id]) => id);
}

/** scopedSettingsSource: where the shown value of a row comes from. */
export function settingSource(scope: ResolvedScope, settings: Dict | null, keys: readonly string[], extra?: Parameters<typeof resolveEffective>[2]): SettingSource {
  const scoped = keys.filter(isProjectScopedKey);
  if (scope.kind !== "project" || scoped.length === 0) return "environment";
  const { sources } = resolveEffective(settings, scope.project.id, extra);
  return scoped.some((key) => sources[key] === "project") ? "project" : scoped.some((key) => sources[key] === "t3.json") ? "t3.json" : "environment";
}

export type InheritanceState = "default" | "environment" | "inherited" | "overridden";

export interface InheritanceLayer { key: "project" | "environment" | "t3.json" | "built-in"; label: string; value: string; effective: boolean; set: boolean }

const ENV_MODE_LABELS: Record<string, string> = { local: "Current checkout", worktree: "New worktree" };
const SUBMODULE_LABELS: Record<string, string> = { recursive: "Recursive", "top-level": "Top level only", none: "Skip" };
const MERGE_LABELS: Record<string, string> = { merge: "Merge", squash: "Squash and merge", rebase: "Rebase and merge" };
const WRITING_LABELS: Record<string, string> = { repo_conventions: "Repository conventions", conventional_commits: "Conventional Commits", custom: "Custom instructions" };

/** formatValue of SettingInheritance.tsx. */
export function formatSettingValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    if (key === "pullRequestMergeMethod") return "Last selected";
    if (key === "sidebarAutoSettleAfterDays") return "Never";
    if (key === "defaultModelSelection") return "Automatic";
    if (key === "sourceControlWriterModelSelection") return "Text generation model";
    if (key === "reviewGuideModelSelection") return "Source control writer model";
    if (key === "defaultThreadEnvMode" || key === "worktreeSubmodules") return "Inherit";
    return "Not set";
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return key === "sidebarAutoSettleAfterDays" ? `${value} ${value === 1 ? "day" : "days"}` : String(value);
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && value in ENV_MODE_LABELS) return ENV_MODE_LABELS[value]!;
    if (key === "worktreeSubmodules" && value in SUBMODULE_LABELS) return SUBMODULE_LABELS[value]!;
    if (key === "pullRequestMergeMethod" && value in MERGE_LABELS) return MERGE_LABELS[value]!;
    return value === "" ? "Empty" : value;
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (isDict(value)) {
    if (typeof value.model === "string") return value.model;
    if (typeof value.mode === "string") {
      if (key === "worktreeCleanup") return value.mode === "off" ? "Off" : "Custom";
      return key === "sourceControlWritingStyle" ? (WRITING_LABELS[value.mode] ?? value.mode) : value.mode;
    }
  }
  return "Custom";
}

/** settingInheritanceLayers: Project, the environment, then the built-in default; the winner is `effective`. */
export function inheritanceLayers(
  scope: ResolvedScope,
  settings: Dict | null,
  environmentLabel: string,
  key: string,
  builtIn: unknown,
  extra?: Parameters<typeof resolveEffective>[2],
): InheritanceLayer[] {
  const projectId = scope.kind === "project" ? scope.project.id : null;
  const resolved = resolveEffective(settings, projectId, extra);
  const source = isProjectScopedKey(key) ? resolved.sources[key] : "environment";
  const environmentValue = settings?.[key];
  const environmentSet = environmentValue !== undefined && JSON.stringify(environmentValue) !== JSON.stringify(builtIn ?? null);
  const layers: InheritanceLayer[] = [];
  if (projectId !== null && isProjectScopedKey(key)) {
    layers.push({ key: "project", label: "Project", value: source === "project" ? formatSettingValue(key, resolved.settings[key]) : "Inherits", effective: source === "project", set: source === "project" });
  }
  layers.push({ key: "environment", label: environmentLabel, value: environmentSet ? formatSettingValue(key, environmentValue) : "Inherits", effective: source === "environment" && environmentSet, set: environmentSet });
  if (projectId !== null && key in FILE_BACKED_BUILT_INS) {
    layers.push({ key: "t3.json", label: "t3.json", value: source === "t3.json" ? formatSettingValue(key, resolved.settings[key]) : "Inherits", effective: source === "t3.json", set: source === "t3.json" });
  }
  layers.push({ key: "built-in", label: "Default", value: formatSettingValue(key, FILE_BACKED_BUILT_INS[key] ?? builtIn ?? null), effective: source === "environment" && !environmentSet, set: true });
  return layers;
}

/** The marker's state and tooltip summary (the `inheritance` const of SettingsRow). */
export function inheritanceSummary(source: SettingSource, scoped: boolean, customized: boolean, environmentLabel: string): { state: InheritanceState; summary: string } {
  if (source === "project") return { state: "overridden", summary: "Overridden for this project" };
  if (source === "t3.json") return { state: "inherited", summary: "Inherited from the repository's t3.json" };
  if (scoped) return { state: "inherited", summary: `Inherited from ${environmentLabel}` };
  return customized ? { state: "environment", summary: "Set on the environment" } : { state: "default", summary: "Built-in default" };
}

/** selectEnvironmentAxis / selectProjectAxis: choosing one axis keeps the other. */
export const ALL_VALUE = "all";
export function selectEnvironmentAxis(search: ScopeSearch, value: string): ScopeSearch {
  return { ...(search.project ? { project: search.project } : {}), ...(value !== ALL_VALUE ? { machine: value } : {}) };
}
export function selectProjectAxis(search: ScopeSearch, value: string): ScopeSearch {
  return { ...(value !== ALL_VALUE ? { project: value } : {}), ...(search.machine ? { machine: search.machine } : {}) };
}

/** WorktreeCleanupRules keys (contracts settings.ts), the rules `storageCleanup` and a project's `worktreeCleanup` share. */
export const WORKTREE_RULE_KEYS = ["worktreeKeepWhen", "worktreeAfterDays", "worktreeSettledAfterDays", "worktreeOnMerge", "worktreeOnDelete", "worktreeUnchanged"] as const;

/** resolveWorktreeCleanup (packages/shared projectSettings.ts): the rules in force for a project, or the environment's. */
export function resolveWorktreeCleanup(settings: Dict | null, projectId: string | null): Dict {
  const base = (isDict(settings?.storageCleanup) ? settings!.storageCleanup : {}) as Dict;
  const environment = Object.fromEntries(WORKTREE_RULE_KEYS.map((key) => [key, base[key] ?? null]));
  const policy = resolveEffective(settings, projectId).settings.worktreeCleanup as Dict | null | undefined;
  if (policy?.mode === "custom" && isDict(policy.rules)) return policy.rules;
  if (policy?.mode === "off") return { worktreeKeepWhen: base.worktreeKeepWhen ?? "uncommitted-changes", worktreeAfterDays: null, worktreeSettledAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: false, worktreeUnchanged: false };
  return environment;
}

/** A project's cleanup mode: inherit unless its override sets one. */
export function projectCleanupMode(settings: Dict | null, projectId: string): "inherit" | "off" | "custom" {
  const { sources, settings: effective } = resolveEffective(settings, projectId);
  const policy = effective.worktreeCleanup as Dict | null | undefined;
  return sources.worktreeCleanup === "project" && (policy?.mode === "off" || policy?.mode === "custom") ? policy.mode : "inherit";
}
