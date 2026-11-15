// Pure provider-settings logic, ported from the web app's providerStatus.ts,
// ProviderSettingsPanel(.logic).tsx, ProviderModelsSection.tsx,
// ProviderInstanceCard.tsx, ProviderSettingsForm.tsx and AddProviderInstanceDialog(.logic).ts.
import { DRIVERS, driverMeta, type DriverEnvField, type DriverField, type DriverMeta } from "./driverMeta";

export type Rec = Record<string, unknown>;
export function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}
const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

// ---- the live provider snapshot (ServerProvider) ----

export interface ProviderModelView {
  slug: string; name: string; isCustom: boolean; isDefault: boolean; descriptors: Rec[]; hasCapabilities: boolean;
}
export interface VersionAdvisory {
  status: string; currentVersion: string | null; latestVersion: string | null; updateCommand: string | null;
  canUpdate: boolean; canInstallVersion: boolean; message: string | null;
}
export interface CompatibilityAdvisory {
  status: string; latestVersionStatus?: string; message: string | null; recommendedVersion: string | null; recommendedRange: string | null;
}
export interface UpdateState { status: string; message: string | null; output: string | null }
export interface UrlAuthAction { url: string; message: string; elicitationId: string }
export interface ProviderView {
  instanceId: string; driver: string; displayName: string | null; accentColor: string | null;
  badgeLabel: string | null; supportsTextGeneration?: boolean; enabled: boolean; installed: boolean; version: string | null;
  status: string; message: string | null; checkedAt: string | null; available: boolean; unavailableReason: string | null;
  auth: { status: string; type: string | null; label: string | null; email: string | null; canLogout: boolean | null; action: UrlAuthAction | null; subscriptionSharing?: boolean };
  setup: { canAuthenticate: boolean | null; canInstall: boolean | null; documentationUrl: string | null };
  models: ProviderModelView[];
  versionAdvisory: VersionAdvisory | null;
  compatibilityAdvisory: CompatibilityAdvisory | null;
  updateState: UpdateState | null;
  /** Codex's resolved home directories, shown read-only under a managed runtime. */
  runtimePaths?: { homePath: string | null; shadowHomePath: string | null };
  /** ServerProvider.nativeSessions / configurableProviders: what the ACP session section offers. */
  nativeSessions?: { canList: boolean; canLoad: boolean; canResume: boolean; canDelete: boolean };
  configurableProviders?: boolean;
  /** True for a snapshot read from the on-disk cache rather than a connected environment. */
  cached: boolean;
}

