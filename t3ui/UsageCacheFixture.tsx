// The Usage page in the full app, used to prove the shared cache (usageCache.ts): reopening the page, or
// switching Cost/Tokens, must not ask the server again inside the staleness window. Each call to
// server.getUsageSummary answers with a strictly higher cost than the last, so a second call (a refetch) is
// visible in the page's own numbers without any extra instrumentation.
import "./PaletteLiveSeed";
import { setBackendStatusForTest } from "./store";
import { setUsageRequestForTest } from "./components/usage/usageEnvironments";
import "./App";

const PRIMARY = "ws://test.invalid/ws";
const day = new Date().toISOString().slice(0, 10);

const summary = (costUsd: number) => ({
  buckets: [{ day, provider: "claude", model: "claude-live", costUsd, cacheSavingsUsd: 0, sessions: 1, unpricedRecords: 0, totals: { uncachedInputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 500 } }],
  sources: [{ fingerprint: { provider: "claude" }, distinctSessions: 1, status: "ok" }],
  pricing: { status: "fresh" },
});

let summaryCalls = 0;
let ratesRefreshed = false;
setUsageRequestForTest(async (_id, method) => {
  if (method === "server.refreshProviders") return { providers: [] };
  // An explicit refresh asks for fresh usage rates first (client-runtime refreshUsage); the next summary must follow it.
  if (method === "server.refreshUsageRates") { ratesRefreshed = true; return {}; }
  if (summaryCalls > 0 && !ratesRefreshed) throw new Error("summary re-read without refreshing usage rates");
  summaryCalls++;
  return summary(summaryCalls);
});
setBackendStatusForTest("connected", PRIMARY);
