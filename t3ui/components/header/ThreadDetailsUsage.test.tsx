import { expect, open, test } from "nsh/test";
import { compactionMessage, contextRowModel } from "./ThreadDetailsUsage";

test("usage rows read as room left and the context row as room used", async () => {
  const app = await open("./ThreadDetailsUsageFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.waitFor("label:5 hour: 75% left");
  await expect(app.shows("label:Weekly: 5% left")).toBe(true);
  await expect(app.shows("label:Context: 85% used")).toBe(true);
  await expect(app.texts()).toContain("85k / 100k");
});

test("the context row's tone, tick and tooltip lines", () => {
  const base = { updatedAt: "", promptCacheTtlMs: null };
  expect(contextRowModel({ ...base, usedTokens: 95_000, maxTokens: 100_000 }).tone).toBe("error");
  expect(contextRowModel({ ...base, usedTokens: 85_000, maxTokens: 100_000 }).tone).toBe("warning");
  expect(contextRowModel({ ...base, usedTokens: 10_000, maxTokens: 100_000, autoCompactThreshold: 80_000 }).tick).toBe(80);
  const unknown = contextRowModel({ ...base, usedTokens: 1_500, maxTokens: null });
  expect(unknown.used).toBe(null);
  expect(unknown.ariaValue).toBe("1.5k tokens used");
  // ThreadDetailsContext adds the compaction line only when a threshold is known.
  expect(unknown.lines.some((line) => line.includes("ompacts"))).toBe(false);
  expect(contextRowModel({ ...base, usedTokens: 10_000, maxTokens: 100_000, autoCompactThreshold: 80_000 }).lines.at(-1)).toBe("Compacts automatically at about 80,000 tokens.");
  expect(compactionMessage(null)).toBe("Context compacts automatically when needed.");
  expect(compactionMessage(80000)).toBe("Compacts automatically at about 80,000 tokens.");
});
