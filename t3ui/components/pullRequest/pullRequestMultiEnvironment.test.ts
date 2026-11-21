import { expect, test } from "nsh/test";
import { createPullRequestMultiEnvironment, projectViewerKey } from "./pullRequestMultiEnvironment";
import { parsePullRequestPage } from "../../pages/utility-data";
import { mergeEntries, partitionWithPriority, viewerOf } from "./pullRequestList.logic";

const environments = [{ id: "local", label: "Laptop", connected: true }, { id: "remote", label: "Server", connected: true }];
const envFor = (project: string) => project.startsWith("remote:") ? "remote" : "local";
const item = (projectId: string, title: string, author: string) => ({ projectId, host: "github.com", repository: "org/repo", number: 1, title, url: `https://example.com/${title}`, author: { login: author } });

test("one pull request reported by two servers retains its first route across pages", async () => {
  const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject: envFor, request: async (id) => ({
    entries: [id === "local" ? item("p", "same", "alice") : item("remote:p", "same", "bob")],
    errors: [], nextCursors: {}, viewers: {},
  }) });
  const first = parsePullRequestPage(await api.list({})).entries;
  const remote = parsePullRequestPage(await api.list({}, "remote")).entries;
  expect(first.map((entry) => entry.projectId)).toEqual(["p"]);
  expect(mergeEntries(first, remote, envFor).map((entry) => entry.projectId)).toEqual(["p"]);
  expect(partitionWithPriority(first, remote, []).map((group) => [group.key, group.entries[0]?.projectId])).toEqual([["authored", "p"]]);
});

test("lists and paginates each environment independently, keeping its viewer and project identity", async () => {
  const calls: { id: string; body: unknown }[] = [];
  const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject: envFor, request: async (id, _method, body) => {
    calls.push({ id, body });
    return { entries: [id === "local" ? item("p", "local", "alice") : item("remote:p", "remote", "bob")], errors: [], nextCursors: id === "remote" && !(body as { cursors?: unknown }).cursors ? { next: "two" } : {}, viewers: { "github.com": id === "local" ? "alice" : "bob" }, providers: [] };
  } });
  const first = parsePullRequestPage(await api.list({ limit: 99 }));
  expect(first.entries.map((entry) => entry.projectId)).toEqual(["p", "remote:p"]);
  expect(first.entries.map((entry) => viewerOf(entry, first.viewers))).toEqual(["alice", "bob"]);
  expect(first.viewers[projectViewerKey("remote:p", "github.com")]).toBe("bob");
  const next = parsePullRequestPage(await api.list({ limit: 99, cursors: first.nextCursors }));
  expect(next.entries.map((entry) => entry.projectId)).toEqual(["remote:p"]);
  expect(calls.map((call) => call.id)).toEqual(["local", "remote", "remote"]);
  expect((calls[2]!.body as { cursors: unknown }).cursors).toEqual({ next: "two" });
});

test("scopes project and server queries and retains successful results when another server fails", async () => {
  const calls: string[] = [];
  const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject: envFor, request: async (id, method) => {
    calls.push(`${id}:${method}`);
    if (id === "remote") throw new Error("offline");
    return { entries: [item("p", "local", "alice")], errors: [], nextCursors: {}, viewers: { "github.com": "alice" } };
  } });
  const page = parsePullRequestPage(await api.list({}));
  expect(page.entries.length).toBe(1);
  expect(page.errors).toEqual(["Server: offline"]);
  calls.length = 0;
  await api.list({ projectId: "p" });
  expect(calls).toEqual(["local:pullRequests.list"]);
  calls.length = 0;
  await api.list({}, "local");
  expect(calls).toEqual(["local:pullRequests.list"]);
});

test("splits stats by project environment", async () => {
  const calls: string[] = [];
  const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject: envFor, request: async (id, _method, body) => {
    calls.push(id);
    return { stats: (body as { refs: { projectId: string }[] }).refs.map((ref) => ({ ...ref, additions: 1, deletions: 0 })) };
  } });
  const answer = await api.stats({ refs: [{ projectId: "p" }, { projectId: "remote:p" }] }) as { stats: unknown[] };
  expect(calls).toEqual(["local", "remote"]);
  expect(answer.stats.length).toBe(2);
});

test("a failed stats request does not discard another environment's counts", async () => {
  const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject: envFor, request: async (id, _method, body) => {
    if (id === "remote") throw new Error("offline");
    return { stats: (body as { refs: { projectId: string }[] }).refs.map((ref) => ({ ...ref, additions: 5, deletions: 0 })) };
  } });
  const answer = await api.stats({ refs: [{ projectId: "p" }, { projectId: "remote:p" }] }) as { stats: { projectId: string }[]; failedProjects: string[] };
  expect(answer.stats.map((stat) => stat.projectId)).toEqual(["p"]);
  expect(answer.failedProjects).toEqual(["remote:p"]);
});

test("server and project scopes cannot accidentally query a different environment", async () => {
  const calls: string[] = [];
  const api = createPullRequestMultiEnvironment({ environments: () => environments, environmentForProject: envFor, request: async (id) => { calls.push(id); return {}; } });
  let failed = false;
  try { await api.list({ projectId: "remote:p" }, "local"); } catch { failed = true; }
  expect(failed).toBe(true);
  expect(calls).toEqual([]);
});

test("retry only refetches environments that failed and leaves healthy or pending ones alone (#39536)", async () => {
  const calls: string[] = [];
  let failRemote = true;
  const api = createPullRequestMultiEnvironment({
    environments: () => environments,
    environmentForProject: envFor,
    request: async (id) => {
      calls.push(id);
      if (id === "remote" && failRemote) throw new Error("offline");
      return { entries: [item(id === "local" ? "p" : "remote:p", id, id === "local" ? "alice" : "bob")], errors: [], nextCursors: {}, viewers: {} };
    },
  });
  const first = parsePullRequestPage(await api.list({}));
  expect(first.entries.map((e) => e.projectId)).toEqual(["p"]);
  expect(first.errors).toEqual(["Server: offline"]);
  expect(calls).toEqual(["local", "remote"]);

  calls.length = 0;
  failRemote = false;
  const retried = parsePullRequestPage(await api.retry({}));
  expect(calls).toEqual(["remote"]);
  expect(retried.entries.map((e) => e.projectId)).toEqual(["p", "remote:p"]);
  expect(retried.errors).toEqual([]);
});
