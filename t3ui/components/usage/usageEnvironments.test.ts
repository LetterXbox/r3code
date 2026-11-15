import { expect, test } from "nsh/test";
import { buildUsageEnvironmentList } from "./usageEnvironments";
import { mergeUsageResults, selectedEnvironments } from "./usageSelection";
import { parseUsage } from "../../pages/utility-data";

const saved = (id: string, enabled = true) => ({ id, label: `${id}.host`, url: `ws://${id}`, enabled, addedAt: 0 });

test("the list is the live connection then every enabled saved environment, connected once probed", () => {
  const list = buildUsageEnvironmentList({
    primary: { id: "ws://local", label: "This device", connected: true },
    saved: [saved("saved:a"), saved("saved:b", false), saved("saved:c")],
    statuses: { "saved:a": { phase: "connected" }, "saved:c": { phase: "failed", error: "x" } },
  });
  expect(list.map((env) => [env.id, env.connected])).toEqual([["ws://local", true], ["saved:a", true], ["saved:c", false]]);
});

test("with no live connection only the saved environments are listed", () => {
  expect(buildUsageEnvironmentList({ primary: null, saved: [saved("saved:a")], statuses: {} }).map((env) => env.id)).toEqual(["saved:a"]);
  expect(buildUsageEnvironmentList({ primary: null, saved: [], statuses: {} })).toEqual([]);
});

test("a selection of two environments sums their answers", () => {
  const one = parseUsage({ buckets: [{ day: "2026-11-10", provider: "claude", model: "m", costUsd: 2, cacheSavingsUsd: 0, sessions: 1, totals: { uncachedInputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 5 } }], sources: [], pricing: { status: "fresh" } });
  const two = parseUsage({ buckets: [{ day: "2026-11-10", provider: "claude", model: "m", costUsd: 3, cacheSavingsUsd: 0, sessions: 2, totals: { uncachedInputTokens: 20, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 5 } }], sources: [], pricing: { status: "fresh" } });
  const list = buildUsageEnvironmentList({ primary: { id: "p", label: "P", connected: true }, saved: [saved("saved:a")], statuses: { "saved:a": { phase: "connected" } } });
  expect(selectedEnvironments(list, null).length).toBe(2);
  expect(selectedEnvironments(list, new Set(["saved:a"])).map((env) => env.id)).toEqual(["saved:a"]);
  const merged = mergeUsageResults([one, two]);
  expect(merged.buckets.length).toBe(1);
  expect(merged.buckets[0]!.costUsd).toBe(5);
});

test("reading several environments keeps the answers of those that work and names the ones that fail", async () => {
  const { readEnvironments } = await import("./usageEnvironments");
  const read = await readEnvironments([{ id: "a" }, { id: "b" }, { id: "c" }], async (id) => {
    if (id === "b") throw new Error("Pairing expired. Add the environment again.");
    if (id === "c") throw new Error("Request timed out. Its outcome may be unknown; check the thread before retrying.");
    return id.toUpperCase();
  });
  expect(read.answers).toEqual([{ id: "a", value: "A" }]);
  expect(read.failures).toEqual({ b: "Pairing expired. Add the environment again.", c: "The server is still scanning usage. Try refreshing again later." });
});

import { readUsageLimitSources, setUsageSourcesForTest } from "./usageEnvironments";

test("a saved environment's usage limit sources are read from its own session, and the live connection has none to read", async () => {
  setUsageSourcesForTest(async (id) => [{ id: "hub", kind: "cliproxy", label: `Hub of ${id}`, checkedAt: "2026-11-12T00:00:00.000Z", accounts: [] }]);
  expect(await readUsageLimitSources("saved-1")).toEqual([{ id: "hub", kind: "cliproxy", label: "Hub of saved-1", checkedAt: "2026-11-12T00:00:00.000Z", accounts: [] }]);
  setUsageSourcesForTest(null);
  // Not a saved environment: nothing to open a session to.
  expect(await readUsageLimitSources("ws://live")).toBeNull();
});
