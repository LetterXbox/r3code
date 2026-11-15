import { expect, test } from "nsh/test";
import { parseUsage } from "../../pages/utility-data";
import {
  cacheHitRate, environmentLabel, filterUsageByProviders, mergeUsageResults, parseUsagePriceForm, priceChangesPatch, priceRowsFrom,
  providerFilterLabel, toggleAllEnvironments, toggleEnvironment, toggleProvider, usagePriceForm,
} from "./usageSelection";

const envs = [{ id: "a", label: "Laptop", connected: true }, { id: "b", label: "Server", connected: true }];
const bucket = (provider: string, costUsd: number) => ({
  day: "2026-11-10", provider, model: "m", costUsd, cacheSavingsUsd: 0, sessions: 1,
  totals: { uncachedInputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 10 },
});
const result = (provider: string, costUsd: number) => parseUsage({ buckets: [bucket(provider, costUsd)], sources: [{ fingerprint: { provider }, distinctSessions: 1, status: "ok" }], pricing: { status: "fresh" } });

test("environment selection labels and toggles", () => {
  expect(environmentLabel(envs, null)).toBe("All environments");
  expect(environmentLabel(envs, new Set(["a"]))).toBe("Laptop");
  expect(environmentLabel(envs, new Set())).toBe("0 environments");
  expect(toggleAllEnvironments(true)).toBe(null);
  expect([...(toggleEnvironment(envs, null, "b", false) as Set<string>)]).toEqual(["a"]);
  expect(toggleEnvironment(envs, new Set(["a"]), "b", true)).toBe(null);
});

test("provider filter labels and toggles", () => {
  expect(providerFilterLabel([])).toBe("All providers");
  expect(providerFilterLabel(["codex", "grok", "cursor", "opencode", "antigravity", "pi", "muse"])).toBe("Claude Code");
  expect(providerFilterLabel(["codex"])).toBe("7 providers");
  expect(toggleProvider([], "codex", false)).toEqual(["codex"]);
  expect(toggleProvider(["codex"], "codex", true)).toEqual([]);
});

test("hidden providers drop out of buckets and sessions", () => {
  const merged = mergeUsageResults([result("claude", 3), result("codex", 1)]);
  const shown = filterUsageByProviders(merged, ["codex"]);
  expect(shown.buckets.map((b) => b.provider)).toEqual(["claude"]);
  expect(shown.sessions).toBe(1);
});

test("all environments is the sum: equal buckets add", () => {
  const merged = mergeUsageResults([result("claude", 3), result("claude", 2)]);
  expect(merged.buckets.length).toBe(1);
  expect(merged.buckets[0].costUsd).toBe(5);
  expect(merged.buckets[0].outputTokens).toBe(20);
  expect(merged.sessions).toBe(2);
});

test("price forms parse like the web: blank cache uses input, zero is free", () => {
  const form = { ...usagePriceForm("gpt-x"), inputCostPerMillionTokens: "1,5", outputCostPerMillionTokens: "6", cacheReadCostPerMillionTokens: "0" };
  expect(parseUsagePriceForm(form)).toEqual({ model: "gpt-x", price: { inputCostPerMillionTokens: 1.5, outputCostPerMillionTokens: 6, cacheReadCostPerMillionTokens: 0 } });
  expect(parseUsagePriceForm({ ...form, outputCostPerMillionTokens: "" })).toBe(null);
  expect(parseUsagePriceForm({ ...form, inputCostPerMillionTokens: "-1" })).toBe(null);
});

test("edited price rows become a settings patch, null removing", () => {
  const original = priceRowsFrom({ old: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } }, {});
  const added = { id: "new:1", isNew: true, removed: false, alias: "", form: { ...usagePriceForm("fresh"), inputCostPerMillionTokens: "3", outputCostPerMillionTokens: "4" } };
  const removed = { ...original[0]!, removed: true };
  const { patch, error } = priceChangesPatch(original, [removed, added]);
  expect(error).toBe(null);
  expect(patch).toEqual({ usagePriceOverrides: { old: null, fresh: { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 4 } } });
  expect(priceChangesPatch(original, original).patch).toBe(null);
  expect(priceChangesPatch(original, [{ ...added, form: { ...added.form, outputCostPerMillionTokens: "x" } }]).error).toBe("Enter valid prices for fresh");
  expect(cacheHitRate({ cached: 30, uncached: 60, cacheWrite: 10 })).toBe(0.3);
});

import { usageAliasCell, usagePriceCell, usagePriceTableChanges, usagePriceTableErrors, writeUsagePrices, type UsagePriceTarget } from "./usageSelection";

const price = (input: number, output: number) => ({ inputCostPerMillionTokens: input, outputCostPerMillionTokens: output });
const target = (id: string, patch: Partial<UsagePriceTarget> = {}): UsagePriceTarget => ({ id, label: id, prices: {}, aliases: {}, unavailable: null, ...patch });

