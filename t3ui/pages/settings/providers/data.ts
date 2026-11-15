// The provider panel's data boundary. The panel only ever talks to a ProviderApi, so the
// fixtures can stand in for a server and the live implementation can be the store's.
import { Clipboard, effect, openUrl, signal } from "nsh";
import {
  allProjects, backendError, backendStatus, cancelProviderAuth, cancelProviderInstall, completeProviderAuth, localCachedProviders, localProviderCacheLoaded,
  logoutProvider, openSettings, removeProviderAuthMethod, removeProviderInstall, requestBackend, respondProviderAuth,
  backendBearer, backendUrl, settingsOpen, startProviderAuth, startProviderInstall, onServerConfigEvent, subscribeProviderAuth, subscribeProviderInstall, usageEnvironments,
} from "../../../store";
import type {
  BackendStatus, ProviderAuthResponse, ProviderAuthStartOptions, ProviderAuthState, ProviderInstallState,
} from "../../../store";
import { fetchSessionGrant, sessionGrantsProvidersManage } from "../../../backend/providers";
import { buildUsageEnvironmentList, savedUsageEnvironments, savedUsageStatuses } from "../../../components/usage/usageEnvironments";
import { parseAcpProviders, parseAcpSessions, parseAcpImport, type AcpConfigurableProvider, type AcpProject, type AcpSession } from "./acpSessions";
import { parseManagedPolicy, type ManagedPolicySummary } from "./policyLogic";
import { serverEnvironment } from "../settingsState";
import { scopeProjectId, scopeSavedEnvironmentId } from "../scopeState";
import { environmentConfigs } from "../../../environments/connectionManager";
import { scopedProviderSetup } from "./scopedSetup";
import { fromCached, parseInstances, parseProvider, rec, type InstanceConfig, type ProviderView, type UpdateState } from "./logic";

export interface ModelPrefs { hiddenModels: string[]; modelOrder: string[] }
export interface Favorite { provider: string; model: string }

export type InstanceMutation =
  | { operation: "create" | "upsert"; instanceId: string; instance: InstanceConfig }
  | { operation: "remove"; instanceId: string };

export interface SettingsPatch {
  setModelFavorites?: { provider: string; model: string; favorite: boolean }[];
  setModelsHidden?: { provider: string; model: string; hidden: boolean }[];
  setProviderModelOrder?: { provider: string; modelOrder: string[] };
}

export interface ProviderSetupApi {
  subscribeAuth(instanceId: string, onState: (state: ProviderAuthState) => void, onError: (error: Error) => void): () => void;
  subscribeInstall(instanceId: string, onState: (state: ProviderInstallState) => void, onError: (error: Error) => void): () => void;
  startAuth(instanceId: string, options?: ProviderAuthStartOptions): Promise<ProviderAuthState>;
  respondAuth(instanceId: string, flowId: string, interactionId: string, response: ProviderAuthResponse): Promise<ProviderAuthState>;
  completeAuth(instanceId: string, flowId: string, callbackUrl: string): Promise<ProviderAuthState>;
  cancelAuth(instanceId: string, flowId: string): Promise<ProviderAuthState>;
  logout(instanceId: string): Promise<ProviderAuthState>;
  removeAuthMethod(instanceId: string, methodId: string): Promise<ProviderAuthState>;
  startInstall(instanceId: string): Promise<ProviderInstallState>;
  cancelInstall(instanceId: string, operationId: string): Promise<ProviderInstallState>;
  removeInstall(instanceId: string): Promise<ProviderInstallState>;
}

