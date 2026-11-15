// Fed with payloads shaped exactly like packages/contracts' ServerConfigStreamEvent (server.ts) and
// ServerProvider: nothing here is a hand-built view model.
import { expect, test } from "nsh/test";
import { acpManagedAgentId, buildRows, checkedLabel, providerSummary, statusKey, textGenerationPatchOnDisable, versionAdvisoryPresentation, versionLabel, type ProviderView } from "./logic";
import { acpSectionCapabilities, parseAcpImport, parseAcpProviders, parseAcpSessions } from "./acpSessions";
import { applyConfigEvent, liveProviderApi, resetLiveProviderState } from "./data";

const NOW = "2026-11-11T14:30:00.000Z";
// A ServerProvider as the server encodes it: every required key present, optional keys absent.
const serverProvider = (over: Record<string, unknown>) => ({
  instanceId: "codex", driver: "codex", enabled: true, installed: true, version: "1.2.3", status: "ready",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Plus", email: "dev@example.com", canLogout: true },
  checkedAt: NOW, models: [], slashCommands: [], skills: [], ...over,
});
const model = (slug: string, name: string, over: Record<string, unknown> = {}) => ({ slug, name, isCustom: false, capabilities: null, ...over });

test("the snapshot event lists providers in the web's driver order whatever order settings arrive in", () => {
  resetLiveProviderState();
  applyConfigEvent({ version: 1, type: "snapshot", config: {
    providers: [serverProvider({ instanceId: "opencode_zen", driver: "opencode", displayName: "Zen" }), serverProvider({ instanceId: "claudeAgent", driver: "claudeAgent", version: "2.0.0" }), serverProvider({})],
    settings: { providerInstances: { opencode_zen: { driver: "opencode", displayName: "Zen", enabled: true }, codex_work: { driver: "codex", displayName: "Work" }, claudeAgent: { driver: "claudeAgent" } } },
  } });
  expect(liveProviderApi.loaded()).toBe(true);
  const rows = buildRows(liveProviderApi.instances(), liveProviderApi.providers());
  expect(rows.map((row) => row.instanceId)).toEqual(["codex", "codex_work", "claudeAgent", "opencode_zen"]);
  expect(rows.filter((row) => row.isDefault).map((row) => row.instanceId)).toEqual(["codex", "claudeAgent"]);
});

test("an unconfigured server may omit providerInstances and the page still loads", () => {
  resetLiveProviderState();
  applyConfigEvent({ version: 1, type: "snapshot", config: { providers: [serverProvider({})], settings: {} } });
  expect(liveProviderApi.loaded()).toBe(true);
  expect(buildRows(liveProviderApi.instances(), liveProviderApi.providers()).map((row) => row.instanceId)).toEqual(["codex", "claudeAgent"]);
});

test("providerStatuses and settingsUpdated events update their own halves", () => {
  resetLiveProviderState();
  applyConfigEvent({ version: 1, type: "snapshot", config: { providers: [serverProvider({})], settings: { providerInstances: {}, providerModelPreferences: {}, favorites: [] } } });
  applyConfigEvent({ version: 1, type: "providerStatuses", payload: { providers: [serverProvider({ version: "1.3.0", status: "warning", message: "Sign in" })] } });
  expect(liveProviderApi.providers()[0]?.version).toBe("1.3.0");
  expect(liveProviderApi.instances()).toEqual({});
  applyConfigEvent({ version: 1, type: "settingsUpdated", payload: { settings: { providerInstances: { codex: { driver: "codex", enabled: false } },
    providerModelPreferences: { codex: { hiddenModels: ["gpt-5-mini"], modelOrder: ["gpt-5"] } }, favorites: [{ provider: "codex", model: "gpt-5" }] } } });
  expect(liveProviderApi.instances().codex?.enabled).toBe(false);
  expect(liveProviderApi.modelPrefs().codex).toEqual({ hiddenModels: ["gpt-5-mini"], modelOrder: ["gpt-5"] });
  expect(liveProviderApi.favorites()).toEqual([{ provider: "codex", model: "gpt-5" }]);
  expect(liveProviderApi.providers()[0]?.version).toBe("1.3.0");
  applyConfigEvent({ version: 1, type: "keybindingsUpdated", payload: { keybindings: [], issues: [] } });
  expect(liveProviderApi.providers().length).toBe(1);
});