export function parseProvider(value: unknown): ProviderView | null {
  const p = rec(value);
  if (!p || typeof p.instanceId !== "string") return null;
  const auth = rec(p.auth);
  const setup = rec(p.setup);
  const version = rec(p.versionAdvisory);
  const compat = rec(p.compatibilityAdvisory);
  const update = rec(p.updateState);
  const action = rec(auth?.action);
  const models = Array.isArray(p.models) ? p.models.flatMap((entry): ProviderModelView[] => {
    const m = rec(entry);
    if (!m || typeof m.slug !== "string") return [];
    const caps = rec(m.capabilities);
    return [{ slug: m.slug, name: typeof m.name === "string" ? m.name : m.slug, isCustom: m.isCustom === true,
      isDefault: m.isDefault === true, hasCapabilities: caps !== null, descriptors: Array.isArray(caps?.optionDescriptors) ? caps.optionDescriptors.flatMap((d: unknown) => { const item = rec(d); return item ? [item] : []; }) : [] }];
  }) : [];
  return {
    instanceId: p.instanceId, driver: typeof p.driver === "string" ? p.driver : p.instanceId,
    displayName: str(p.displayName), accentColor: str(p.accentColor), badgeLabel: str(p.badgeLabel), ...(typeof p.supportsTextGeneration === "boolean" ? { supportsTextGeneration: p.supportsTextGeneration } : {}),
    enabled: p.enabled === true, installed: p.installed === true, version: str(p.version),
    status: typeof p.status === "string" ? p.status : "warning", message: str(p.message), checkedAt: str(p.checkedAt),
    available: p.availability !== "unavailable", unavailableReason: str(p.unavailableReason),
    auth: { status: typeof auth?.status === "string" ? auth.status : "unknown", type: str(auth?.type), label: str(auth?.label), email: str(auth?.email),
      canLogout: typeof auth?.canLogout === "boolean" ? auth.canLogout : null, ...(auth?.subscriptionSharing === true ? { subscriptionSharing: true } : {}),
      action: action && typeof action.url === "string" ? { url: action.url, message: typeof action.message === "string" ? action.message : "", elicitationId: typeof action.elicitationId === "string" ? action.elicitationId : "" } : null },
    setup: { canAuthenticate: typeof setup?.canAuthenticate === "boolean" ? setup.canAuthenticate : null,
      canInstall: typeof setup?.canInstall === "boolean" ? setup.canInstall : null, documentationUrl: str(setup?.documentationUrl) },
    models,
    versionAdvisory: version ? { status: typeof version.status === "string" ? version.status : "unknown", currentVersion: str(version.currentVersion),
      latestVersion: str(version.latestVersion), updateCommand: str(version.updateCommand), canUpdate: version.canUpdate === true,
      canInstallVersion: version.canInstallVersion === true, message: str(version.message) } : null,
    compatibilityAdvisory: compat ? { status: typeof compat.status === "string" ? compat.status : "unknown",
      ...(typeof compat.latestVersionStatus === "string" ? { latestVersionStatus: compat.latestVersionStatus } : {}),
      message: str(compat.message), recommendedVersion: str(compat.recommendedVersion), recommendedRange: str(compat.recommendedRange) } : null,
    updateState: update ? { status: typeof update.status === "string" ? update.status : "idle", message: str(update.message), output: typeof update.output === "string" ? update.output : null } : null,
    ...(rec(p.nativeSessions) ? { nativeSessions: { canList: rec(p.nativeSessions)?.canList === true, canLoad: rec(p.nativeSessions)?.canLoad === true, canResume: rec(p.nativeSessions)?.canResume === true, canDelete: rec(p.nativeSessions)?.canDelete === true } } : {}),
    ...(p.configurableProviders === true ? { configurableProviders: true } : {}),
    ...(rec(p.runtimePaths) ? { runtimePaths: { homePath: str(rec(p.runtimePaths)?.homePath), shadowHomePath: str(rec(p.runtimePaths)?.shadowHomePath) } } : {}),
    cached: false,
  };
}

/** The reduced snapshot the store reads from the on-disk cache. */
export interface CachedProviderLike {
  instanceId: string; driver: string; name: string; enabled: boolean; installed: boolean; available: boolean; status: string;
  authStatus: string; authLabel: string | null; version: string | null; unavailableReason: string | null;
  message: string | null; checkedAt: string | null; canInstall: boolean; canAuthenticate: boolean; models: { id: string; name: string }[];
}
export function fromCached(provider: CachedProviderLike): ProviderView {
  return {
    instanceId: provider.instanceId, driver: provider.driver, displayName: provider.name === provider.instanceId ? null : provider.name,
    accentColor: null, badgeLabel: null, enabled: provider.enabled, installed: provider.installed, version: provider.version,
    status: provider.status, message: provider.message, checkedAt: provider.checkedAt, available: provider.available,
    unavailableReason: provider.unavailableReason,
    auth: { status: provider.authStatus, type: null, label: provider.authLabel, email: null, canLogout: null, action: null },
    setup: { canAuthenticate: provider.canAuthenticate, canInstall: provider.canInstall, documentationUrl: null },
    models: provider.models.map((model) => ({ slug: model.id, name: model.name, isCustom: false, isDefault: false, descriptors: [], hasCapabilities: false })),
    versionAdvisory: null, compatibilityAdvisory: null, updateState: null, cached: true,
  };
}

// ---- status (providerStatus.ts) ----

export const STATUS_DOT_CLASS = {
  disabled: "bg-muted-foreground", error: "bg-destructive", neutral: "bg-muted-foreground", ready: "bg-success", warning: "bg-warning",
} as const;
export type StatusKey = keyof typeof STATUS_DOT_CLASS;

// Antigravity's local health check verifies installation, not Google sign-in.
function antigravitySignInUnchecked(provider: ProviderView): boolean {
  return provider.driver === "antigravity" && provider.installed && provider.status === "warning" && provider.auth.status === "unknown" &&
    (provider.auth.type === null || provider.auth.type === "oauth-personal" || provider.auth.type === "oauth-business");
}