/** The ACP agent session and provider RPCs (server.*AcpRegistry*), scoped to one project. */
export interface AcpManagementApi {
  projects(): AcpProject[];
  listSessions(input: { instanceId: string; projectId: string; cursor?: string }): Promise<{ sessions: AcpSession[]; nextCursor: string | null }>;
  importSession(input: { instanceId: string; projectId: string; sessionId: string; title: string | null; updatedAt: string | null }): Promise<{ threadId: string; imported: boolean }>;
  deleteSession(input: { instanceId: string; projectId: string; sessionId: string }): Promise<void>;
  listProviders(input: { instanceId: string; projectId: string }): Promise<AcpConfigurableProvider[]>;
  setProvider(input: { instanceId: string; projectId: string; providerId: string; apiType: string; baseUrl: string; headers?: Record<string, string> }): Promise<void>;
  disableProvider(input: { instanceId: string; projectId: string; providerId: string }): Promise<void>;
  logout(instanceId: string): Promise<void>;
}

/** A device tab: the primary connection first, then the saved environments (buildProviderEnvironmentOptions). */
export interface ProviderDevice { id: string; label: string; detail: string; primary: boolean; phase: "connected" | "checking" | "failed" | "off"; error?: string }

export interface ProviderApi {
  status(): BackendStatus;
  /** The devices whose providers can be configured; with one primary device the panel shows no tabs. */
  devices?(): ProviderDevice[];
  /** Whether the session holds providers:manage; null while that is being read, undefined where permissions do not apply. */
  canManage?(): boolean | null;
  /** The project whose provider enablement the page edits (a project scope on a server with projectProviderInstanceOverrides), else null. */
  projectScope?(): string | null;
  error(): string | null;
  environmentLabel(): string;
  /** Connected and the first provider snapshot and settings have arrived. */
  live(): boolean;
  loaded(): boolean;
  providers(): ProviderView[];
  cached(): ProviderView[];
  cachedLoaded(): boolean;
  instances(): Record<string, InstanceConfig>;
  modelPrefs(): Record<string, ModelPrefs>;
  favorites(): Favorite[];
  /** `server.updateSettings` with the instance mutation, plus an optional settings patch applied in the same write. */
  mutate(mutation: InstanceMutation, patch?: Record<string, unknown>): Promise<void>;
  patch(patch: SettingsPatch): Promise<void>;
  /** The raw server settings last received (background activity, usage sources, text generation). */
  settings(): Record<string, unknown>;
  /** The administrator policy the environment reports, or undefined when it is unmanaged. */
  managedPolicy(): ManagedPolicySummary | undefined;
  /** A raw `server.updateSettings` patch, for the settings sections below the provider list. */
  updateSettings(patch: Record<string, unknown>): Promise<void>;
  refresh(): Promise<void>;
  /** `server.listTextGeneratorModels`: the models a text generator's API lists, optionally checking unsaved settings, skipping the cache or testing a model. */
  listTextGeneratorModels(input: { id: string; config?: unknown; refresh?: boolean; test?: boolean; model?: string }): Promise<{ models: { id: string; name: string }[] }>;
  /** `server.refreshProviders` for one instance, as the ChatGPT setup does once a sign-in finishes. */
  refreshInstance(instanceId: string): Promise<void>;
  /** `server.updateProvider`: resolves with the instance's final update state from the returned snapshot. */
  updateProvider(input: { driver: string; instanceId: string; targetVersion?: string }): Promise<UpdateState | null>;
  /** false when the server no longer holds the request (it expired). */
  acceptUrlAuth(instanceId: string, elicitationId: string): Promise<boolean | void>;
  /** `server.uninstallAcpRegistryManagedBinary`: the server decides whether the agent is still in use. */
  uninstallAcpManagedBinary?(agentId: string): Promise<void>;
  /** `server.searchAcpRegistry`: the registry's agents matching a query (all of them, up to the cap, when empty). */
  searchAcpRegistry(query: string): Promise<unknown>;
  /** `server.prepareAcpRegistryAgent`: download or resolve an agent so an instance can start it. */
  prepareAcpRegistryAgent(agentId: string): Promise<unknown>;
  setup: ProviderSetupApi;
  /** Absent where the environment cannot manage ACP agent sessions. */
  acp?: AcpManagementApi;
  openConnections(): void;
  openExternal(url: string): void;
  /** openExternal that reports whether the browser opened (ProviderAuthenticationSection's sign-in page). */
  openExternalChecked?(url: string): Promise<boolean>;
  copy(text: string): void;
}

