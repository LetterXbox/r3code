// What the model picker lists, derived the way ModelPickerContent.tsx / modelSelection.ts /
// modelOrdering.ts do from contract-shaped provider snapshots (`server.getConfig` providers) and
// the server settings: only enabled instances; per instance the models its settings do not hide
// (`providerModelPreferences[instance].hiddenModels`), in `modelOrder` then server order; models
// the server marks `isLegacy` sit behind "Show more"; favourites lead each provider's list.
import { driverMeta } from "../../pages/settings/providers/driverMeta";
import { instanceInitials } from "../../pages/settings/providers/logic";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export interface PickerModel {
  instanceId: string;
  slug: string;
  name: string;
  isLegacy: boolean;
  isNew: boolean;
  isUnavailable: boolean;
  subProvider: string | null;
  /** The server's model aliases and default flag (Antigravity's default-model alias resolution). */
  aliases?: string[];
  isDefault?: boolean;
}

export interface PickerInstance {
  instanceId: string;
  driver: string;
  displayName: string;
  accentColor: string | null;
  /** Enabled, available and ready: its models are listed and the sidebar icon is pressable. */
  ready: boolean;
  /** shouldShowInstanceBadge: an accent colour, or another instance of the same driver. */
  showBadge: boolean;
  badge: string;
  models: PickerModel[];
  /** The provider snapshot's `continuation.groupKey` (providerInstances.ts continuationGroupKey). */
  continuationGroupKey?: string | null;
  /** Locked out by a started thread's provider (lockedDisabledInstanceIds): listed last, dimmed, not pressable. */
  lockedOut?: boolean;
}

const humanize = (slug: string) => slug.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().replace(/\b\w/g, (char) => char.toUpperCase());

/** resolveProviderInstanceDisplayName. */
export function instanceDisplayName(record: Dict): string {
  const instanceId = text(record.instanceId) ?? "";
  const driver = text(record.driver) ?? instanceId;
  const given = text(record.displayName);
  const kind = driverMeta(driver)?.label ?? humanize(driver);
  if (given && given !== kind) return given;
  if (instanceId !== driver) {
    const name = humanize(instanceId);
    if (name.length > 0) return name;
  }
  return given ?? kind;
}

const validAccent = (value: unknown): string | null => {
  const raw = text(value);
  return raw && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null;
};

/** getDisplayModelName: the name without its sub-provider qualifier. */
export function displayModelName(model: { name: string; subProvider?: string | null }): string {
  const qualifier = model.subProvider?.trim();
  if (!qualifier) return model.name;
  const escaped = qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return model.name.replace(new RegExp(`^${escaped}(?:\\s*[.:/-]\\s*|\\s+)`, "iu"), "").trim() || model.name;
}

function prefsFor(settings: Dict | null, instanceId: string): { hidden: Set<string>; order: string[] } {
  const entry = dict(dict(settings?.providerModelPreferences)?.[instanceId]);
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return { hidden: new Set(list(entry?.hiddenModels)), order: list(entry?.modelOrder) };
}

/** sortModelsForProviderInstance without favourites: `modelOrder` first, then the server's order. */
export function sortByPreferredOrder<T extends { slug: string }>(models: T[], order: string[]): T[] {
  const rank = new Map(order.map((slug, index) => [slug, index] as const));
  const original = new Map(models.map((model, index) => [model.slug, index] as const));
  return [...models].sort((a, b) =>
    (rank.get(a.slug) ?? Infinity) - (rank.get(b.slug) ?? Infinity) || (original.get(a.slug)! - original.get(b.slug)!));
}

/** The picker's instances, in the server's order. `allow` (provider:model keys) narrows the models, for pickers that offer a subset. */
/** ANTIGRAVITY_DEFAULT_MODEL (contracts model.ts). */
export const ANTIGRAVITY_DEFAULT_MODEL = "antigravity-default";

/**
 * appendUnavailableDynamicModelSelection (modelSelection.ts:76): an OpenCode or Antigravity thread whose selected model the
 * provider no longer lists keeps it as a last, unavailable row (not a hidden one, not Antigravity's default).
 */