export function statusKey(provider: ProviderView | undefined): StatusKey {
  if (provider && !provider.enabled) return "disabled";
  if (provider && antigravitySignInUnchecked(provider)) return "neutral";
  const status = provider?.status;
  return status === "ready" || status === "error" || status === "disabled" || status === "warning" ? status : "warning";
}

export function providerSummary(provider: ProviderView | undefined): { headline: string; detail: string | null } {
  if (!provider) return { headline: "Checking provider status", detail: "Waiting for the server to report installation and authentication details." };
  if (!provider.enabled || provider.status === "disabled") {
    return { headline: "Disabled", detail: provider.message ?? "This provider is installed but disabled for new sessions in R3 Code." };
  }
  if (!provider.installed) return { headline: "Not found", detail: provider.message ?? "CLI not detected on PATH." };
  if (provider.auth.status === "unauthenticated") {
    const label = provider.auth.label ?? provider.auth.type;
    return { headline: label ? `Not authenticated · ${label}` : "Not authenticated", detail: provider.message };
  }
  if (antigravitySignInUnchecked(provider)) return { headline: "Installed · Sign-in not checked", detail: provider.message };
  if (provider.status === "warning") {
    return { headline: "Needs attention", detail: provider.message ?? "The provider is installed, but the server could not fully verify it." };
  }
  if (provider.status === "error") return { headline: "Unavailable", detail: provider.message ?? "The provider failed its startup checks." };
  if (provider.auth.status === "authenticated") {
    const label = provider.auth.label ?? provider.auth.type;
    return { headline: label ? `Authenticated · ${label}` : "Authenticated", detail: provider.message };
  }
  return { headline: "Available", detail: provider.message };
}