// ---- live implementation ----

const liveProviders = signal<ProviderView[]>([]);
const liveInstances = signal<Record<string, InstanceConfig>>({});
const livePrefs = signal<Record<string, ModelPrefs>>({});
const liveFavorites = signal<Favorite[]>([]);
const configLoaded = signal(false);
const settingsLoaded = signal(false);
const liveSettings = signal<Record<string, unknown>>({});
const liveManagedPolicy = signal<ManagedPolicySummary | undefined>(undefined);

function readPrefs(value: unknown): Record<string, ModelPrefs> {
  const out: Record<string, ModelPrefs> = {};
  for (const [id, raw] of Object.entries(rec(value) ?? {})) {
    const item = rec(raw);
    if (!item) continue;
    const list = (entry: unknown) => Array.isArray(entry) ? entry.filter((slug): slug is string => typeof slug === "string") : [];
    out[id] = { hiddenModels: list(item.hiddenModels), modelOrder: list(item.modelOrder) };
  }
  return out;
}
function readFavorites(value: unknown): Favorite[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const item = rec(entry);
    return item && typeof item.provider === "string" && typeof item.model === "string" ? [{ provider: item.provider, model: item.model }] : [];
  }) : [];
}
function applySettings(value: unknown): void {
  const settings = rec(value);
  if (!settings) return;
  // providerInstances carries a decoding default on the server, so an unconfigured server may omit it.
  liveSettings.set(settings);
  liveInstances.set(parseInstances(settings.providerInstances ?? {}));
  livePrefs.set(readPrefs(settings.providerModelPreferences));
  liveFavorites.set(readFavorites(settings.favorites));
  settingsLoaded.set(true);
}
function applyProviders(value: unknown): void {
  if (!Array.isArray(value)) return;
  liveProviders.set(value.flatMap((entry) => { const provider = parseProvider(entry); return provider ? [provider] : []; }));
  configLoaded.set(true);
}
/** Feeds one `subscribeServerConfig` event into the panel's state. */
export function applyConfigEvent(value: unknown): void {
  const event = rec(value);
  if (!event) return;
  const config = event.type === "snapshot" ? rec(event.config) : rec(event.payload);
  if (!config) return;
  applyProviders(config.providers);
  applySettings(config.settings);
  if (event.type === "snapshot" || "managedPolicy" in config) liveManagedPolicy.set(parseManagedPolicy(config.managedPolicy));
}
export function resetLiveProviderState(): void {
  liveProviders.set([]); liveInstances.set({}); livePrefs.set({}); liveFavorites.set([]); liveSettings.set({}); liveManagedPolicy.set(undefined); configLoaded.set(false); settingsLoaded.set(false);
}

/** Subscribes to the connected environment's config while the settings are open; call from a component. */
export function useProviderConfigStream(): void {
  effect(() => {
    if (!settingsOpen() || backendStatus() !== "connected") return;
    let stopped = false;
    // The store's one config stream (one per environment, as rpc/session.ts); a late reader gets its projection replayed.
    const stop = onServerConfigEvent((value) => { if (!stopped) applyConfigEvent(value); });
    return () => { stopped = true; stop(); };
  });
  effect(() => { if (backendStatus() !== "connected") resetLiveProviderState(); });
  useSessionAccess();
}

const manageAccess = signal<boolean | null>(null);

/** The provider the model picker's "Open provider setup" names: the panel selects it when Settings > Providers shows. */
const setupTarget = signal<string | null>(null);
export const requestProviderSelection = (instanceId: string | null) => setupTarget.set(instanceId);
export const providerSelectionRequest = () => setupTarget();