test("a cell is the shared rate, Mixed where environments differ, Automatic with none, and Unavailable where a price cannot be read", () => {
  const same = [target("a", { prices: { m: price(1, 2) } }), target("b", { prices: { m: price(1, 2) } })];
  expect(usagePriceCell(same, "m", "inputCostPerMillionTokens")).toEqual({ value: "1", placeholder: "0.00" });
  expect(usagePriceCell(same, "m", "cacheReadCostPerMillionTokens")).toEqual({ value: "", placeholder: "Input rate" });
  const differ = [target("a", { prices: { m: price(1, 2) } }), target("b", { prices: { m: price(1, 3) } })];
  expect(usagePriceCell(differ, "m", "outputCostPerMillionTokens")).toEqual({ value: "", placeholder: "Mixed" });
  expect(usagePriceCell(differ, "m", "inputCostPerMillionTokens").value).toBe("1");
  expect(usagePriceCell([target("a")], "m", "inputCostPerMillionTokens")).toEqual({ value: "", placeholder: "Automatic" });
  expect(usagePriceCell([target("a", { prices: null })], "m", "inputCostPerMillionTokens").placeholder).toBe("Unavailable");
  expect(usageAliasCell([target("a", { aliases: { m: "n" } }), target("b")], "m")).toEqual({ value: "", placeholder: "Mixed" });
  expect(usageAliasCell([target("a", { aliases: null })], "m").placeholder).toBe("Unavailable");
});

test("only the edited cells change, so each environment keeps its own other rates", () => {
  const targets = [target("a", { prices: { m: price(1, 2) } }), target("b", { prices: { m: price(1, 3) } })];
  const draft = { id: "model:m", model: "m", isNew: false, values: { inputCostPerMillionTokens: "5" } };
  expect(usagePriceTableChanges(targets[0]!, [draft]).changes).toEqual([{ model: "m", price: price(5, 2) }]);
  expect(usagePriceTableChanges(targets[1]!, [draft]).changes).toEqual([{ model: "m", price: price(5, 3) }]);
  // An edit back to what is held changes nothing, and a removed row resets to automatic.
  expect(usagePriceTableChanges(targets[0]!, [{ ...draft, values: { inputCostPerMillionTokens: "1" } }]).changes).toEqual([]);
  expect(usagePriceTableChanges(targets[0]!, [{ ...draft, values: {}, removed: true }]).changes).toEqual([{ model: "m", price: null }]);
});

test("a new row needs a model and both rates, a mapping must differ from its model, and a mapping cycle is refused", () => {
  const empty = target("a");
  expect([...usagePriceTableChanges(empty, [{ id: "new:1", model: "x", isNew: true, values: { inputCostPerMillionTokens: "1" } }]).errors.values()]).toEqual(["Output is required on a."]);
  expect([...usagePriceTableChanges(empty, [{ id: "new:1", model: "x", isNew: true, values: { inputCostPerMillionTokens: "-1", outputCostPerMillionTokens: "2" } }]).errors.values()]).toEqual(["Use non-negative numbers for prices."]);
  expect([...usagePriceTableChanges(empty, [{ id: "new:1", model: "x", isNew: true, values: {}, alias: "x" }]).errors.values()]).toEqual(["Map to a different model."]);
  const cyclic = target("a", { aliases: { y: "x" } });
  expect([...usagePriceTableChanges(cyclic, [{ id: "new:1", model: "x", isNew: true, values: {}, alias: "y" }]).errors.values()]).toEqual(["Model mappings cannot form a cycle on a."]);
  // A mapped model refuses price edits that were not asked to clear the mapping.
  expect([...usagePriceTableChanges(cyclic, [{ id: "model:y", model: "y", isNew: false, values: { inputCostPerMillionTokens: "1" } }]).errors.values()][0]).toContain("maps this model");
  // Unavailable environments are not checked for row errors.
  expect(usagePriceTableErrors([target("a", { unavailable: "Offline", prices: null })], [{ id: "new:1", model: "", isNew: true, values: { inputCostPerMillionTokens: "1" } }]).size).toBe(0);
});

test("each destination settles on its own: saved, failed with its reason, or refused before any call", async () => {
  const targets = [target("a"), target("b"), target("c", { unavailable: "Read-only access" }), target("d", { aliases: null })];
  const changes = new Map<string, ({ model: string; price: ReturnType<typeof price> | null } | { model: string; alias: string | null })[]>([
    ["a", [{ model: "m", price: price(1, 2) }]], ["b", [{ model: "m", price: price(1, 2) }]], ["c", [{ model: "m", price: price(1, 2) }]], ["d", [{ model: "m", alias: "n" }]],
  ]);
  const written: string[] = []; const results: Record<string, unknown> = {};
  await writeUsagePrices({
    targets, changes,
    write: async (id, patch) => { written.push(`${id} ${JSON.stringify(patch)}`); if (id === "b") throw new Error("offline"); },
    onResult: (id, result) => { results[id] = result; },
  });
  expect(written.sort()).toEqual(['a {"usagePriceOverrides":{"m":{"inputCostPerMillionTokens":1,"outputCostPerMillionTokens":2}}}', 'b {"usagePriceOverrides":{"m":{"inputCostPerMillionTokens":1,"outputCostPerMillionTokens":2}}}']);
  expect(results).toEqual({ a: { status: "saved" }, b: { status: "failed", error: "Could not save. Try again." }, c: { status: "failed", error: "Read-only access" }, d: { status: "failed", error: "Update server to map models" } });
});