export function versionLabel(version: string | null | undefined): string | null {
  if (!version) return null;
  const agy = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (agy) return `${agy[1]}-${agy[2]}-${agy[3]}${agy[4] ? ` ${agy[4]}` : ""}`;
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES: Record<string, string> = { graceful: "Limited support", unsupported: "Unsupported version", broken: "Known broken version" };

export interface AdvisoryPresentation {
  title: string; detail: string; updateCommand: string | null; emphasis: "normal" | "strong"; targetVersion: string | null;
}
export function versionAdvisoryPresentation(advisory: VersionAdvisory | null, compat: CompatibilityAdvisory | null, showCompatibility = true): AdvisoryPresentation | null {
  const latestIncompatible = compat?.latestVersionStatus === "broken" || compat?.latestVersionStatus === "unsupported";
  if (showCompatibility && compat && (compat.status === "graceful" || compat.status === "unsupported" || compat.status === "broken")) {
    const target = compat.recommendedVersion;
    const recommendation = versionLabel(target) ?? compat.recommendedRange;
    const alreadyLatest = advisory?.status === "current";
    return {
      title: COMPATIBILITY_TITLES[compat.status] ?? "Update available",
      detail: compat.message ?? (recommendation ? `Use ${recommendation} for full support.` : "Update for full support."),
      updateCommand: target || latestIncompatible || alreadyLatest ? null : advisory?.updateCommand ?? null,
      emphasis: compat.status === "graceful" ? "normal" : "strong", targetVersion: target,
    };
  }
  if (!advisory || advisory.status === "current" || advisory.status === "unknown" || latestIncompatible) return null;
  const label = "Update available";
  const latest = versionLabel(advisory.latestVersion);
  return {
    title: label, detail: advisory.message ?? (latest ? `${label}: install ${latest}.` : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand, emphasis: "normal", targetVersion: null,
  };
}

/** "Checked 5m ago" as the web's relative-time label; null when nothing was checked. */
export function checkedLabel(providers: ProviderView[], now = Date.now()): string | null {
  let latest = 0;
  let any = false;
  for (const provider of providers) if (provider.checkedAt) { any = true; latest = Math.max(latest, Date.parse(provider.checkedAt) || 0); }
  // ProviderLastChecked: a check time that does not parse reads "Checked unavailable" (ProviderSettingsPanel.tsx:194).
  if (!latest) return any ? "Checked unavailable" : null;
  const seconds = Math.max(0, Math.floor((now - latest) / 1000));
  // formatRelativeElapsed: under a minute is "just now", then whole minutes, hours and days.
  if (seconds < 60) return "Checked just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Checked ${hours}h ago` : `Checked ${Math.floor(hours / 24)}d ago`;
}

/** The same label split as the web's ProviderLastChecked: "Checked <5m> ago" (value in mono tabular-nums) or "Checked just now". */
export function checkedParts(providers: ProviderView[], now = Date.now()): { value: string; suffix: string } | null {
  const label = checkedLabel(providers, now);
  if (label === null) return null;
  const rest = label.slice("Checked ".length);
  return rest.endsWith(" ago") ? { value: rest.slice(0, -" ago".length), suffix: "ago" } : { value: rest, suffix: "" };
}

// ---- instances (settings.providerInstances) ----

export interface InstanceConfig {
  driver: string; displayName?: string; accentColor?: string; environment?: EnvVar[]; enabled?: boolean; config?: unknown;
}
export interface EnvVar { name: string; value: unknown; sensitive: boolean; valueRedacted?: boolean; secret?: unknown }

export function parseInstances(value: unknown): Record<string, InstanceConfig> {
  const out: Record<string, InstanceConfig> = {};
  for (const [id, raw] of Object.entries(rec(value) ?? {})) {
    const item = rec(raw);
    if (item && typeof item.driver === "string") out[id] = item as unknown as InstanceConfig;
  }
  return out;
}

function configEnabledFlag(config: unknown): boolean | undefined {
  const enabled = rec(config)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}
export function resolveInstanceEnabled(instance: { driver: string; enabled?: boolean; config?: unknown }): boolean {
  const configEnabled = configEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) return false;
  return instance.enabled ?? configEnabled ?? driverMeta(instance.driver)?.defaultEnabled ?? true;
}

export interface InstanceRow { instanceId: string; driver: string; explicit: InstanceConfig | undefined; isDefault: boolean; isDirty: boolean }

/** The list's rows, in the web panel's order: each driver's default slot, then its other instances. */
export function buildRows(instances: Record<string, InstanceConfig>, live: ProviderView[]): InstanceRow[] {
  const visible = DRIVERS.filter((meta) => meta.driver !== "cursor" || live.some((provider) => provider.instanceId === "cursor"));
  const byDriver = new Map<string, [string, InstanceConfig][]>();
  for (const [id, instance] of Object.entries(instances)) {
    const list = byDriver.get(instance.driver) ?? [];
    list.push([id, instance]);
    byDriver.set(instance.driver, list);
  }
  const defaultIds = new Set(visible.map((meta) => meta.driver));
  const visibleDrivers = new Set(visible.map((meta) => meta.driver));
  const rows: InstanceRow[] = [];
  for (const meta of visible) {
    const explicit = instances[meta.driver];
    const isDirty = explicit !== undefined;
    const hasDefaultSlot = meta.hasDefaultInstance || isDirty;
    if (hasDefaultSlot && (meta.driver === "codex" || meta.driver === "claudeAgent" || isDirty || resolveInstanceEnabled(explicit ?? { driver: meta.driver }))) {
      rows.push({ instanceId: meta.driver, driver: meta.driver, explicit, isDefault: true, isDirty });
    }
    for (const [id, instance] of byDriver.get(meta.driver) ?? []) {
      if (id !== meta.driver) rows.push({ instanceId: id, driver: instance.driver, explicit: instance, isDefault: false, isDirty: false });
    }
  }
  for (const [driver, list] of byDriver) {
    if (visibleDrivers.has(driver)) continue;
    for (const [id, instance] of list) rows.push({ instanceId: id, driver: instance.driver, explicit: instance, isDefault: defaultIds.has(id), isDirty: false });
  }
  return rows;
}

/** A row whose settings are absent still lists when the server reports a live provider for it. */
export function mergeLiveOnlyRows(rows: InstanceRow[], live: ProviderView[]): InstanceRow[] {
  const known = new Set(rows.map((row) => row.instanceId));
  const extra = live.filter((provider) => !known.has(provider.instanceId))
    .map((provider): InstanceRow => ({ instanceId: provider.instanceId, driver: provider.driver, explicit: undefined, isDefault: provider.instanceId === provider.driver, isDirty: false }));
  return [...rows, ...extra];
}

export function displayName(instance: { driver: string; displayName?: string | undefined }, fallbackLabel?: string): string {
  return instance.displayName?.trim() || fallbackLabel || driverMeta(instance.driver)?.label || instance.driver;
}

export function normalizeAccentColor(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}
export function accentForeground(color: string): string {
  const hex = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111111" : "#ffffff";
}
export function instanceInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

// ---- config blob edits (ProviderSettingsForm.nextProviderConfigWithFieldValue) ----

export function nextConfigWithField(config: unknown, field: Pick<DriverField, "key" | "clearWhenEmpty">, value: string): Rec | undefined {
  const base: Rec = { ...(rec(config) ?? {}) };
  const trimmed = value.trim();
  if (field.clearWhenEmpty === "omit" && trimmed.length === 0) delete base[field.key];
  else base[field.key] = value;
  return Object.keys(base).length > 0 ? base : undefined;
}
export function readConfigString(config: unknown, key: string): string {
  const value = rec(config)?.[key];
  return typeof value === "string" ? value : "";
}
/** Secrets arrive redacted: a non-empty saved value means "configured", never the value itself. */
export function secretConfigured(config: unknown, key: string): boolean {
  const value = rec(config)?.[key];
  return (typeof value === "string" && value.length > 0) || rec(value) !== null;
}

// ---- environment variables ----

export const ENV_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export function envVariable(environment: EnvVar[] | undefined, name: string): EnvVar | undefined {
  return environment?.find((variable) => variable.name === name);
}
export function envWithoutNames(environment: EnvVar[] | undefined, names: ReadonlySet<string>): EnvVar[] {
  return (environment ?? []).filter((variable) => !names.has(variable.name));
}
export function nextEnvWithFieldValue(environment: EnvVar[] | undefined, field: DriverEnvField, value: string): EnvVar[] {
  const trimmed = value.trim();
  const next: EnvVar[] = [];
  let found = false;
  for (const variable of environment ?? []) {
    if (variable.name !== field.name) { next.push(variable); continue; }
    found = true;
    if (trimmed.length > 0) next.push({ name: variable.name, value: trimmed, sensitive: field.sensitive ?? true });
  }
  if (!found && trimmed.length > 0) next.push({ name: field.name, value: trimmed, sensitive: field.sensitive ?? true });
  return next;
}
/** ProviderInstanceCard.tsx: a sensitive variable's value may be a secret reference instead of a literal. */
export function nextEnvWithFieldSecret(environment: EnvVar[] | undefined, field: DriverEnvField, secret: { provider: string; reference: string }): EnvVar[] {
  const rest = (environment ?? []).filter((variable) => variable.name !== field.name);
  return [...rest, { name: field.name, value: secret, sensitive: true }];
}
export function cleanEnvironment(environment: EnvVar[]): EnvVar[] {
  return environment.filter((variable) => variable.name.trim().length > 0);
}

// ---- models (ProviderModelsSection) ----

export interface CustomModel { slug: string; name: string; capabilities: unknown }
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export function normalizeSlug(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}
export function readCustomModels(value: unknown): CustomModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CustomModel[] = [];
  for (const raw of value) {
    const item = typeof raw === "string" ? { slug: raw } : rec(raw);
    if (!item) continue;
    const slug = normalizeSlug(typeof item.slug === "string" ? item.slug : null);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name: (typeof item.name === "string" ? normalizeSlug(item.name) : null) ?? slug, capabilities: item.capabilities ?? null });
  }
  return out;
}
export function toCustomModelSetting(entry: CustomModel): unknown {
  const name = entry.name !== entry.slug ? entry.name : undefined;
  const hasCaps = entry.capabilities !== null && entry.capabilities !== undefined;
  if (!name && !hasCaps) return entry.slug;
  return { slug: entry.slug, ...(name ? { name } : {}), ...(hasCaps ? { capabilities: entry.capabilities } : {}) };
}

