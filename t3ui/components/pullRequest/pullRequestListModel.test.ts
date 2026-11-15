import { expect, test } from "nsh/test";
import { createPullRequestListModel } from "./pullRequestListModel";
import { listRequest, rankByMergeReadiness } from "./pullRequestList.logic";
import { readPullRequestSnapshot, writePullRequestSnapshot } from "./pullRequestSnapshot";

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const rows = [43, 40].map((number) => ({ projectId: "p", repository: "o/r", number, title: `PR ${number}`, url: `https://example.com/${number}`, state: "open", author: { login: "me" } }));
const page = { entries: rows, errors: [], nextCursors: {}, viewers: {}, providers: [], truncated: false };
const stats = { stats: [
  { projectId: "p", repository: "o/r", number: 43, additions: 385, deletions: 37 },
  { projectId: "p", repository: "o/r", number: 40, additions: 67, deletions: 1 },
] };

test("change counts survive list refreshes and a stats response arriving after a refresh", async () => {
  let release: ((answer: unknown) => void) | undefined;
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} },
    request: async (method) => method === "pullRequests.listStats" ? new Promise((resolve) => { release = resolve; }) : page,
  });
  for (let i = 0; i < 50 && !release; i++) await wait();
  expect(Boolean(release)).toBe(true);
  await model.refresh();
  release!(stats);
  for (let i = 0; i < 50 && model.entries()[0]?.additions !== 385; i++) await wait();
  expect(model.entries().map((row) => row.additions)).toEqual([385, 67]);
  expect(rankByMergeReadiness(model.entries()).map((row) => row.number)).toEqual([40, 43]);
  await model.refresh();
  expect(model.entries().map((row) => row.additions)).toEqual([385, 67]);
});

test("failed change count requests can be retried", async () => {
  let attempts = 0;
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} },
    request: async (method) => { if (method !== "pullRequests.listStats") return page; if (++attempts === 1) throw new Error("temporary"); return stats; },
  });
  for (let i = 0; i < 50 && attempts === 0; i++) await wait();
  await model.refresh();
  for (let i = 0; i < 50 && model.entries()[0]?.additions !== 385; i++) await wait();
  expect(model.entries().map((row) => row.additions)).toEqual([385, 67]);
});

test("a measured zero-line diff ranks ahead of an unknown size after stats load", async () => {
  let release: ((answer: unknown) => void) | undefined;
  const answer = { ...page, entries: [
    { ...rows[0], updatedAt: "2026-01-01T00:00:00Z" },
    { ...rows[1], updatedAt: "2026-01-02T00:00:00Z" },
  ] };
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} },
    request: async (method) => method === "pullRequests.listStats" ? new Promise((resolve) => { release = resolve; }) : answer,
  });
  for (let i = 0; i < 50 && !release; i++) await wait();
  expect(model.view().entries.map((row) => row.number)).toEqual([40, 43]);
  release!({ stats: [{ projectId: "p", repository: "o/r", number: 43, additions: 0, deletions: 0 }] });
  for (let i = 0; i < 50 && model.view().entries[0]?.number !== 43; i++) await wait();
  expect(model.view().entries.map((row) => row.number)).toEqual([43, 40]);
});

test("search results rank title matches ahead of matches found only by the host", async () => {
  const answer = { ...page, entries: [
    { ...rows[0], number: 1, title: "Unrelated title", updatedAt: "2026-01-02T00:00:00Z" },
    { ...rows[1], number: 2, title: "Welcome wizard", updatedAt: "2026-01-01T00:00:00Z" },
  ] };
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} },
    request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : answer,
  });
  for (let i = 0; i < 50 && model.status() !== "loaded"; i++) await wait();
  model.search.set("welcome wizard");
  model.submitSearch();
  await model.refresh();
  expect(model.entries().map((row) => row.number)).toEqual([2, 1]);
});

test("reopening the list shows cached rows while refreshing, without sharing them across connections", async () => {
  const preferences = { read: async () => null, write: async () => {} };
  const first = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: () => "cache-test-connection", request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : page });
  for (let i = 0; i < 50 && first.status() !== "loaded"; i++) await wait();
  let release: ((answer: unknown) => void) | undefined;
  const second = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: () => "cache-test-connection", request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : new Promise((resolve) => { release = resolve; }) });
  for (let i = 0; i < 50 && !release; i++) await wait();
  expect(second.entries().map((row) => row.number)).toEqual([43, 40]);
  expect(second.status()).toBe("loaded");
  const other = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: () => "cache-test-other-connection", request: async () => new Promise(() => {}) });
  await wait();
  expect(other.entries()).toEqual([]);
  release!(page);
});