/** Reads this session's grant while connected (the web's useEnvironmentSessionState). */
function useSessionAccess(): void {
  effect(() => {
    if (backendStatus() !== "connected") { manageAccess.set(null); return; }
    const url = backendUrl(); const bearer = backendBearer();
    if (!url || !bearer) { manageAccess.set(true); return; }
    let stopped = false;
    manageAccess.set(null);
    void fetchSessionGrant(url, bearer).then((grant) => { if (!stopped) manageAccess.set(grant === null ? false : sessionGrantsProvidersManage(grant)); }, () => { if (!stopped) manageAccess.set(false); });
    return () => { stopped = true; };
  });
}

/** providerEnvironmentDetail for a saved environment: "Local device" for one on this machine (a loopback address,
 * the web's isDesktopLocalConnectionTarget), else its address, else "Remote device". The primary one is "Primary device". */
export function savedDeviceDetail(url: string | undefined): string {
  if (!url) return "Remote device";
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "Local device";
  } catch { /* not a URL: show it as written */ }
  return url;
}

export function liveDevices(): ProviderDevice[] {
  const entries = buildUsageEnvironmentList({ primary: { id: backendUrl() || "local", label: usageEnvironments()[0]?.label ?? "This device", connected: backendStatus() === "connected" }, saved: savedUsageEnvironments(), statuses: savedUsageStatuses() });
  const statuses = savedUsageStatuses();
  const saved = savedUsageEnvironments();
  return entries.map((entry, index) => {
    if (index === 0) return { id: entry.id, label: entry.label, detail: "Primary device", primary: true, phase: backendStatus() === "connected" ? "connected" : backendStatus() === "error" ? "failed" : "checking" };
    const status = statuses[entry.id];
    return { id: entry.id, label: entry.label, detail: savedDeviceDetail(saved.find((item) => item.id === entry.id)?.url), primary: false, phase: status?.phase ?? "checking", ...(status?.error ? { error: status.error } : {}) };
  });
}

