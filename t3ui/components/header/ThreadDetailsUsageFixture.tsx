import { mount, View } from "nsh";
import { ThreadDetailsContext, ThreadDetailsUsage } from "./ThreadDetailsUsage";
import { parseUsageLimits } from "../composer/usageLimitsLogic";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const limits = parseUsageLimits({
  windows: [
    { id: "five", label: "5 hour", usedPercent: 25, resetsAt: "2026-01-01T02:00:00Z", windowDurationMins: 300 },
    { id: "week", label: "Weekly", usedPercent: 95, resetsAt: "2026-01-04T00:00:00Z", windowDurationMins: 10080 },
  ],
});

mount(() => (
  <View class="w-[280px]">
    <ThreadDetailsUsage limits={() => limits} now={() => NOW} />
    <ThreadDetailsContext usage={() => ({ usedTokens: 85_000, maxTokens: 100_000, updatedAt: "2026-01-01T00:00:00Z", promptCacheTtlMs: null })} />
  </View>
));
