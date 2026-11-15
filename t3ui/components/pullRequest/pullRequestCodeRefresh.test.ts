import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { createPullRequestCodeModel, mergeDiffPage } from "./pullRequestCodeModel";

const page = (patch: string, nextCursor: string | null = null) => ({ patch, truncated: false, nextCursor, omitted: [] as { path: string; additions: number; deletions: number }[] });
const A = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const B = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-a\n+b\n";
const C = "diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-a\n+b\n";

test("a refetched page that answers the same keeps every loaded page", () => {
  const pages = [page(A, "c1"), page(B)];
  expect(mergeDiffPage(pages, 0, page(A, "c1"))).toBe(pages);
});

test("a changed page replaces itself and drops the later pages; a page past the end appends", () => {
  const pages = [page(A, "c1"), page(B)];
  const merged = mergeDiffPage(pages, 0, page(C, "c9"));
  expect(merged.map((entry) => entry.patch)).toEqual([C]);
  expect(mergeDiffPage(pages, 2, page(C)).length).toBe(3);
  const omittedChanged = { ...page(A, "c1"), omitted: [{ path: "big.bin", additions: 1, deletions: 0 }] };
  expect(mergeDiffPage(pages, 0, omittedChanged).length).toBe(1);
});

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a new revision reloads from the first page; a background refresh keeps unchanged pages", async () => {
  let first = A;
  const bodies: string[] = [];
  const fetchStub = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const cursor = (JSON.parse(init.body) as { cursor?: string }).cursor;
    return { ok: true, json: async () => (cursor ? { patch: B } : { patch: first, nextCursor: "c1" }) };
  }) as unknown as typeof fetch;
  const revision = signal<string | null>("r1");
  const code = createPullRequestCodeModel({
    request: async () => ({ files: [] }),
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    active: () => true,
    http: { endpoint: () => "ws://127.0.0.1:1/", bearer: () => "tok", fetch: fetchStub },
    revision,
  });
  await until(() => code.pages().length === 1);
  await code.loadMore();
  expect(code.pages().length).toBe(2);
  // Same first page: both pages stay.
  await code.backgroundRefresh();
  expect(code.pages().length).toBe(2);
  // The first page changed: it replaces the stale pages.
  first = C;
  await code.backgroundRefresh();
  expect(code.pages().map((entry) => entry.patch)).toEqual([C]);
  // A new revision of the same pull request starts over from the first page.
  const before = bodies.length;
  revision.set("r2");
  await until(() => bodies.length > before && code.status() === "loaded");
  expect(JSON.parse(bodies[bodies.length - 1]!).cursor).toBe(undefined);
  expect(code.pages().length).toBe(1);
});

test("a new background token (the environment's refresh stream) refetches the first page and keeps unchanged pages", async () => {
  let calls = 0;
  const fetchStub = (async (_url: string, init: { body: string }) => {
    calls++;
    const cursor = (JSON.parse(init.body) as { cursor?: string }).cursor;
    return { ok: true, json: async () => (cursor ? { patch: B } : { patch: A, nextCursor: "c1" }) };
  }) as unknown as typeof fetch;
  const token = signal(0);
  const code = createPullRequestCodeModel({
    request: async () => ({ files: [] }),
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    active: () => true,
    http: { endpoint: () => "ws://127.0.0.1:1/", bearer: () => "tok", fetch: fetchStub },
    backgroundToken: token,
  });
  await until(() => code.pages().length === 1);
  await code.loadMore();
  const before = calls;
  token.set(1);
  await until(() => calls > before);
  await until(() => code.status() === "loaded");
  expect(code.pages().length).toBe(2);
});

test("a viewed tick asks the host's reading again after the write, answered or refused; a refusal puts the tick back", async () => {
  const calls: string[] = [];
  let refuse = false;
  const code = createPullRequestCodeModel({
    request: async (method) => {
      calls.push(method);
      if (method === "pullRequests.setFilesViewed" && refuse) throw new Error("denied");
      return { files: [] };
    },
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    active: () => false,
    http: { endpoint: () => "ws://127.0.0.1:1/", bearer: () => "tok", fetch: (async () => ({ ok: true, json: async () => ({ patch: "" }) })) as unknown as typeof fetch },
  });
  await code.setViewed("a.ts", true);
  await until(() => calls.filter((call) => call === "pullRequests.filesViewed").length === 1);
  expect(calls).toEqual(["pullRequests.setFilesViewed", "pullRequests.filesViewed"]);
  refuse = true;
  await code.setViewed("b.ts", true);
  await until(() => calls.filter((call) => call === "pullRequests.filesViewed").length === 2);
  expect(calls.slice(2)).toEqual(["pullRequests.setFilesViewed", "pullRequests.filesViewed"]);
  expect(code.isViewed("b.ts")).toBe(false);
});