export function appendUnavailableSelection(models: PickerModel[], driver: string, instanceId: string, selected: { instanceId: string; model: string } | null | undefined, hidden: ReadonlySet<string>): PickerModel[] {
  if (driver !== "opencode" && driver !== "antigravity") return models;
  if (!selected || selected.instanceId !== instanceId) return models;
  const slug = selected.model.trim();
  if (!slug || (driver === "antigravity" && slug === ANTIGRAVITY_DEFAULT_MODEL)) return models;
  if (hidden.has(slug) || models.some((model) => model.slug === slug)) return models;
  return [...models, { instanceId, slug, name: slug, isLegacy: false, isNew: false, isUnavailable: true, subProvider: null }];
}

/** resolveProjectProviderInstanceEnabled: a project's providerInstances override wins over the snapshot's enable. */
export function instanceEnabledFor(record: Dict, settings: Dict | null, projectId: string | null | undefined): boolean {
  const instanceId = text(record.instanceId);
  if (!instanceId) return false;
  const override = projectId ? dict(dict(dict(dict(settings?.projectSettingsOverrides)?.[projectId])?.providerInstances)?.[instanceId])?.enabled : undefined;
  return typeof override === "boolean" ? override : record.enabled !== false;
}

export function buildPickerInstances(records: Dict[], settings: Dict | null, allow?: ReadonlySet<string> | null, selected?: { instanceId: string; model: string } | null, projectId?: string | null): PickerInstance[] {
  const enabled = records.filter((record) => instanceEnabledFor(record, settings, projectId));
  const driverCount = new Map<string, number>();
  for (const record of enabled) {
    const driver = text(record.driver) ?? text(record.instanceId)!;
    driverCount.set(driver, (driverCount.get(driver) ?? 0) + 1);
  }
  return enabled.map((record): PickerInstance => {
    const instanceId = text(record.instanceId)!;
    const driver = text(record.driver) ?? instanceId;
    const accentColor = validAccent(record.accentColor);
    const ready = record.availability !== "unavailable" && record.status === "ready";
    const prefs = prefsFor(settings, instanceId);
    const raw = (Array.isArray(record.models) ? record.models : []).flatMap((value): PickerModel[] => {
      const entry = dict(value);
      const slug = text(entry?.slug);
      if (!entry || !slug) return [];
      if (allow && !allow.has(`${instanceId}:${slug}`)) return [];
      if (entry.isCustom !== true && prefs.hidden.has(slug)) return [];
      // shouldIncludeModelPickerOption: Antigravity's default-model alias is never a row of its own.
      if (driver === "antigravity" && slug === ANTIGRAVITY_DEFAULT_MODEL) return [];
      const aliases = Array.isArray(entry.aliases) ? entry.aliases.filter((alias): alias is string => typeof alias === "string") : [];
      return [{
        instanceId, slug, name: text(entry.name) ?? slug, isLegacy: entry.isLegacy === true, isNew: entry.badge === "new",
        isUnavailable: false, subProvider: text(entry.subProvider),
        ...(aliases.length > 0 ? { aliases } : {}), ...(entry.isDefault === true ? { isDefault: true } : {}),
      }];
    });
    const displayName = instanceDisplayName(record);
    return {
      instanceId, driver, displayName, accentColor, ready,
      showBadge: accentColor !== null || (driverCount.get(driver) ?? 0) > 1,
      badge: instanceInitials(displayName),
      models: ready ? appendUnavailableSelection(sortByPreferredOrder(raw, prefs.order), driver, instanceId, selected, prefs.hidden) : [],
      continuationGroupKey: text(dict(record.continuation)?.groupKey),
    };
  });
}

export type PickerTab = "favorites" | string;
export const modelKeyOf = (model: { instanceId: string; slug: string }) => `${model.instanceId}:${model.slug}`;

export interface PickerList {
  rows: PickerModel[];
  /** Legacy models held behind "Show more" (empty when none, or while searching / in Favorites). */
  hiddenLegacy: number;
  expanded: boolean;
}

/**
 * The rows for a tab. Favorites: starred models by instance then server order. A provider: its
 * models with favourites first, legacy ones (not starred) behind "Show more". A search spans every provider.
 */
