import { mount, Scroll, signal, Text, View } from "nsh";
import { ToastHost } from "../../components/toast";
import { ProviderPanel } from "./providers/ProviderPanel";
import type { InstanceMutation, ProviderApi, ProviderDevice, SettingsPatch } from "./providers/data";
import { fromCached, parseInstances, parseProvider, type CachedProviderLike, type ProviderView } from "./providers/logic";
import type { ManagedPolicySummary } from "./providers/policyLogic";
import type { BackendStatus, ProviderAuthState, ProviderInstallState } from "../../store";

const model = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({ slug, name, isCustom: false, capabilities: null, ...extra });
const reasoning = { optionDescriptors: [{ id: "reasoningEffort", type: "select", label: "Reasoning", options: [{ id: "high", label: "High" }] }] };

const rawProviders: unknown[] = [
  { instanceId: "codex", driver: "codex", enabled: true, installed: true, version: "1.2.3", status: "ready", checkedAt: "2026-11-11T14:30:00Z",
    auth: { status: "authenticated", label: "ChatGPT Plus", email: "dev@example.com", canLogout: true }, setup: { canAuthenticate: true, canInstall: false },
    versionAdvisory: { status: "behind_latest", currentVersion: "1.2.3", latestVersion: "1.3.0", updateCommand: "npm i -g @openai/codex", canUpdate: true, checkedAt: null, message: null },
    models: [model("gpt-5", "GPT-5", { capabilities: reasoning }), model("gpt-5-mini", "GPT-5 Mini", { capabilities: reasoning }), model("gpt-4o", "GPT-4o", { capabilities: { optionDescriptors: [] } })] },
  { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, installed: true, version: "2.0.0", status: "warning", message: "Run claude login", checkedAt: "2026-11-11T14:29:00Z",
    auth: { status: "unauthenticated", label: "Subscription" }, setup: { canAuthenticate: true, canInstall: true }, models: [model("sonnet", "Claude Sonnet")] },
  { instanceId: "cursor", driver: "cursor", enabled: false, installed: false, version: null, status: "warning", message: "CLI not found", checkedAt: null, auth: { status: "unknown" }, setup: { canAuthenticate: true, canInstall: false }, models: [] },
  { instanceId: "antigravity", driver: "antigravity", enabled: false, installed: false, version: null, status: "warning", message: "Not installed", checkedAt: null, auth: { status: "unknown" }, setup: { canAuthenticate: true, canInstall: true }, models: [] },
  { instanceId: "codex_work", driver: "codex", displayName: "ChatGPT - Work", enabled: true, installed: true, version: "1.2.3", status: "warning", message: "Sign in", checkedAt: null, auth: { status: "unauthenticated" }, setup: { canAuthenticate: true, canInstall: true },
    runtimePaths: { homePath: "/Users/dev/.codex", shadowHomePath: "/Users/dev/.t3/codex/work" }, models: [] },
  { instanceId: "acp_hopper", driver: "acpRegistry", displayName: "Hopper", enabled: true, installed: true, version: "2.0.1", status: "ready", checkedAt: "2026-11-11T14:28:00Z", auth: { status: "authenticated", canLogout: true },
    setup: { canAuthenticate: false, canInstall: false }, nativeSessions: { canList: true, canLoad: true, canResume: false, canDelete: true }, configurableProviders: true, models: [] },
  { instanceId: "opencode_zen", driver: "opencode", displayName: "Zen", enabled: true, installed: true, version: "0.5.0", status: "error", message: "Server unreachable", checkedAt: null, auth: { status: "unknown" }, models: [] },
];
const rawInstances = {
  claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/usr/bin/claude" } },
  cursor: { driver: "cursor", enabled: false },
  antigravity: { driver: "antigravity", enabled: false },
  codex_work: { driver: "codex", displayName: "ChatGPT - Work", enabled: true, config: { enabled: true, setupMode: "managed" } },
  acp_hopper: { driver: "acpRegistry", displayName: "Hopper", enabled: true, config: { source: "registry", agentId: "hopper" } },
  opencode_zen: { driver: "opencode", displayName: "Zen", enabled: true, environment: [{ name: "FOO", value: "bar", sensitive: false }] },
};

