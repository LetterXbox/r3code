// Mounts the Usage tabs on fixed server-shaped data so tests read what the page paints.
import { mount, Scroll, signal, Text, View } from "nsh";
import { parseUsage, parseUsageLimits, parseUsageLimitSources } from "./pages/utility-data";
import { ConfirmDialogHost } from "./components/toast";
import { replaceServerSettings } from "./pages/settings/settingsState";
import { environmentStatuses, savedEnvironments } from "./pages/settings/environments/savedEnvironments";
import { setUsageRequestForTest } from "./components/usage/usageEnvironments";
import { setUsagePriceAccessForTest } from "./components/usage/usagePriceTargets";
import { setBackendStatusForTest } from "./store";
import { UsageLimitsSection } from "./components/usage/UsageLimits";
import { UsageOverview } from "./components/usage/UsageOverview";
import { UsageModelDialog, UsagePriceDialog } from "./components/usage/UsageDialogs";
import { UsageProviderMenu } from "./components/usage/UsageMenus";
import { filterUsageByProviders } from "./components/usage/usageSelection";
import { openUsageDialog, usageHiddenProviders } from "./components/usage/usageState";

const now = Date.UTC(2026, 10, 11, 12, 0, 0);
const result = parseUsage({
  buckets: [
    { day: "2026-11-10", provider: "claude", model: "claude-sonnet", costUsd: 3.5, cacheSavingsUsd: 1.25, sessions: 2, categoryCostUsd: { input: 1, cacheRead: 0.5, cacheWrite: 0.5, output: 1.5 }, totals: { uncachedInputTokens: 1000, cachedInputTokens: 4000, cacheCreationTokens: 500, outputTokens: 2500 } },
    { day: "2026-11-11", provider: "codex", model: "gpt-test", costUsd: 1.5, cacheSavingsUsd: 0, fastCostUsd: 0.6, speedPremiumUsd: 0.25, sessions: 1, totals: { uncachedInputTokens: 2000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 500 } },
  ],
  sources: [
    { fingerprint: { provider: "claude" }, distinctSessions: 2, status: "ok" },
    { fingerprint: { provider: "codex" }, distinctSessions: 1, status: "ok" },
  ],
  pricing: { status: "fresh" },
});
const limits = parseUsageLimits({ providers: [
  { instanceId: "claude-1", driver: "claudeAgent", displayName: "Claude", auth: { status: "authenticated" }, usageLimits: { resetCredits: { availableCount: 2, nextExpiresAt: new Date(now + 3 * 3_600_000).toISOString() }, externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" }, windows: [{ id: "five-hour", label: "Session (5h)", usedPercent: 38, resetsAt: new Date(now + 2 * 3_600_000 + 5 * 60_000).toISOString(), windowDurationMins: 300 }] } },
] });
const win = (id: string, label: string, kind: string, usedPercent: number, hours: number, mins: number) => ({ id, label, kind, usedPercent, resetsAt: new Date(now + hours * 3_600_000).toISOString(), windowDurationMins: mins });
const pooled = parseUsageLimits({ providers: [
  { instanceId: "claude-a", driver: "claudeAgent", displayName: "Claude", auth: { status: "authenticated", email: "ada@example.com", label: "Claude Max" }, usageLimits: { checkedAt: new Date(now).toISOString(), windows: [win("five_hour", "Session (5h)", "session", 30, 2, 300), win("seven_day", "Weekly", "weekly", 100, 20, 10080)] } },
  { instanceId: "claude-b", driver: "claudeAgent", displayName: "Claude Two", auth: { status: "authenticated", email: "bob@example.com" }, usageLimits: { checkedAt: new Date(now).toISOString(), windows: [win("five_hour", "Session (5h)", "session", 60, 1, 300), win("seven_day", "Weekly", "weekly", 20, 50, 10080)] } },
  { instanceId: "grok-1", driver: "grok", displayName: "Grok", auth: { status: "authenticated" }, usageLimits: { checkedAt: new Date(now).toISOString(), unavailable: { reason: "probeFailed" }, windows: [] } },
] }).map((account) => ({ ...account, environmentId: "env-1", environmentLabel: "Fixture host" }));
const hubRaw = [
  { id: "hub1", kind: "cliproxy", label: "Hub One", checkedAt: new Date(now).toISOString(), accounts: [
    { id: "ada.json", driver: "claudeAgent", email: "ada@example.com", plan: "Max", usageLimits: { checkedAt: new Date(now + 1000).toISOString(), resetCredits: { availableCount: 1, nextExpiresAt: new Date(now + 5 * 3_600_000).toISOString(), nextCreditId: "cr1" }, windows: [win("five_hour", "Session (5h)", "session", 30, 2, 300), win("seven_day", "Weekly", "weekly", 100, 20, 10080)] } },
    { id: "zed.json", driver: "claudeAgent", usageLimits: { checkedAt: new Date(now).toISOString(), windows: [win("five_hour", "Session (5h)", "session", 10, 3, 300), win("seven_day", "Weekly", "weekly", 5, 60, 10080)] } },
  ] },
  { id: "hub2", kind: "cliproxy", label: "Hub Two", checkedAt: new Date(now).toISOString(), accounts: [], error: "Management key rejected." },
  { id: "hub3", kind: "cliproxy", label: "Hub Three", checkedAt: new Date(now).toISOString(), accounts: [] },
];
const hub = parseUsageLimitSources(hubRaw).flatMap((source) => source.accounts).map((account) => ({ ...account, environmentId: "env-1", environmentLabel: "Fixture host" }));
const hubSources = parseUsageLimitSources(hubRaw).map((source) => ({ id: source.id, label: source.label, error: source.error, accountCount: source.accounts.length, environmentLabel: "Fixture host" }));
const hubShown = signal(false);

// The live connection and, once added, two saved environments: one that takes writes and one that is read-only.
setBackendStatusForTest("connected");
replaceServerSettings({ usagePriceOverrides: {}, usageModelAliases: {} });
setUsagePriceAccessForTest(async (id) => id !== "saved-ro");
const failBuildSaves = signal(false);
setUsageRequestForTest(async (id, method, payload) => {
  if (method === "server.getConfig") return { settings: { usagePriceOverrides: id === "saved-ro" ? {} : { "gpt-x": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } }, usageModelAliases: {} }, environment: { capabilities: { usageModelAliases: true } } };
  if (method === "server.updateSettings") {
    sentLog.update((all) => [...all, `sent ${id} ${method} ${JSON.stringify(payload)}`]);
    if (id === "saved-1" && failBuildSaves()) throw new Error("offline");
    return { usagePriceOverrides: {}, usageModelAliases: {} };
  }
  return { outcome: "reset" };
});
const pooledShown = signal(false);
export const sent: { method: string; payload: unknown }[] = [];
const sentLog = signal<string[]>([]);
const opened = signal("");
const tab = signal<"cost" | "tokens" | "limits">("cost");
const breakdown = signal<"model" | "time">("model");

mount(() => (
  <Scroll class="flex-1" contentClass="flex-col gap-4 p-4">
    <UsageProviderMenu />
    <View accessibilityLabel="Open prices" onPress={() => openUsageDialog({ kind: "prices" })} class="h-6 w-24"><Text class="text-xs">prices</Text></View>
    <View accessibilityLabel="Show tokens" onPress={() => tab.set("tokens")} class="h-6 w-24"><Text class="text-xs">tokens tab</Text></View>
    <View accessibilityLabel="Pool two accounts" onPress={() => pooledShown.set(true)} class="h-6 w-24"><Text class="text-xs">pool</Text></View>
    <View class="absolute right-0 top-0 w-24 flex-col">
    <View accessibilityLabel="Add saved environments" onPress={() => {
      replaceServerSettings({ usagePriceOverrides: { "gpt-x": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 3 } }, usageModelAliases: {} });
      savedEnvironments.set([{ id: "saved-1", label: "Build box", url: "wss://build/ws", enabled: true, addedAt: 1 }, { id: "saved-ro", label: "Locked box", url: "wss://locked/ws", enabled: true, addedAt: 2 }]);
      environmentStatuses.set({ "saved-1": { phase: "connected" }, "saved-ro": { phase: "connected" } });
    }} class="h-6 w-24"><Text class="text-xs">saved</Text></View>
    <View accessibilityLabel="Fail Build box saves" onPress={() => failBuildSaves.set(!failBuildSaves())} class="h-6 w-24"><Text class="text-xs">failsaves</Text></View>
    </View>
    <View accessibilityLabel="Add hub accounts" onPress={() => { pooledShown.set(true); hubShown.set(true); }} class="h-6 w-24"><Text class="text-xs">hub</Text></View>
    <Each of={sentLog()} key={(line, index) => `${index}:${line}`}>{(line) => <Text class="text-2xs">{line()}</Text>}</Each>
    <ConfirmDialogHost />
    {tab() === "limits"
      ? <UsageLimitsSection accounts={() => pooledShown() ? (hubShown() ? [...pooled, ...hub] : pooled) : limits} sources={() => (hubShown() ? hubSources : [])} now={() => now} request={async (_env, method, payload) => { sent.push({ method, payload }); sentLog.update((all) => [...all, `sent ${method} ${JSON.stringify(payload)}`]); return { outcome: "reset" }; }} openExternal={(url) => opened.set(url)} />
      : <UsageOverview onModel={(provider, model) => openUsageDialog({ kind: "model", provider, model })} result={() => filterUsageByProviders(result, usageHiddenProviders())} metric={() => (tab() === "tokens" ? "tokens" : "cost")} window={() => ({ sinceDay: "2026-11-10", untilDay: "2026-11-11", hourly: false })} breakdown={() => breakdown()} onBreakdown={(next) => breakdown.set(next)} />}
    <View accessibilityLabel="Show limits" onPress={() => tab.set("limits")} class="h-6 w-24"><Text class="text-xs">limits tab</Text></View>
    <Text class="text-2xs">{opened()}</Text>
    <UsageModelDialog result={() => result} metric={() => "cost"} window={() => ({ sinceDay: "2026-11-10", untilDay: "2026-11-11", hourly: false })} />
    <UsagePriceDialog />
  </Scroll>
));