export const liveProviderApi: ProviderApi = {
  devices: liveDevices,
  canManage: () => manageAccess(),
  projectScope: () => (serverEnvironment()?.capabilities as { projectProviderInstanceOverrides?: unknown } | undefined)?.projectProviderInstanceOverrides === true ? scopeProjectId() : null,
  status: () => backendStatus(),
  error: () => backendError(),
  environmentLabel: () => usageEnvironments()[0]?.label ?? "this environment",
  live: () => backendStatus() === "connected" && configLoaded() && settingsLoaded(),
  loaded: () => configLoaded() && settingsLoaded(),
  // The settings scope's saved environment shows its own provider statuses (its config stream keeps them current),
  // matching the setup calls scopedSetup.ts sends there.
  providers: () => {
    const scoped = scopeSavedEnvironmentId();
    if (!scoped) return liveProviders();
    const list = environmentConfigs()[scoped]?.providers;
    return Array.isArray(list) ? list.flatMap((entry) => { const provider = parseProvider(entry); return provider ? [provider] : []; }) : [];
  },
  cached: () => localCachedProviders().map(fromCached),
  cachedLoaded: () => localProviderCacheLoaded(),
  instances: () => liveInstances(),
  modelPrefs: () => livePrefs(),
  favorites: () => liveFavorites(),
  async mutate(mutation, patch) {
    const result = await requestBackend("server.updateSettings", { patch: patch ?? {}, providerInstanceMutation: mutation });
    applySettings(result);
  },
  async patch(patch) {
    const result = await requestBackend("server.updateSettings", { patch });
    applySettings(result);
  },
  settings: () => liveSettings(),
  managedPolicy: () => liveManagedPolicy(),
  async updateSettings(patch) {
    const result = await requestBackend("server.updateSettings", { patch });
    applySettings(result);
  },
  async refresh() {
    let result: unknown;
    try { result = await requestBackend("server.refreshProviders", { refreshModels: true, reloadSecrets: true }, { timeoutMs: 60000 }); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      throw new Error(message.startsWith("Request timed out") ? "Provider refresh timed out. Try again." : message === "Connect an environment first" ? message : "Could not refresh providers. Try again.");
    }
    applyProviders(rec(result)?.providers);
  },
  async listTextGeneratorModels(input) {
    const result = rec(await requestBackend("server.listTextGeneratorModels", input, { timeoutMs: 60000 }));
    const models = Array.isArray(result?.models) ? result.models.flatMap((entry: unknown) => { const item = rec(entry); return item && typeof item.id === "string" ? [{ id: item.id, name: typeof item.name === "string" ? item.name : item.id }] : []; }) : [];
    return { models };
  },
  async refreshInstance(instanceId) {
    const result = await requestBackend("server.refreshProviders", { instanceId }, { timeoutMs: 60000 });
    applyProviders(rec(result)?.providers);
  },
  async updateProvider(input) {
    const result = await requestBackend("server.updateProvider", {
      provider: input.driver, instanceId: input.instanceId, ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
    }, { timeoutMs: 600000 });
    const providers = rec(result)?.providers;
    applyProviders(providers);
    const found = Array.isArray(providers) ? providers.map(parseProvider).find((provider) => provider?.instanceId === input.instanceId) : undefined;
    return found?.updateState ?? null;
  },
  async acceptUrlAuth(instanceId, elicitationId) {
    const result = await requestBackend("server.acceptAcpRegistryUrlAuth", { instanceId, elicitationId }) as { accepted?: unknown } | null;
    return result?.accepted !== false;
  },
  async uninstallAcpManagedBinary(agentId) {
    await requestBackend("server.uninstallAcpRegistryManagedBinary", { agentId }, { timeoutMs: 60000 });
  },
  searchAcpRegistry(query) {
    return requestBackend("server.searchAcpRegistry", query ? { query } : { query: "", limit: 50 }, { timeoutMs: 60000 });
  },
  prepareAcpRegistryAgent(agentId) {
    return requestBackend("server.prepareAcpRegistryAgent", { agentId }, { timeoutMs: 600000 });
  },
  acp: {
    projects: () => allProjects().map((project) => ({ id: project.id, title: project.name, workspaceRoot: project.path ?? "" })),
    async listSessions(input) { return parseAcpSessions(await requestBackend("server.listAcpRegistrySessions", input, { timeoutMs: 60000 })); },
    async importSession(input) { return parseAcpImport(await requestBackend("server.importAcpRegistrySession", input, { timeoutMs: 60000 })); },
    async deleteSession(input) { await requestBackend("server.deleteAcpRegistrySession", input, { timeoutMs: 60000 }); },
    async listProviders(input) { return parseAcpProviders(await requestBackend("server.listAcpRegistryProviders", input, { timeoutMs: 60000 })); },
    async setProvider(input) { await requestBackend("server.setAcpRegistryProvider", input, { timeoutMs: 60000 }); },
    async disableProvider(input) { await requestBackend("server.disableAcpRegistryProvider", input, { timeoutMs: 60000 }); },
    async logout(instanceId) { await requestBackend("server.logoutAcpRegistry", { instanceId }, { timeoutMs: 60000 }); },
  },
  // scopedSetup.ts: setup follows the settings scope (a selected saved environment), as CodexSetupSection's environmentId.
  setup: scopedProviderSetup({
    subscribeAuth: subscribeProviderAuth,
    subscribeInstall: subscribeProviderInstall,
    startAuth: startProviderAuth,
    respondAuth: respondProviderAuth,
    completeAuth: completeProviderAuth,
    cancelAuth: cancelProviderAuth,
    logout: logoutProvider,
    removeAuthMethod: removeProviderAuthMethod,
    startInstall: startProviderInstall,
    cancelInstall: cancelProviderInstall,
    removeInstall: removeProviderInstall,
  }),
  openConnections: () => openSettings("/settings/connections"),
  openExternal: (url) => { void openUrl(url).catch(() => {}); },
  openExternalChecked: (url) => openUrl(url).then((opened: unknown) => opened !== false && !(typeof opened === "object" && opened !== null && (opened as { opened?: unknown }).opened === false), () => false),
  copy: (text) => { void Clipboard.writeText(text).catch(() => {}); },
};