const cachedFixture: CachedProviderLike[] = [
  { instanceId: "codex", driver: "codex", name: "Codex", enabled: true, installed: true, available: true, status: "ready", authStatus: "authenticated", authLabel: "ChatGPT Plus", version: "1.2.3",
    unavailableReason: null, message: null, checkedAt: "2026-11-11T14:30:00Z", canInstall: false, canAuthenticate: true, models: [{ id: "gpt-5", name: "GPT-5" }] },
];

const status = signal<BackendStatus>("connected");
const providers = signal<ProviderView[]>(rawProviders.flatMap((raw) => { const parsed = parseProvider(raw); return parsed ? [parsed] : []; }));
const instances = signal(parseInstances(rawInstances));
const prefs = signal<Record<string, { hiddenModels: string[]; modelOrder: string[] }>>({});
const favorites = signal<{ provider: string; model: string }[]>([]);
const settings = signal<Record<string, unknown>>({ usageLimitSources: { hub1: { kind: "cliproxy", url: "https://hub.test", label: "Home hub", enabled: true } }, textGenerators: { openai: { kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1", apiKey: "", enabled: true } } });
const calls = signal<string[]>([]);
const managed = signal<ManagedPolicySummary | undefined>(undefined);
const updateOutcome = signal<"succeeded" | "failed">("succeeded");
const failNext = signal(false);
const connectionsOpened = signal(0);
const copied = signal("");
let authListener: ((state: ProviderAuthState) => void) | null = null;
let authInstance = "claudeAgent";
let savedProfile = false;
let installListener: ((state: ProviderInstallState) => void) | null = null;

const authState = (phase: ProviderAuthState["phase"], interaction: ProviderAuthState["interaction"] = null, instanceId = "claudeAgent"): ProviderAuthState => instanceId === "codex_work" ? ({
  instanceId, phase, flowId: phase === "idle" ? null : "flow-9", authorizationUrl: interaction?.type === "browser" ? interaction.url : null, expiresAt: null, message: null,
  methods: savedProfile ? [{ id: "chatgpt", name: "ChatGPT", description: null, type: "agent", accountEmail: "work@example.com" }, { id: "chatgpt-profile:abc", name: "work@example.com", description: null, type: "agent", canRemove: true }] : [{ id: "chatgpt", name: "ChatGPT", description: null, type: "agent" }], interaction,
}) : ({
  instanceId, phase, flowId: phase === "idle" ? null : "flow-1", authorizationUrl: null, expiresAt: null, message: null,
  methods: [{ id: "m1", name: "Console", description: null, type: "agent" }, { id: "m2", name: "Subscription", description: null, type: "terminal" }], interaction,
});
const chatGptBrowser = { type: "browser" as const, id: "b1", url: "https://auth.openai.test/authorize", requiresConsent: false, acceptsCallback: true };
const installState = (phase: ProviderInstallState["phase"], downloaded = 0): ProviderInstallState => ({
  driver: "claudeAgent", operationId: phase === "idle" ? null : "install-1", phase, downloadedBytes: downloaded, totalBytes: 100_000_000, version: "2.1.0", installedVersion: "2.0.0", canRemove: true, message: null,
});
const log = (line: string) => calls.update((all) => [...all, line]);

const devices = signal<ProviderDevice[]>([{ id: "primary", label: "Fixture host", detail: "Primary device", primary: true, phase: "connected" }]);
const canManage = signal<boolean | null>(true);
const projectScope = signal<string | null>(null);
const api: ProviderApi = {
  devices: () => devices(),
  canManage: () => canManage(),
  projectScope: () => projectScope(),
  status: () => status(),
  error: () => null,
  environmentLabel: () => "Fixture host",
  live: () => status() === "connected",
  loaded: () => true,
  providers: () => providers(),
  cached: () => cachedFixture.map(fromCached),
  cachedLoaded: () => true,
  instances: () => instances(),
  modelPrefs: () => prefs(),
  favorites: () => favorites(),
  async mutate(mutation: InstanceMutation, extra?: Record<string, unknown>) {
    if (failNext()) { failNext.set(false); throw new Error("Settings permission denied"); }
    log(`mutate ${mutation.operation} ${mutation.instanceId} ${JSON.stringify("instance" in mutation ? mutation.instance : {})}`);
    if (extra && Object.keys(extra).length > 0) log(`mutate patch ${JSON.stringify(extra)}`);
    instances.update((all) => {
      const copy = { ...all };
      if (mutation.operation === "remove") delete copy[mutation.instanceId]; else copy[mutation.instanceId] = mutation.instance;
      return copy;
    });
    if (mutation.operation === "create") providers.update((all) => [...all, { ...(parseProvider({ instanceId: mutation.instanceId, driver: mutation.instance.driver, enabled: true, installed: false, version: null, status: "warning", auth: { status: "unknown" }, models: [] }) as ProviderView) }]);
    if (mutation.operation !== "remove") providers.update((all) => all.map((provider) => provider.instanceId === mutation.instanceId ? { ...provider, enabled: mutation.instance.enabled ?? provider.enabled } : provider));
  },
  async patch(patch: SettingsPatch) {
    if (failNext()) { failNext.set(false); throw new Error("Settings permission denied"); }
    log(`patch ${JSON.stringify(patch)}`);
    for (const entry of patch.setModelsHidden ?? []) prefs.update((all) => {
      const current = all[entry.provider] ?? { hiddenModels: [], modelOrder: [] };
      const hidden = entry.hidden ? [...new Set([...current.hiddenModels, entry.model])] : current.hiddenModels.filter((slug) => slug !== entry.model);
      return { ...all, [entry.provider]: { ...current, hiddenModels: hidden } };
    });
    for (const entry of patch.setModelFavorites ?? []) favorites.update((all) => entry.favorite ? [...all, { provider: entry.provider, model: entry.model }] : all.filter((item) => !(item.provider === entry.provider && item.model === entry.model)));
    if (patch.setProviderModelOrder) prefs.update((all) => ({ ...all, [patch.setProviderModelOrder?.provider as string]: { hiddenModels: all[patch.setProviderModelOrder?.provider as string]?.hiddenModels ?? [], modelOrder: patch.setProviderModelOrder?.modelOrder ?? [] } }));
  },
  settings: () => settings(),
  managedPolicy: () => managed(),
  async listTextGeneratorModels(input) {
    log(`textgen ${input.id}${input.refresh ? " refresh" : ""}${input.test ? ` test ${input.model}` : ""}${input.config ? " config" : ""}`);
    if (input.refresh && failNext()) { failNext.set(false); throw new Error("429 Too Many Requests"); }
    if (input.config && (input.config as { apiKey?: string }).apiKey === "bad") throw new Error("401 Unauthorized");
    if (input.test && input.model === "broken") throw new Error("Model broken did not answer");
    const all = Array.from({ length: input.id === "many" ? 12 : 3 }, (_, index) => ({ id: `model-${index + 1}`, name: index === 0 ? "Model One" : `model-${index + 1}` }));
    return { models: all };
  },
  async refreshInstance(instanceId) { log(`refresh ${instanceId}`); },
  async updateSettings(patch) { log(`settings ${JSON.stringify(patch)}`); settings.update((all) => {
    const next: Record<string, unknown> = { ...all, ...patch };
    // The server merges these maps by id and drops an id sent as null.
    for (const key of ["usageLimitSources", "textGenerators"]) {
      if (!(key in patch)) continue;
      const merged = { ...((all[key] as Record<string, unknown>) ?? {}), ...(patch[key] as Record<string, unknown>) };
      for (const id of Object.keys(merged)) if (merged[id] === null) delete merged[id];
      next[key] = merged;
    }
    return next;
  }); },
  async refresh() { log("refresh"); },
  async updateProvider(input) { log(`update ${input.driver} ${input.instanceId} ${input.targetVersion ?? ""}`.trim()); if (failNext()) { failNext.set(false); throw new Error("spawn npm ENOENT"); } return updateOutcome() === "failed" ? { status: "failed", message: "npm exited with 1", output: null } : { status: "succeeded", message: null, output: null }; },
  async acceptUrlAuth() {},
  async uninstallAcpManagedBinary(agentId) { log(`acp.uninstall ${agentId}`); if (failNext()) { failNext.set(false); throw new Error("binary is in use"); } },
  acp: {
    projects: () => [{ id: "p1", title: "legion", workspaceRoot: "/work/legion" }, { id: "p2", title: "docs", workspaceRoot: "/work/docs" }],
    async listSessions(input) {
      log(`acp.sessions ${input.projectId}${input.cursor ? ` cursor ${input.cursor}` : ""}`);
      return input.cursor === undefined
        ? { sessions: [{ sessionId: "s-1", cwd: "/work/legion", title: "Fix flaky test", updatedAt: null, importedThreadId: null }, { sessionId: "s-2", cwd: "/work/legion", title: null, updatedAt: null, importedThreadId: "thread-9" }], nextCursor: "c2" }
        : { sessions: [{ sessionId: "s-3", cwd: "/work/legion", title: "Third", updatedAt: null, importedThreadId: null }], nextCursor: null };
    },
    async importSession(input) { log(`acp.import ${input.sessionId}`); return { threadId: "thread-new", imported: true }; },
    async deleteSession(input) { log(`acp.delete ${input.sessionId}`); },
    async listProviders(input) { log(`acp.providers ${input.projectId}`); return [{ providerId: "openrouter", supported: ["openai", "anthropic"], required: false, current: { apiType: "openai", baseUrl: "https://openrouter.ai/api" } }]; },
    async setProvider(input) { log(`acp.set ${input.providerId} ${input.apiType} ${input.baseUrl} ${input.headers ? JSON.stringify(input.headers) : ""}`.trim()); },
    async disableProvider(input) { log(`acp.disable ${input.providerId}`); },
    async logout(instanceId) { log(`acp.logout ${instanceId}`); },
  },
  async searchAcpRegistry(query) {
    log(`acp.search ${query}`);
    const all = [
      { id: "devin", name: "Devin", version: "1.4.0", description: "Cognition's software agent", website: "https://devin.ai", repository: null, icon: null, distribution: "npx" },
      { id: "codex-acp", name: "Codex ACP", version: "0.2.0", description: "Already a built-in provider", website: null, repository: null, icon: null, distribution: "binary" },
      { id: "goose", name: "Goose", version: "2.0.1", description: "An on-machine agent", website: null, repository: "https://github.com/block/goose", icon: null, distribution: "binary" },
    ];
    return { agents: all.filter((agent) => !query || agent.name.toLowerCase().includes(query.toLowerCase())) };
  },
  async prepareAcpRegistryAgent(agentId) { log(`acp.prepare ${agentId}`); return { agentId, version: "1.4.1", distribution: "npx", prepared: true }; },
  setup: {
    subscribeAuth(id, onState) { authListener = onState; authInstance = id; onState(authState("idle", null, id)); return () => { authListener = null; }; },
    subscribeInstall(_id, onState) { installListener = onState; onState(installState("idle")); return () => { installListener = null; }; },
    async startAuth(id, options) {
      log(`auth.start ${options?.methodId ?? ""}${options?.callbackMode ? ` ${options.callbackMode}` : ""}`.trim());
      if (id === "codex_work") return authState("waiting", chatGptBrowser, id);
      return authState("waiting", { type: "terminal", id: "i1", output: "Open https://login.example and enter the code\r\n" });
    },
    async respondAuth(_id, _flow, _interaction, response) { log(`auth.respond ${JSON.stringify(response)}`); return authState("waiting", { type: "terminal", id: "i1", output: "Open https://login.example and enter the code\r\n" }); },
    async completeAuth(id, _flow, callbackUrl) { log(`auth.complete ${callbackUrl}`); return authState("succeeded", null, id); },
    async cancelAuth(id) { log("auth.cancel"); return authState("cancelled", null, id); },
    async logout() { log("auth.logout"); return authState("idle"); },
    async removeAuthMethod(id, methodId) { log(`auth.remove ${methodId}`); return authState("idle", null, id); },
    async startInstall() { log("install.start"); return installState("downloading", 40_000_000); },
    async cancelInstall(_id, operationId) { log(`install.cancel ${operationId}`); return installState("cancelled"); },
    async removeInstall() { log("install.remove"); return installState("idle"); },
  },
  openConnections: () => connectionsOpened.update((count) => count + 1),
  openExternal: (url) => log(`open ${url}`),
  copy: (text) => copied.set(text),
};

const press = (label: string, action: () => void) => <View accessibilityLabel={label} onPress={action}><Text>{label}</Text></View>;

mount(() => <View class="flex-1 flex-row">
  <View class="w-56 gap-1 p-2">
    {press("Disconnect fixture", () => status.set("disconnected"))}
    {press("Reconnect fixture", () => status.set("connected"))}
    {press("Fail next write", () => failNext.set(true))}
    {press("Remove Zen", () => instances.update((all) => { const copy = { ...all }; delete copy.opencode_zen; return copy; }))}
    {press("Save ChatGPT profile", () => { savedProfile = true; })}
    {press("Add remote device", () => devices.update((all) => [...all, { id: "remote", label: "Build box", detail: "wss://build.example/ws", primary: false, phase: "failed", error: "Pairing expired. Add the environment again." }]))}
    {press("Limit permissions", () => canManage.set(false))}
    {press("Check permissions", () => canManage.set(null))}
    {press("Scope to project", () => projectScope.set("project:1"))}
    {press("Grant permissions", () => canManage.set(true))}
    {press("Drop remote device", () => devices.update((all) => all.filter((device) => device.id !== "remote")))}
    {press("Fail updates", () => updateOutcome.set("failed"))}
    {press("Set managed policy", () => managed.set({ organization: "Acme", supportUrl: "https://acme.test/help", lockedSettings: [], limits: { providers: { allowedDrivers: ["codex", "claudeAgent", "opencode"], lockedInstanceFields: { codex: ["config.binaryPath", "environment.OPENAI_API_KEY"], opencode: ["environment"] } } } }))}
    {press("Push signed in codex", () => providers.update((all) => all.map((provider) => provider.instanceId === "codex_work" ? { ...provider, auth: { ...provider.auth, status: "authenticated", email: "work@example.com", subscriptionSharing: true } } : provider)))}
    {press("Push auth succeeded", () => authListener?.(authState("succeeded", null, authInstance)))}
    {press("Push terminal output", () => authListener?.(authState("waiting", { type: "terminal", id: "i1", output: "Open https://login.example and enter the code\r\nCode accepted\r\n" })))}
    {press("Push install progress", () => installListener?.(installState("downloading", 55_000_000)))}
    {press("Push device code", () => authListener?.(authState("waiting", { type: "deviceCode", id: "i2", url: "https://login.example/device", userCode: "ABCD-1234" })))}
    {press("Push credentials prompt", () => authListener?.(authState("waiting", { type: "credentials", id: "i3", fields: [{ name: "key", label: "API key", secret: true }] })))}
    {press("Push signed in", () => providers.update((all) => all.map((provider) => provider.instanceId === "claudeAgent" ? { ...provider, auth: { ...provider.auth, status: "authenticated", email: "me@example.com" }, status: "ready", message: null } : provider)))}
    {press("Push update running", () => providers.update((all) => all.map((provider) => provider.instanceId === "codex" ? { ...provider, updateState: { status: "running", message: "Downloading 1.3.0", output: null } } : provider)))}
    {press("Push update failed", () => providers.update((all) => all.map((provider) => provider.instanceId === "codex" ? { ...provider, updateState: { status: "failed", message: "npm exited with 1", output: null } } : provider)))}
    <Text testID="connections-opened">{`connections ${connectionsOpened()}`}</Text>
    <Text testID="copied">{`copied ${copied()}`}</Text>
    <Each of={calls()} key={(line, index) => `${index}:${line}`}>{(line) => <Text>{line()}</Text>}</Each>
  </View>
  <Scroll class="flex-1"><View class="p-4"><ProviderPanel api={api} /></View></Scroll>
  <ToastHost />
</View>);
