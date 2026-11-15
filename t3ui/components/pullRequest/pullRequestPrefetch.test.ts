import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { createPullRequestDetailModel } from "./pullRequestDetailModel";
import { readSavedCommentFilter } from "./PullRequestSummaryTab";
import { PAGE_SIZE } from "./pullRequestListModel";
import type { PullRequestEntry } from "../../pages/utility-data";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a row the pointer rests on 150 ms has its detail read ahead; passing over asks nothing; the click reuses the read", async () => {
  const calls: string[] = [];
  const entry = signal<PullRequestEntry | null>(null);
  const model = createPullRequestDetailModel({
    request: async (method) => { calls.push(method); if (method === "pullRequests.detail") throw new Error("stop"); return {}; },
    entry: () => entry(),
  });
  const row = { projectId: "p", host: "github.com", repository: "o/r", number: 3, title: "T" } as unknown as PullRequestEntry;
  model.intent(row);
  model.intent(null);
  await wait(250);
  expect(calls).toEqual([]);
  model.intent(row);
  await wait(250);
  expect(calls).toEqual(["pullRequests.detail"]);
});

test("a removed row does not start a delayed detail read", async () => {
  let listed = true;
  let reads = 0;
  const model = createPullRequestDetailModel({
    entry: () => null,
    isListed: () => listed,
    request: async () => { reads++; return {}; },
  });
  const row = { projectId: "p", host: "github.com", repository: "o/r", number: 3, title: "T" } as PullRequestEntry;
  model.intent(row);
  listed = false;
  await wait(200);
  expect(reads).toBe(0);
  listed = true;
  model.intent(row);
  await wait(200);
  expect(reads).toBe(1);
});

test("an older rejected prefetch cannot remove a newer read of the same pull request", async () => {
  const entry = signal<PullRequestEntry | null>(null);
  const pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
  const model = createPullRequestDetailModel({ request: (method) => method === "pullRequests.detail" ? new Promise((resolve, reject) => pending.push({ resolve, reject })) : Promise.resolve({}), entry: () => entry() });
  const row = { projectId: "race", host: "github.com", repository: "o/r", number: 7, title: "T" } as unknown as PullRequestEntry;
  model.intent(row);
  await wait(200);
  entry.set(row);
  model.intent(row);
  await wait(200);
  expect(pending.length).toBe(2);
  pending[0]!.reject(new Error("old read failed"));
  await wait(0);
  const load = model.reload();
  expect(pending.length).toBe(2);
  pending[1]!.resolve({ projectId: "race", repository: "o/r", number: 7, title: "Fresh", url: "https://github.com/o/r/pull/7", state: "open" });
  await load;
  expect(model.detail()?.title).toBe("Fresh");
});

test("the list asks 99 at a time and the Summary comment filter reads its saved JSON", () => {
  expect(PAGE_SIZE).toBe(99);
  expect(readSavedCommentFilter('{"bots":true,"resolved":false}')).toEqual({ bots: true, resolved: false });
  expect(readSavedCommentFilter("{\"bots\":1}")).toBe(null);
});

test("a typed author or label query asks the host's filter options, scoped like the list", async () => {
  const { createPullRequestListModel } = await import("./pullRequestListModel");
  const calls: unknown[] = [];
  const model = createPullRequestListModel({
    request: async (method, payload) => { calls.push([method, payload]); return method === "pullRequests.filterOptions" ? { authors: [{ login: "octo" }], labels: [{ name: "bug", color: "" }], references: [], truncated: false } : { entries: [], errors: [], nextCursors: {}, viewers: {}, providers: [], truncated: false }; },
    connected: () => false,
    hasProjects: () => true,
    projects: () => [],
  });
  expect(await model.searchFilterOptions("authors", " oc ")).toEqual(["octo"]);
  expect(await model.searchFilterOptions("labels", "b")).toEqual(["bug"]);
  expect(calls[0]).toEqual(["pullRequests.filterOptions", { kind: "authors", query: "oc" }]);
});