test("a ServerProvider reads name, version, auth, message, models and advisories from the right keys", () => {
  resetLiveProviderState();
  applyConfigEvent({ version: 1, type: "snapshot", config: { settings: { providerInstances: {} }, providers: [serverProvider({
    displayName: "Codex Server Name", status: "warning", message: "Rate limited", installedVersion: "1.2.2",
    models: [model("gpt-5", "GPT-5", { isDefault: true, capabilities: { optionDescriptors: [{ id: "reasoningEffort", type: "select", label: "Reasoning", options: [{ id: "high", label: "High" }] }] } }), model("custom-1", "Custom One", { isCustom: true })],
    versionAdvisory: { status: "behind_latest", currentVersion: "1.2.3", latestVersion: "1.3.0", updateCommand: "npm i -g @openai/codex", canUpdate: true, canInstallVersion: true, checkedAt: NOW, message: null },
    compatibilityAdvisory: { status: "supported", message: null, recommendedVersion: null, recommendedRange: null },
    updateState: { status: "failed", startedAt: NOW, finishedAt: NOW, message: "npm exited with 1", output: null },
  })] } });
  const provider = liveProviderApi.providers()[0] as ProviderView;
  expect(provider.displayName).toBe("Codex Server Name");
  expect(versionLabel(provider.version)).toBe("v1.2.3");
  expect(providerSummary(provider)).toEqual({ headline: "Needs attention", detail: "Rate limited" });
  expect(statusKey(provider)).toBe("warning");
  expect(provider.auth).toMatchObject({ status: "authenticated", type: "chatgpt", label: "ChatGPT Plus", email: "dev@example.com", canLogout: true });
  expect(provider.models.map((m) => [m.slug, m.isCustom, m.isDefault, m.descriptors.length])).toEqual([["gpt-5", false, true, 1], ["custom-1", true, false, 0]]);
  expect(versionAdvisoryPresentation(provider.versionAdvisory, provider.compatibilityAdvisory)).toMatchObject({ title: "Update available", updateCommand: "npm i -g @openai/codex", targetVersion: null });
  expect(provider.updateState).toEqual({ status: "failed", message: "npm exited with 1", output: null });
});

test("availability, url auth actions and native session capabilities come through", () => {
  resetLiveProviderState();
  applyConfigEvent({ version: 1, type: "snapshot", config: { settings: { providerInstances: {} }, providers: [serverProvider({
    instanceId: "acp_goose", driver: "acpRegistry", enabled: false, installed: false, availability: "unavailable", unavailableReason: "Binary missing",
    auth: { status: "unauthenticated", action: { url: "https://auth.example/x", message: "Continue in your browser", elicitationId: "e1" }, canLogout: true },
    setup: { canAuthenticate: false, canInstall: false, documentationUrl: "https://docs.example" },
    nativeSessions: { canList: true, canLoad: true, canResume: false }, configurableProviders: true,
  })] } });
  const provider = liveProviderApi.providers()[0] as ProviderView;
  expect(provider.available).toBe(false);
  expect(provider.unavailableReason).toBe("Binary missing");
  expect(provider.auth.action).toEqual({ url: "https://auth.example/x", message: "Continue in your browser", elicitationId: "e1" });
  expect(provider.nativeSessions).toEqual({ canList: true, canLoad: true, canResume: false, canDelete: false });
  expect(acpSectionCapabilities(provider)).toMatchObject({ visible: true, canList: true, canImport: true, canLogout: true, canDelete: false, canConfigureProviders: true });
});

test("the checked label follows the newest checkedAt across providers", () => {
  const now = Date.parse(NOW);
  const rows = [serverProvider({ checkedAt: "2026-11-11T14:00:00.000Z" }), serverProvider({ instanceId: "claudeAgent", driver: "claudeAgent", checkedAt: "2026-11-11T14:26:00.000Z" })];
  resetLiveProviderState();
  applyConfigEvent({ version: 1, type: "snapshot", config: { settings: { providerInstances: {} }, providers: rows } });
  expect(checkedLabel(liveProviderApi.providers(), now)).toBe("Checked 4m ago");
});

test("disabling the provider text generation points at resets that selection to the default", () => {
  const previous = { driver: "codex" };
  expect(textGenerationPatchOnDisable({}, "codex", previous, { driver: "codex", enabled: false })).toEqual({ textGenerationModelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] } });
  expect(textGenerationPatchOnDisable({ textGenerationModelSelection: { instanceId: "claudeAgent", model: "sonnet" } }, "codex", previous, { driver: "codex", enabled: false })).toBeUndefined();
  expect(textGenerationPatchOnDisable({}, "codex", previous, { driver: "codex", enabled: true })).toBeUndefined();
  expect(textGenerationPatchOnDisable({}, "codex", { driver: "codex", enabled: false }, { driver: "codex", enabled: false })).toBeUndefined();
});

test("only a managed ACP instance has an agent binary to uninstall", () => {
  expect(acpManagedAgentId({ driver: "acpRegistry", config: { source: "registry", agentId: " goose " } })).toBe("goose");
  expect(acpManagedAgentId({ driver: "acpRegistry", config: { source: "local", agentId: "goose" } })).toBeNull();
  expect(acpManagedAgentId({ driver: "acpRegistry", config: {} })).toBeNull();
  expect(acpManagedAgentId({ driver: "codex", config: { agentId: "x" } })).toBeNull();
});

test("ACP session, provider and import results parse from the contract shapes", () => {
  expect(parseAcpSessions({ sessions: [{ sessionId: "s1", cwd: "/w", additionalDirectories: [], title: "T", updatedAt: null, importedThreadId: null }, { nope: 1 }], nextCursor: "c", canLoad: true, canResume: false, canDelete: true }))
    .toEqual({ sessions: [{ sessionId: "s1", cwd: "/w", title: "T", updatedAt: null, importedThreadId: null }], nextCursor: "c" });
  expect(parseAcpProviders({ providers: [{ providerId: "or", supported: ["openai"], required: true, current: null }, { providerId: "x", supported: ["a", 1], required: false, current: { apiType: "a", baseUrl: "https://u" } }] }))
    .toEqual([{ providerId: "or", supported: ["openai"], required: true, current: null }, { providerId: "x", supported: ["a"], required: false, current: { apiType: "a", baseUrl: "https://u" } }]);
  expect(parseAcpImport({ threadId: "t1", imported: false })).toEqual({ threadId: "t1", imported: false });
});
