// The Usage page in the full app on a connected environment with contract-shaped answers: the primary reads at once, one saved
// environment is unreachable (its session never opens) and one is slow. Nothing may wait on the slow or the dead one.
import "./PaletteLiveSeed";
import { setBackendStatusForTest } from "./store";
import { environmentStatuses, savedEnvironments } from "./pages/settings/environments/savedEnvironments";
import { setUsageRequestForTest, resetLimitsRefreshForTest } from "./components/usage/usageEnvironments";
import "./App";

const PRIMARY = "ws://test.invalid/ws";
const SLOW_MS = 1500;
const day = new Date().toISOString().slice(0, 10);

const summary = (provider: string, model: string, costUsd: number) => ({
  buckets: [{
    day, provider, model, costUsd, cacheSavingsUsd: 0, sessions: 1, unpricedRecords: 0,
    totals: { uncachedInputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 500 },
  }],
  sources: [{ fingerprint: { provider }, distinctSessions: 1, status: "ok" }],
  pricing: { status: "fresh" },
});

const limitsReply = (instanceId: string, driver: string, displayName: string, usedPercent: number) => ({
  providers: [{
    instanceId, driver, displayName, enabled: true, installed: true, status: "ready", availability: "available", models: [], slashCommands: [], skills: [],
    usageLimits: { checkedAt: new Date().toISOString(), windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent }] },
  }],
});

resetLimitsRefreshForTest();
savedEnvironments.set([
  { id: "saved:dead", label: "dead.host", url: "ws://dead.invalid/ws", enabled: true, addedAt: 0 },
  { id: "saved:slow", label: "slow.host", url: "ws://slow.invalid/ws", enabled: true, addedAt: 0 },
]);
environmentStatuses.set({ "saved:dead": { phase: "connected" }, "saved:slow": { phase: "connected" } });
setUsageRequestForTest(async (id, method) => {
  if (id === "saved:dead") throw new Error("The environment did not respond.");
  if (id === "saved:slow") {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return method === "server.refreshProviders" ? limitsReply("slow-codex", "codex", "SlowCodex", 10) : summary("codex", "gpt-slow", 2);
  }
  // The primary never answers a provider refresh (a live server probing providers): the page must not wait for it.
  if (method === "server.refreshProviders") return new Promise(() => undefined);
  return summary("claude", "claude-live", 3);
});
setBackendStatusForTest("connected", PRIMARY);