test("an expired memory entry does not block restoring the saved list", async () => {
  let now = 1_000;
  const namespace = "cache-expired-snapshot";
  const preferences = { read: async () => null, write: async () => {} };
  const first = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: () => namespace, now: () => now, request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : page });
  for (let i = 0; i < 50 && first.status() !== "loaded"; i++) await wait();
  const body = listRequest({ state: "open", involvement: "all", filters: {}, query: "", limit: 99 });
  await writePullRequestSnapshot(JSON.stringify([namespace, undefined, body]), page);
  now += 5 * 60_000 + 1;
  let release: ((answer: unknown) => void) | undefined;
  const reopened = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: () => namespace, now: () => now, request: async (method, payload) => {
    if (method === "pullRequests.listStats") return { stats: [] };
    const involvement = typeof payload === "object" && payload !== null && "involvement" in payload ? payload.involvement : undefined;
    return involvement === "authored" || involvement === "reviewing" ? page : new Promise((resolve) => { release = resolve; });
  } });
  for (let i = 0; i < 50 && reopened.entries().length === 0; i++) await wait();
  expect(reopened.entries().map((row) => row.number)).toEqual([43, 40]);
  expect(reopened.status()).toBe("loaded");
  release?.(page);
});

test("cached rows restore their groups while the main refresh is still pending", async () => {
  const preferences = { read: async () => null, write: async () => {} };
  const namespace = () => "cache-test-partitions";
  const first = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: namespace, request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : page });
  for (let i = 0; i < 50 && first.status() !== "loaded"; i++) await wait();
  let release: ((answer: unknown) => void) | undefined;
  const second = createPullRequestListModel({
    connected: () => true, hasProjects: () => true, preferences, cacheNamespace: namespace,
    request: async (method, payload) => {
      if (method === "pullRequests.listStats") return { stats: [] };
      const involvement = typeof payload === "object" && payload !== null && "involvement" in payload ? payload.involvement : undefined;
      return involvement === "authored" || involvement === "reviewing" ? page : new Promise((resolve) => { release = resolve; });
    },
  });
  for (let i = 0; i < 50 && (!release || !second.partitions()); i++) await wait();
  expect(second.entries().length).toBe(2);
  expect(second.partitions()?.authored.length).toBe(2);
  release!(page);
});

test("late cached group requests cannot replace groups from a fresher list", async () => {
  const preferences = { read: async () => null, write: async () => {} };
  const namespace = () => "cache-test-partition-race";
  const first = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: namespace, request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : page });
  for (let i = 0; i < 50 && first.status() !== "loaded"; i++) await wait();
  let releaseMain: ((answer: unknown) => void) | undefined;
  const oldGroups: ((answer: unknown) => void)[] = [];
  let groupCalls = 0;
  const freshPage = { ...page, entries: [rows[1]] };
  const second = createPullRequestListModel({
    connected: () => true, hasProjects: () => true, preferences, cacheNamespace: namespace,
    request: async (method, payload) => {
      if (method === "pullRequests.listStats") return { stats: [] };
      const involvement = typeof payload === "object" && payload !== null && "involvement" in payload ? payload.involvement : undefined;
      if (involvement !== "authored" && involvement !== "reviewing") return new Promise((resolve) => { releaseMain = resolve; });
      if (++groupCalls <= 2) return new Promise((resolve) => { oldGroups.push(resolve); });
      return freshPage;
    },
  });
  for (let i = 0; i < 50 && (!releaseMain || oldGroups.length !== 2); i++) await wait();
  releaseMain!(freshPage);
  for (let i = 0; i < 50 && second.partitions()?.authored[0]?.number !== 40; i++) await wait();
  for (const release of oldGroups) release(page);
  await wait();
  expect(second.partitions()?.authored.map((entry) => entry.number)).toEqual([40]);
});