export function listFor(instances: PickerInstance[], tab: PickerTab, query: string, favorites: ReadonlySet<string>, expandedLegacy: boolean): PickerList {
  const all = instances.flatMap((instance) => instance.models);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const label = new Map(instances.map((instance) => [instance.instanceId, instance.displayName] as const));
    return {
      rows: all.filter((model) => {
        const haystack = `${displayModelName(model)} ${model.slug} ${model.subProvider ?? ""} ${label.get(model.instanceId) ?? ""}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      }),
      hiddenLegacy: 0, expanded: false,
    };
  }
  if (tab === "favorites") return { rows: all.filter((model) => favorites.has(modelKeyOf(model))), hiddenLegacy: 0, expanded: false };
  const own = all.filter((model) => model.instanceId === tab);
  const sorted = [...own.filter((model) => favorites.has(modelKeyOf(model))), ...own.filter((model) => !favorites.has(modelKeyOf(model)))];
  const legacy = sorted.filter((model) => model.isLegacy && !favorites.has(modelKeyOf(model)));
  const current = sorted.filter((model) => !legacy.includes(model));
  return { rows: expandedLegacy ? [...current, ...legacy] : current, hiddenLegacy: legacy.length, expanded: expandedLegacy };
}

/** The tab a freshly opened picker starts on: Favorites when any exist, else the active instance. */
export function startTab(instances: PickerInstance[], activeInstanceId: string | null, favorites: ReadonlySet<string>): PickerTab {
  if (favorites.size > 0) return "favorites";
  if (activeInstanceId && instances.some((instance) => instance.instanceId === activeInstanceId)) return activeInstanceId;
  return instances.find((instance) => instance.ready)?.instanceId ?? "favorites";
}

/** A started thread's provider: its driver and, when the snapshot has one, its continuation group. */
export interface ProviderLock { driver: string; continuationGroupKey: string | null }

/** The tooltip of a sidebar instance a lock leaves out (ModelPickerContent.tsx getDisabledInstanceTooltip). */
/** ModelPickerSidebar describeUnavailableInstance: the rail icon's tooltip (the name, or why it is greyed out). */
export function describeUnavailableInstance(displayName: string, status: { enabled: boolean; available: boolean; status: string; message: string | null } | undefined): string {
  if (!status) return displayName;
  if ((!status.enabled && status.available) || status.status === "disabled") return `${displayName}: Disabled in settings.`;
  if (status.status === "ready" && status.available) return displayName;
  const kind = status.status === "error" ? "Unavailable" : status.status === "warning" ? "Limited" : "Not ready";
  const message = status.message?.trim();
  return message ? `${displayName}: ${kind}. ${message}` : `${displayName}: ${kind}.`;
}
export const lockedInstanceTooltip = (displayName: string) => `${displayName} is unavailable in this thread. Start a new thread to switch providers.`;

/** matchesLockedProvider (ModelPickerContent.tsx). */
export function matchesProviderLock(instance: { driver: string; continuationGroupKey?: string | null }, lock: ProviderLock | null): boolean {
  if (lock === null) return true;
  if (instance.driver !== lock.driver) return false;
  if (!lock.continuationGroupKey) return true;
  return instance.continuationGroupKey === lock.continuationGroupKey;
}

/**
 * The picker's instances under a lock: matching instances first, the rest after them marked `lockedOut` with no
 * models, so no tab, search or favourites row lists a model of another provider (sidebarInstanceEntries,
 * filteredModels).
 */
export function applyProviderLock(instances: PickerInstance[], lock: ProviderLock | null): PickerInstance[] {
  if (lock === null) return instances;
  const available = instances.filter((instance) => matchesProviderLock(instance, lock));
  const disabled = instances.filter((instance) => !matchesProviderLock(instance, lock)).map((instance) => ({ ...instance, lockedOut: true, models: [] }));
  return [...available, ...disabled];
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** threadSupportsProviderHandoff (client-runtime state/threadWorkflows.ts) over the live projection's records. */
export function threadSupportsProviderHandoff(projection: Dict | null): boolean {
  if (projection === null) return false;
  const thread = dict(projection.thread) ?? {};
  const runs = (Array.isArray(projection.runs) ? projection.runs : []).flatMap((value) => { const run = dict(value); return run ? [run] : []; });
  const sessions = (Array.isArray(projection.providerSessions) ? projection.providerSessions : []).flatMap((value) => { const item = dict(value); return item ? [item] : []; });
  const providerThreads = (Array.isArray(projection.providerThreads) ? projection.providerThreads : []).flatMap((value) => { const item = dict(value); return item ? [item] : []; });
  const activeRun = [...runs].reverse().find((run) => ACTIVE_RUN_STATUSES.has(text(run.status) ?? "")) ?? null;
  const threadId = text(thread.id);
  const providerThreadId = text(activeRun?.providerThreadId) ?? text(thread.activeProviderThreadId);
  const activeProviderThread = providerThreadId === null ? null : (providerThreads.find((item) => item.id === providerThreadId) ?? null);
  const attached = activeProviderThread ?? providerThreads.find((item) => item.appThreadId === threadId && text(item.providerSessionId) !== null) ?? null;
  const sessionId = text(attached?.providerSessionId);
  const session = sessionId !== null
    ? (sessions.find((item) => item.id === sessionId) ?? null)
    : ([...sessions].reverse().find((item) => item.status !== "stopped" && item.status !== "error") ?? null);
  if (session !== null) return dict(dict(session.capabilities)?.sessions)?.supportsProviderSwitchingViaHandoff === true;
  if (activeRun !== null) return false;
  if (thread.historyOrigin === "v1_import" || runs.length === 0) return true;
  const instanceId = text(dict(thread.modelSelection)?.instanceId);
  return providerThreads.some((item) => item.id === text(thread.activeProviderThreadId) && item.appThreadId === threadId
    && item.providerInstanceId === instanceId && item.nativeThreadRef != null);
}

/**
 * deriveLockedProvider (ChatView.logic.ts) as the picker sees it (ChatView.tsx modelPickerLockedProvider): a thread
 * that has started keeps its provider's driver, unless its provider session can hand off to another provider. A thread
 * has started once it has a run or a provider session (threadHasStarted: latestRun, items or runtime).
 */
export function pickerProviderLock(input: { projection: Dict | null; records: Dict[] }): ProviderLock | null {
  const projection = input.projection;
  if (projection === null) return null;
  const runs = Array.isArray(projection.runs) ? projection.runs : [];
  const sessions = Array.isArray(projection.providerSessions) ? projection.providerSessions : [];
  if (runs.length === 0 && sessions.length === 0) return null;
  if (threadSupportsProviderHandoff(projection)) return null;
  const thread = dict(projection.thread) ?? {};
  const instanceId = text(dict(thread.modelSelection)?.instanceId);
  const record = input.records.find((item) => item.instanceId === instanceId) ?? null;
  const driver = text(record?.driver) ?? text(dict(thread.modelSelection)?.provider) ?? instanceId;
  if (driver === null) return null;
  return { driver, continuationGroupKey: text(dict(record?.continuation)?.groupKey) };
}

/**
 * getStartedThreadModelChangeBlockReason (ChatView.logic.ts): a thread whose provider session has started keeps its
 * provider instance unless the session can hand off to another one.
 */
export function startedThreadModelChangeBlock(input: { projection: Dict | null; nextInstanceId: string }): { title: string; description: string } | null {
  const projection = input.projection;
  if (projection === null) return null;
  const sessions = Array.isArray(projection.providerSessions) ? projection.providerSessions : [];
  if (sessions.length === 0) return null;
  const current = text(dict(dict(projection.thread)?.modelSelection)?.instanceId);
  if (current === input.nextInstanceId || threadSupportsProviderHandoff(projection)) return null;
  return { title: "Start a new chat to switch providers", description: "This thread does not support switching providers after it has started." };
}

/** useApplyThreadModelPick: a pick of the thread's own provider instance is set on the thread at once (another
 * instance replaces the live session, which may hold an open question, so that pick waits for a sent message). */
export function shouldApplyThreadModelPick(input: { projection: Dict | null; instanceId: string }): boolean {
  const thread = dict(input.projection?.thread);
  return thread !== null && text(dict(thread.modelSelection)?.instanceId) === input.instanceId;
}

/**
 * resolveModelPickerSelectedModel (ModelPickerContent.tsx): the row a selection stands for. Antigravity's default-model
 * alias resolves to the available model that carries the alias, else the provider's default model.
 */
export function resolvePickerSelectedModel(driver: string | undefined, model: string, options: readonly PickerModel[]): PickerModel | undefined {
  if (driver === "antigravity" && model === ANTIGRAVITY_DEFAULT_MODEL) {
    const available = options.filter((option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable);
    return available.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ?? available.find((option) => option.isDefault);
  }
  return options.find((option) => option.slug === model);
}
