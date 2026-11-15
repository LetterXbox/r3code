import { expect, test } from "nsh/test";
import {
  chartSeries, formatPercent, formatResetsIn, formatTokens, formatUsd, modelTotals, paceOf, providerTotals, remainingPercent, sumTotals,
} from "./usageFormat";
import { parseUsage } from "../../pages/utility-data";

const usage = parseUsage({
  buckets: [
    { day: "2026-11-10", provider: "claude", model: "a", costUsd: 3, cacheSavingsUsd: 0, sessions: 1, totals: { uncachedInputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 90 } },
    { day: "2026-11-11", provider: "codex", model: "b", costUsd: 1, cacheSavingsUsd: 0, sessions: 1, totals: { uncachedInputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 } },
  ],
  sources: [], pricing: { status: "fresh" },
});

test("number formats match the web", () => {
  expect(formatUsd(1234.5)).toBe("$1,234.50");
  expect(formatTokens(1_500_000)).toBe("1.50M");
  expect(formatTokens(950)).toBe("950");
  expect(formatPercent(0.4567)).toBe("45.7%");
  expect(formatPercent(0.00001)).toBe("<0.1%");
});

test("providers and models are ranked by the chosen metric with shares", () => {
  const providers = providerTotals(usage.buckets, {});
  expect(providers.map((p) => p.provider)).toEqual(["codex", "claude"]);
  expect(providers.find((p) => p.provider === "claude")?.costShare).toBe(0.75);
  expect(providers.find((p) => p.provider === "codex")?.tokenShare).toBe(0.5);
  expect(modelTotals(usage.buckets, "cost")[0].model).toBe("a");
  expect(sumTotals(usage.buckets).total).toBe(200);
});

test("the chart has one column per day of the window, zero filled", () => {
  const series = chartSeries(usage.buckets, "2026-11-09", "2026-11-11", false);
  expect(series.map((s) => s.key)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
  expect(series[0].costUsd).toBe(0);
  expect(series[1].byProvider.claude.costUsd).toBe(3);
});

test("limit windows report what is left, the reset time and the pace", () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0);
  const window = { id: "w", label: "Weekly", usedPercent: 60, resetsAt: new Date(now + 3 * 86_400_000 + 5 * 3_600_000).toISOString(), windowDurationMins: 7 * 1440 };
  expect(remainingPercent(window)).toBe(40);
  expect(formatResetsIn(window, now)).toBe("resets in 3d 5h");
  expect(paceOf(window, now)).toBe("ahead");
  expect(formatResetsIn({ resetsAt: new Date(now - 1).toISOString() }, now)).toBe("resets now");
});


import { paceMark } from "./usagePools";

test("the pace mark sits at the time left, a 6pt slot is cut around it, and a bar under 6pt draws neither", () => {
  expect(paceMark(null, 300)).toBeNull();
  expect(paceMark(50, 5)).toBeNull();
  const mid = paceMark(50, 300)!;
  expect(mid.tick).toBe(150);
  expect(mid.mask).toBe("linear-gradient(to right, black 147px, transparent 147px, transparent 153px, black 153px)");
  // The tick keeps 3pt inside either end so the slot never leaves the bar.
  expect(paceMark(0, 300)!.tick).toBe(3);
  expect(paceMark(100, 300)!.tick).toBe(297);
});
