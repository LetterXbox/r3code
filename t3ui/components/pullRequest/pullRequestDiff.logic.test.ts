import { expect, test } from "nsh/test";
import {
  describeDiffError, fetchPullRequestDiff, filterPatch, httpOrigin, isFileViewed, isStaleViewed, isTestFile, joinPatches, patchFiles, viewedRange,
  viewedStates,
} from "./pullRequestDiff.logic";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,3 @@", " keep", "-old", "+new", "+more",
  "diff --git a/src/a.test.ts b/src/a.test.ts", "--- a/src/a.test.ts", "+++ b/src/a.test.ts", "@@ -1 +1 @@", "-x", "+y",
  "diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts", "",
].join("\n");

test("the file list counts added and removed lines per file and keeps renames", () => {
  const files = patchFiles(PATCH);
  expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/a.test.ts", "new.ts"]);
  expect(files[0]).toMatchObject({ additions: 2, deletions: 1, oldPath: null });
  expect(files[2]).toMatchObject({ oldPath: "old.ts", additions: 0 });
});

test("hiding test files drops their blocks only", () => {
  expect(isTestFile("src/a.test.ts")).toBe(true);
  expect(isTestFile("src/a.ts")).toBe(false);
  expect(patchFiles(filterPatch(PATCH, (path) => !isTestFile(path))).map((file) => file.path)).toEqual(["src/a.ts", "new.ts"]);
});

test("pages join into one patch", () => {
  const pages = [{ patch: "a", truncated: false, nextCursor: "n", omitted: [] }, { patch: "b\n", truncated: false, nextCursor: null, omitted: [] }];
  expect(joinPatches(pages)).toBe("a\nb\n");
});

test("viewed marks: a pending press wins, dismissed means the file changed", () => {
  const states = viewedStates({ files: [{ path: "a", state: "viewed" }, { path: "b", state: "dismissed" }] });
  const overlay = new Map([["a", false]]);
  expect(isFileViewed("a", states, overlay)).toBe(false);
  expect(isFileViewed("a", states, new Map())).toBe(true);
  expect(isStaleViewed("b", states, new Map())).toBe(true);
  expect(viewedRange(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
  expect(viewedRange(["a", "b"], "b", null)).toEqual(["b"]);
});

test("the diff is fetched over HTTP with the bearer token", async () => {
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const fakeFetch = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ patch: PATCH, truncated: false, nextCursor: "c2" }) };
  }) as unknown as typeof fetch;
  const page = await fetchPullRequestDiff({ endpoint: () => "ws://127.0.0.1:3773/", bearer: () => "tok", fetch: fakeFetch }, { projectId: "p", repository: "a/b", number: 4 }, { cursor: "c1" });
  expect(page.nextCursor).toBe("c2");
  expect(calls[0]!.url).toBe("http://127.0.0.1:3773/api/pull-requests/diff");
  expect(calls[0]!.init.headers?.authorization).toBe("Bearer tok");
  expect(JSON.parse(calls[0]!.init.body!)).toEqual({ projectId: "p", repository: "a/b", number: 4, cursor: "c1" });
  expect(httpOrigin("wss://x.dev/ws?a=1")).toBe("https://x.dev");
});

test("without a bearer token the diff says so, and rate limits are named", async () => {
  let message = "";
  try { await fetchPullRequestDiff({ endpoint: () => "ws://h", bearer: () => null, fetch }, { projectId: "p", repository: "a/b", number: 1 }); } catch (cause) { message = (cause as Error).message; }
  expect(message).toContain("not authorized");
  expect(describeDiffError("API rate limit exceeded", "GitHub", "pull request").title).toBe("GitHub rate limit reached");
  expect(describeDiffError("boom", "GitHub", "pull request").title).toBe("Couldn't load the changes");
});

test("a remote diff uses its owning server and local project id", async () => {
  const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
  const fakeFetch = (async (url: string, init: { headers?: Record<string, string>; body?: string }) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ patch: "", truncated: false }) }; }) as unknown as typeof fetch;
  await fetchPullRequestDiff({ endpoint: () => "http://local", bearer: () => "local-token", fetch: fakeFetch, resolve: async (ref) => ({ endpoint: "https://remote.example", bearer: "remote-token", ref: { ...ref, projectId: "remote-project" } }) }, { projectId: "remote:remote-project", repository: "a/b", number: 4 });
  expect(calls[0]!.url).toBe("https://remote.example/api/pull-requests/diff");
  expect(calls[0]!.init.headers?.authorization).toBe("Bearer remote-token");
  expect(JSON.parse(calls[0]!.init.body!).projectId).toBe("remote-project");
});