/** Live models without the custom ones the server echoes, then the saved custom models. */
export function modelsForDisplay(live: ProviderModelView[] | undefined, custom: CustomModel[]): ProviderModelView[] {
  const server = (live ?? []).filter((model) => !model.isCustom);
  const serverSlugs = new Set(server.map((model) => model.slug));
  const liveCustom = new Map((live ?? []).filter((model) => model.isCustom).map((model) => [model.slug, model]));
  return [...server, ...custom.filter((entry) => !serverSlugs.has(entry.slug)).map((entry): ProviderModelView => ({
    slug: entry.slug, name: entry.name, isCustom: true, isDefault: false, descriptors: liveCustom.get(entry.slug)?.descriptors ?? [], hasCapabilities: false,
  }))];
}

export type ModelGroup = "favorite" | "visible" | "hidden";
export interface DisplayOptions { favorites: ReadonlySet<string>; hidden: ReadonlySet<string>; order: readonly string[] }

function sortByOrder<T extends { slug: string }>(models: readonly T[], order: readonly string[]): T[] {
  const index = new Map(order.map((slug, position) => [slug, position]));
  return models.map((model, position) => ({ model, position })).sort((a, b) => {
    const ai = index.get(a.model.slug) ?? order.length;
    const bi = index.get(b.model.slug) ?? order.length;
    return ai - bi || a.position - b.position;
  }).map((entry) => entry.model);
}
export function groupOf(model: { slug: string; isCustom: boolean }, options: DisplayOptions): ModelGroup {
  return options.favorites.has(model.slug) ? "favorite" : !model.isCustom && options.hidden.has(model.slug) ? "hidden" : "visible";
}
export function groupModels<T extends { slug: string; isCustom: boolean }>(models: readonly T[], options: DisplayOptions): T[] {
  const ordered = sortByOrder(models, options.order);
  return [
    ...ordered.filter((model) => groupOf(model, options) === "favorite"),
    ...ordered.filter((model) => groupOf(model, options) === "visible"),
    ...ordered.filter((model) => groupOf(model, options) === "hidden"),
  ];
}
export function bulkHiddenModels(models: readonly { slug: string; isCustom: boolean }[], hidden: readonly string[]): string[] {
  const builtIn = models.filter((model) => !model.isCustom).map((model) => model.slug);
  const set = new Set(builtIn);
  return builtIn.every((slug) => hidden.includes(slug)) ? hidden.filter((slug) => !set.has(slug)) : [...new Set([...hidden, ...builtIn])];
}
/** Which of a model's capabilities the row labels: only fast mode and, when others have it, missing reasoning. */
export function capabilityLabels(model: ProviderModelView, flagMissingReasoning: boolean): string[] {
  const labels: string[] = [];
  const fast = model.descriptors.some((d) => d.id === "fastMode" || (d.id === "serviceTier" && d.type === "select" && Array.isArray(d.options) &&
    d.options.some((o) => { const option = rec(o); return option?.id === "fast" || option?.label === "Fast"; })));
  if (fast) labels.push("Fast mode");
  if (flagMissingReasoning && !model.isCustom && model.hasCapabilities && !["default", "auto"].includes(model.slug) && !hasReasoning(model)) labels.push("No reasoning");
  return labels;
}
const REASONING_IDS = new Set(["reasoningEffort", "effort", "reasoning", "variant", "reasoning_effort", "thinking_level", "thinking"]);
export function hasReasoning(model: ProviderModelView): boolean {
  return model.descriptors.some((d) => (d.type === "select" && d.role === "reasoning") || (typeof d.id === "string" && REASONING_IDS.has(d.id)));
}