test("an action's result holds over the listing until the host agrees or a minute passes", async () => {
  const { applyOverrides, overrideAfterAction, settleOverrides } = await import("./pullRequestList.logic");
  const key = (entry: { number: number }) => String(entry.number);
  const row = { number: 1, state: "open", isDraft: false, updatedAt: "" };
  const held = new Map([["1", overrideAfterAction(row, "close", 1_000)!]]);
  expect(applyOverrides([row], held, key)[0]!.state).toBe("closed");
  expect(settleOverrides(held, [row], key, 30_000).size).toBe(1);
  expect(settleOverrides(held, [row], key, 62_000).size).toBe(0);
  expect(settleOverrides(held, [{ ...row, state: "closed" }], key, 2_000).size).toBe(0);
  expect(settleOverrides(held, [], key, 99_000).size).toBe(1);
  expect(overrideAfterAction(row, "update-branch", 0)).toBe(null);
});

test("a pull request read before paints from its snapshot while it is read again", async () => {
  const { Storage } = await import("nsh");
  const { detailSnapshotKey } = await import("./pullRequestDetailModel");
  const ref = { projectId: "p", repository: "o/r", number: 3 };
  await Storage.setItem(detailSnapshotKey(ref), JSON.stringify({ projectId: "p", repository: "o/r", number: 3, title: "Cached title", url: "https://github.com/o/r/pull/3", state: "open" }));
  const entry = signal<PullRequestEntry | null>(null);
  let release: (value: unknown) => void = () => {};
  const model = createPullRequestDetailModel({
    request: (method) => (method === "pullRequests.detail" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({})),
    entry: () => entry(),
  });
  entry.set({ projectId: "p", host: "", repository: "o/r", number: 3, title: "T" } as unknown as PullRequestEntry);
  void model.reload();
  for (let i = 0; i < 50 && model.detail()?.title !== "Cached title"; i++) await wait(10);
  expect(model.detail()?.title).toBe("Cached title");
  release({ projectId: "p", repository: "o/r", number: 3, title: "Fresh title", url: "https://github.com/o/r/pull/3", state: "open" });
  for (let i = 0; i < 50 && model.detail()?.title !== "Fresh title"; i++) await wait(10);
  expect(model.detail()?.title).toBe("Fresh title");
});

test("a host that says not-found marks the detail as not found; a refresh that fails keeps the activity shown without its error", async () => {
  const { RequestFailure, failureReason } = await import("../../backend/client");
  expect(failureReason([{ _tag: "Fail", error: { _tag: "PullRequestOperationError", reason: "not-found" } }])).toBe("not-found");
  expect(failureReason({ error: { _tag: "GitCommandError" } })).toBe(null);
  const entry = signal<PullRequestEntry | null>(null);
  const model = createPullRequestDetailModel({
    request: async (method) => { if (method === "pullRequests.detail") throw new RequestFailure("gone", "PullRequestOperationError", "not-found"); return {}; },
    entry: () => entry(),
  });
  entry.set({ projectId: "p", host: "", repository: "o/r", number: 9, title: "T" } as unknown as PullRequestEntry);
  for (let i = 0; i < 50 && model.status() !== "error"; i++) await wait(10);
  expect(model.status()).toBe("error");
  expect(model.notFound()).toBe(true);
  const other = createPullRequestDetailModel({
    request: async (method) => { if (method === "pullRequests.detail") throw new Error("boom"); return {}; },
    entry: () => entry(),
  });
  for (let i = 0; i < 50 && other.status() !== "error"; i++) await wait(10);
  expect(other.notFound()).toBe(false);
  expect(other.error()).toBe("boom");

  const ref = { projectId: "p", repository: "o/r", number: 4, title: "T", url: "https://github.com/o/r/pull/4", state: "open" };
  let activityDown = false;
  const live = createPullRequestDetailModel({
    request: async (method) => {
      if (method === "pullRequests.detail") return ref;
      if (method === "pullRequests.activity") { if (activityDown) throw new Error("activity gone"); return { comments: [], reviewThreads: [], commits: [], commentCount: 0 }; }
      return {};
    },
    entry: () => ({ projectId: "p", host: "", repository: "o/r", number: 4, title: "T" }) as unknown as PullRequestEntry,
  });
  for (let i = 0; i < 50 && live.activity() === null; i++) await wait(10);
  expect(live.activity()).not.toBe(null);
  activityDown = true;
  await live.refresh();
  expect(live.activity()).not.toBe(null);
  expect(live.activityError()).toBe("");
});