test("cold start restores a saved list without waiting for the server", async () => {
  const namespace = "cold-snapshot-connection";
  const body = listRequest({ state: "open", involvement: "all", filters: {}, query: "", limit: 99 });
  await writePullRequestSnapshot(JSON.stringify([namespace, undefined, body]), page);
  let release: ((answer: unknown) => void) | undefined;
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} }, cacheNamespace: () => namespace,
    request: async (method, payload) => {
      if (method === "pullRequests.listStats") return { stats: [] };
      const involvement = typeof payload === "object" && payload !== null && "involvement" in payload ? payload.involvement : undefined;
      return involvement === "authored" || involvement === "reviewing" ? page : new Promise((resolve) => { release = resolve; });
    },
  });
  for (let i = 0; i < 50 && model.entries().length === 0; i++) await wait();
  expect(model.entries().map((entry) => entry.number)).toEqual([43, 40]);
  expect(model.status()).toBe("loaded");
  release!(page);
});

test("a partially failed refresh does not overwrite the saved complete list", async () => {
  const namespace = "cold-snapshot-partial";
  const body = listRequest({ state: "open", involvement: "all", filters: {}, query: "", limit: 99 });
  const scope = JSON.stringify([namespace, undefined, body]);
  await writePullRequestSnapshot(scope, page);
  const partial = { ...page, entries: [rows[0]], errors: [{ projectTitle: "other", message: "offline" }] };
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} }, cacheNamespace: () => namespace,
    request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : partial,
  });
  for (let i = 0; i < 50 && model.status() !== "loaded"; i++) await wait();
  await wait();
  expect((await readPullRequestSnapshot(scope))?.entries.length).toBe(2);
});

test("a partially failed refresh does not replace the complete in-memory list", async () => {
  const preferences = { read: async () => null, write: async () => {} };
  const namespace = () => "cache-partial-memory";
  let partial = false;
  const first = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: namespace, request: async (method) => {
    if (method === "pullRequests.listStats") return { stats: [] };
    return partial ? { ...page, entries: [rows[0]], errors: [{ projectTitle: "p", message: "unavailable" }] } : page;
  } });
  for (let i = 0; i < 50 && first.status() !== "loaded"; i++) await wait();
  partial = true;
  await first.refresh();
  let release: ((answer: unknown) => void) | undefined;
  const reopened = createPullRequestListModel({ connected: () => true, hasProjects: () => true, preferences, cacheNamespace: namespace, request: async (method, payload) => {
    if (method === "pullRequests.listStats") return { stats: [] };
    const involvement = typeof payload === "object" && payload !== null && "involvement" in payload ? payload.involvement : undefined;
    return involvement === "authored" || involvement === "reviewing" ? page : new Promise((resolve) => { release = resolve; });
  } });
  for (let i = 0; i < 50 && !release; i++) await wait();
  expect(reopened.entries().map((row) => row.number)).toEqual([43, 40]);
  release?.(page);
});

test("a cold-start snapshot never replaces a newer server answer", async () => {
  const namespace = "cold-snapshot-fresh-answer";
  const body = listRequest({ state: "open", involvement: "all", filters: {}, query: "", limit: 99 });
  await writePullRequestSnapshot(JSON.stringify([namespace, undefined, body]), page);
  const fresh = { ...page, entries: [rows[1]] };
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} }, cacheNamespace: () => namespace,
    request: async (method) => method === "pullRequests.listStats" ? { stats: [] } : fresh,
  });
  for (let i = 0; i < 50 && model.status() !== "loaded"; i++) await wait();
  await wait();
  expect(model.entries().map((entry) => entry.number)).toEqual([40]);
});

test("changing servers immediately clears the old server's rows and requests the new scope", async () => {
  const calls: (string | undefined)[] = [];
  let release: ((answer: unknown) => void) | undefined;
  const model = createPullRequestListModel({
    connected: () => true, hasProjects: () => true,
    preferences: { read: async () => null, write: async () => {} },
    request: async () => page,
    environments: () => [{ id: "local", label: "Laptop", connected: true }, { id: "remote", label: "Server", connected: true }],
    multiEnvironment: {
      list: async (_body, environmentId) => { calls.push(environmentId); return environmentId === "remote" ? new Promise((resolve) => { release = resolve; }) : page; },
      stats: async () => ({ stats: [] }), filterOptions: async () => ({}),
    },
  });
  for (let i = 0; i < 50 && model.status() !== "loaded"; i++) await wait();
  expect(model.entries().length).toBe(2);
  model.setEnvironmentId("remote");
  for (let i = 0; i < 50 && !release; i++) await wait();
  expect(model.entries()).toEqual([]);
  expect(calls.includes("remote")).toBe(true);
  release!(page);
});