/** Validation for Add custom model; returns the error text or null. */
export function validateCustomModel(input: string, models: ProviderModelView[], custom: CustomModel[]): string | null {
  const slug = normalizeSlug(input);
  if (!slug) return "Enter a model slug.";
  if (models.some((model) => !model.isCustom && model.slug === slug)) return "That model is already built in.";
  if (slug.length > MAX_CUSTOM_MODEL_LENGTH) return `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`;
  if (custom.some((entry) => entry.slug === slug)) return "That custom model is already saved.";
  return null;
}

// ---- add provider wizard ----

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}
function slugifyLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}
export function deriveInstanceId(driver: string, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}
export function deriveAvailableInstanceId(derive: (label: string) => string, label: string, existing: ReadonlySet<string>): string {
  const base = derive(label);
  if (!base || !existing.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const text = `_${suffix}`;
    const candidate = `${base.slice(0, 64 - text.length)}${text}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export const WIZARD_STEPS = ["Provider", "Identity", "Config"] as const;
export type WizardNavigation = { kind: "navigate"; step: number } | { kind: "blocked"; step: number; error: string };
export function resolveWizardNavigation(current: number, requested: number, stepCount: number, validation: { instanceIdError: string | null; identityStep?: number }): WizardNavigation {
  const last = Math.max(0, stepCount - 1);
  const target = Math.max(0, Math.min(last, requested));
  const identity = validation.identityStep ?? 1;
  if (current <= identity && target > identity && validation.instanceIdError !== null) {
    return { kind: "blocked", step: Math.min(identity, last), error: validation.instanceIdError };
  }
  return { kind: "navigate", step: target };
}

/** The instance a wizard saves: Codex starts in "existing" setup mode, as the web dialog does. */
export function buildNewInstance(input: { driver: string; label: string; accentColor: string; config: Rec }): InstanceConfig {
  const config = input.driver === "codex" ? { ...input.config, setupMode: "existing" } : input.config;
  const accent = normalizeAccentColor(input.accentColor);
  return {
    driver: input.driver, enabled: true,
    ...(input.label.trim() ? { displayName: input.label.trim() } : {}),
    ...(accent ? { accentColor: accent } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export const ACCENT_PALETTE = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];

export type { DriverMeta };

// ---- authentication terminal output ----

/** Plain text of a PTY stream: escapes dropped, carriage returns collapsed to their last write. */
export function stripTerminalEscapes(output: string): string {
  const plain = output
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?<>=!]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[=>78MD]/g, "");
  return plain.split("\n").map((line) => {
    const parts = line.split("\r").filter((part) => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : "";
  }).join("\n");
}

/** A byte-size label for install progress: 40 MB of 100 MB. */
export function megabytes(bytes: number): string { return (bytes / 1_000_000).toFixed(1); }

/** isProviderUpdateCandidate: enabled, behind a latest version the compatibility check does not rule out. */
function isUpdateCandidate(provider: ProviderView): boolean {
  return provider.enabled && provider.compatibilityAdvisory?.latestVersionStatus !== "broken" && provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported"
    && provider.versionAdvisory?.status === "behind_latest" && provider.versionAdvisory.latestVersion !== null;
}
/** collectProviderUpdateCandidates: one representative per driver, preferring the default instance, else the latest checked. */
function collectUpdateCandidates(providers: ProviderView[]): ProviderView[] {
  const byDriver = new Map<string, ProviderView>();
  for (const provider of providers.filter(isUpdateCandidate)) {
    const current = byDriver.get(provider.driver);
    if (!current) { byDriver.set(provider.driver, provider); continue; }
    if (provider.instanceId === provider.driver) byDriver.set(provider.driver, provider);
    else if (current.instanceId !== current.driver && (provider.checkedAt ?? "").localeCompare(current.checkedAt ?? "") >= 0) byDriver.set(provider.driver, provider);
  }
  return [...byDriver.values()];
}
/** hasOneClickUpdateProviderCandidate: every behind instance of the driver updates with the same command. */
function hasOneClickUpdate(candidate: ProviderView, providers: ProviderView[]): boolean {
  if (candidate.versionAdvisory?.canUpdate !== true || candidate.versionAdvisory.updateCommand === null) return false;
  const commands = new Set<string>();
  for (const provider of providers.filter((item) => item.driver === candidate.driver)) {
    if (!isUpdateCandidate(provider)) continue;
    const advisory = provider.versionAdvisory;
    if (!advisory || advisory.canUpdate !== true || advisory.updateCommand === null) return false;
    commands.add(advisory.updateCommand);
  }
  return commands.size === 1;
}
/** What Update all would run: one idle provider per driver that can update in place (canOneClickUpdateProviderCandidate). */
export function updateCandidates(providers: ProviderView[]): ProviderView[] {
  return collectUpdateCandidates(providers).filter((candidate) => !isUpdateActive(candidate) && hasOneClickUpdate(candidate, providers));
}

export interface UpdateRun { machineLabel: string; driver: string; instanceId: string; outcome: { kind: "interrupted" } | { kind: "result"; failure: string | null } }
/** getProviderUpdateRunToastView: the one summary the web shows once every update settles, or null when none finished. */
export function updateRunSummary(runs: UpdateRun[], nameOf: (driver: string) => string): { type: "success" | "error"; title: string; description: string } | null {
  const settled = runs.filter((run) => run.outcome.kind !== "interrupted");
  if (settled.length === 0) return null;
  const failures = settled.flatMap((run) => run.outcome.kind === "result" && run.outcome.failure !== null ? [`${run.machineLabel} · ${nameOf(run.driver)}: ${run.outcome.failure}`] : []);
  if (failures.length === 0) return { type: "success", title: settled.length === 1 ? "Provider updated" : `${settled.length} providers updated`, description: settled.length === 1 ? "New sessions will use the updated provider." : "New sessions will use the updated providers." };
  return { type: "error",
    title: failures.length < settled.length ? `${failures.length} of ${settled.length} provider updates failed` : settled.length === 1 ? "Provider update failed" : "Provider updates failed",
    description: failures.join("\n") };
}
export function isUpdateActive(provider: ProviderView | undefined): boolean {
  return provider?.updateState?.status === "queued" || provider?.updateState?.status === "running";
}

/** DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection: what turning off the selected provider falls back to. */
export const DEFAULT_TEXT_GENERATION_SELECTION = { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] };

/** updateInstance's shouldClearTextGen: switching off the provider text generation currently points at resets that selection. */
export function textGenerationPatchOnDisable(settings: Record<string, unknown>, instanceId: string, previous: InstanceConfig, next: InstanceConfig): Record<string, unknown> | undefined {
  const isDisabling = next.enabled === false && resolveInstanceEnabled(previous);
  if (!isDisabling) return undefined;
  const selected = rec(settings.textGenerationModelSelection)?.instanceId;
  return (typeof selected === "string" ? selected : DEFAULT_TEXT_GENERATION_SELECTION.instanceId) === instanceId ? { textGenerationModelSelection: DEFAULT_TEXT_GENERATION_SELECTION } : undefined;
}

/** deleteInstance's follow-up: the managed ACP agent whose binary the server may now uninstall, or null for a local or non-ACP instance. */
export function acpManagedAgentId(instance: InstanceConfig): string | null {
  if (instance.driver !== "acpRegistry") return null;
  if (readConfigString(instance.config, "source") === "local") return null;
  return readConfigString(instance.config, "agentId").trim() || null;
}

/** buildProviderInstanceOverridePatch (ProviderSettingsPanel.logic.ts): the projectSettingsOverrides patch that sets, or with
 * undefined clears, one instance's enablement for each project; an entry left empty is removed (null). */
export function buildProviderInstanceOverridePatch(settings: Record<string, unknown>, projectIds: readonly string[], instanceId: string, value: boolean | undefined): Record<string, unknown> {
  const all = (settings.projectSettingsOverrides && typeof settings.projectSettingsOverrides === "object" ? settings.projectSettingsOverrides : {}) as Record<string, Record<string, unknown> | undefined>;
  const patch: Record<string, unknown> = {};
  for (const projectId of projectIds) {
    const current = all[projectId];
    const instances = { ...((current?.providerInstances ?? {}) as Record<string, Record<string, unknown>>) };
    const instance = { ...instances[instanceId] };
    if (value === undefined) delete instance.enabled; else instance.enabled = value;
    if (Object.keys(instance).length > 0) instances[instanceId] = instance; else delete instances[instanceId];
    const { providerInstances: _omit, ...rest } = current ?? {};
    patch[projectId] = Object.keys(rest).length === 0 && Object.keys(instances).length === 0 ? null : { ...rest, providerInstances: instances };
  }
  return patch;
}

/** The project's own enablement of an instance (projectSettingsOverrides[project].providerInstances[id].enabled), if set. */
export function projectProviderOverride(settings: Record<string, unknown>, projectId: string, instanceId: string): boolean | undefined {
  const all = settings.projectSettingsOverrides as Record<string, { providerInstances?: Record<string, { enabled?: unknown }> } | undefined> | undefined;
  const value = all?.[projectId]?.providerInstances?.[instanceId]?.enabled;
  return typeof value === "boolean" ? value : undefined;
}
