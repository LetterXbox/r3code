import { expect, test } from "nsh/test";
import { createPullRequestCodeModel } from "./pullRequestCodeModel";
import { createPullRequestReviewModel } from "./pullRequestReviewModel";
import { isFileDiffCollapsed, ignoreWhitespacePatch, isTestFile, patchFiles, toggleFileDiffFoldForViewed } from "./pullRequestDiff.logic";
import { diffFileTier, orderPatchSlices } from "./pullRequestFileOrder.logic";
import { parseActivity, parseDetail } from "./pullRequestDetail.logic";

const block = (path: string, body: string[], extra: string[] = []) => ["diff --git a/" + path + " b/" + path, ...extra, "--- a/" + path, "+++ b/" + path, ...body].join("\n") + "\n";

const SOURCE = block("src/a.ts", ["@@ -1,1 +1,2 @@", "-import { b } from \"./b\"", "+import { b } from \"./b\"", "+export const a = b"]);
const DEP = block("src/b.ts", ["@@ -1 +1 @@", "-old", "+new"]);
const TEST = block("src/a.test.ts", ["@@ -1 +1 @@", "-x", "+y"]);
const LOCK = block("pnpm-lock.yaml", ["@@ -1 +1 @@", "-a", "+b"]);
const DOC = block("docs/x.md", ["@@ -1 +1 @@", "-a", "+b"]);

test("files are listed as sources after what they import, then tests, then generated files, each folder together", () => {
  const ordered = patchFiles(orderPatchSlices([LOCK + TEST + SOURCE + DEP + DOC])).map((file) => file.path);
  // docs/ and src/ stay contiguous; inside src, b.ts is read before a.ts, which imports it.
  expect(ordered.indexOf("src/b.ts")).toBeLessThan(ordered.indexOf("src/a.ts"));
  expect(ordered.indexOf("src/a.ts")).toBeLessThan(ordered.indexOf("src/a.test.ts"));
  expect(ordered.indexOf("pnpm-lock.yaml")).toBeGreaterThan(ordered.indexOf("src/a.test.ts"));
  const folders = ordered.map((path) => path.split("/")[0]);
  expect(folders.join(",").replace(/(src,)+/u, "src,").split("src,").length).toBeLessThanOrEqual(2);
  expect(diffFileTier("pnpm-lock.yaml")).toBe("generated");
  expect(diffFileTier("src/a.test.ts")).toBe("test");
});

test("pages are ordered one at a time, then the whole list is made contiguous by folder", () => {
  const out = orderPatchSlices([DEP, TEST, SOURCE]);
  expect(patchFiles(out).map((file) => file.path)).toEqual(["src/b.ts", "src/a.test.ts", "src/a.ts"]);
  expect(out.endsWith("\n")).toBe(true);
});

test("file status comes from the patch headers", () => {
  const patch = block("n.ts", ["@@ -0,0 +1 @@", "+a"], ["new file mode 100644"]) + block("d.ts", ["@@ -1 +0,0 @@", "-a"], ["deleted file mode 100644"]);
  expect(patchFiles(patch).map((file) => file.status)).toEqual(["added", "deleted"]);
});

test("hiding whitespace changes folds a pair that differs only in whitespace into context and keeps the hunk's counts", () => {
  const patch = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", "-  keep()", "+    keep()", "-gone", "+came"].join("\n");
  const out = ignoreWhitespacePatch(patch).split("\n");
  expect(out).toEqual(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", "     keep()", "-gone", "+came"]);
  const count = (lines: string[], marks: string[]) => lines.filter((line) => marks.includes(line[0] ?? "")).length;
  const body = (lines: string[]) => lines.slice(4);
  // Old side: context + removed; new side: context + added: both as the header says before and after.
  expect(count(body(out), [" ", "-"])).toBe(count(body(patch.split("\n")), [" ", "-"]));
  expect(count(body(out), [" ", "+"])).toBe(count(body(patch.split("\n")), [" ", "+"]));
});

test("hiding whitespace leaves real changes, unpaired lines and other files alone", () => {
  const patch = ["diff --git a/f b/f", "@@ -1,2 +1,1 @@", "-a", "-b", "+c"].join("\n");
  expect(ignoreWhitespacePatch(patch)).toBe(patch);
});

test("test files follow the shared changed-file kinds", () => {
  expect(isTestFile("src/__mocks__/x.ts")).toBe(true);
  expect(isTestFile("src/a.spec.ts")).toBe(true);
  expect(isTestFile("src/a.ts")).toBe(false);
});

test("folds are kept relative to the toolbar's so later pages inherit Collapse all", () => {
  expect(isFileDiffCollapsed("a", "folded", new Set())).toBe(true);
  expect(isFileDiffCollapsed("a", "folded", new Set(["a"]))).toBe(false);
  expect(isFileDiffCollapsed("a", "expanded", new Set(["a"]))).toBe(true);
  // Viewed folds a file away, unviewed opens it; one already so is left alone.
  expect([...toggleFileDiffFoldForViewed("a", true, "expanded", new Set())]).toEqual(["a"]);
  expect(toggleFileDiffFoldForViewed("a", true, "folded", new Set()).size).toBe(0);
  expect([...toggleFileDiffFoldForViewed("a", false, "folded", new Set())]).toEqual(["a"]);
});

const DETAIL = parseDetail({
  projectId: "p", repository: "o/r", number: 7, title: "T", url: "https://github.com/o/r/pull/7", state: "open", headBranch: "h", baseBranch: "main",
  capabilities: { diff: true, comment: true, actions: [], mergeMethods: [], viewedFiles: "environment", review: { inlineComment: true, reply: true, resolve: true }, reviewers: {} },
  viewerPermissions: { comment: true },
});
const ACTIVITY = parseActivity({
  comments: [], commentCount: 0,
  commits: [{ oid: "c1c1c1c1", messageHeadline: "First", committedDate: "2026-01-01T00:00:00Z", authors: [] }, { oid: "c2c2c2c2", messageHeadline: "Second", committedDate: "2026-01-02T00:00:00Z", authors: [] }],
  reviewThreads: [{ id: "t1", path: "src/a.ts", line: 2, side: "right", isResolved: false, isOutdated: false, comments: [{ id: "k1", body: "hm", createdAt: "2026-01-01T00:00:00Z", author: { login: "ann" } }] }],
});

function harness() {
  const bodies: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const fetchStub = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ patch: SOURCE + DEP, truncated: false, nextCursor: null }) };
  }) as unknown as typeof fetch;
  const code = createPullRequestCodeModel({
    request: async (method) => { requests.push(method); return { files: [], truncated: true }; },
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    active: () => true,
    http: { endpoint: () => "ws://127.0.0.1:1/", bearer: () => "tok", fetch: fetchStub },
    commits: () => ACTIVITY.commits,
    viewedFiles: () => DETAIL.capabilities.viewedFiles,
  });
  const review = createPullRequestReviewModel({
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    patch: () => code.patch(),
    detail: () => DETAIL,
    activity: () => ACTIVITY,
    commit: () => code.commit(),
  });
  return { code, review, bodies, requests };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("the diff is fetched for the commit the scope names, and the viewed ticks report who keeps them and a short count", async () => {
  const { code, bodies } = harness();
  await until(() => code.status() === "loaded");
  expect(bodies[0]).toEqual({ projectId: "p", repository: "o/r", number: 7 });
  expect(code.viewedEnabled()).toBe(true);
  expect(code.viewedStore()).toBe("environment");
  await until(() => code.viewedTruncated());
  expect(code.viewedTruncated()).toBe(true);
  code.selectedCommit.set("c2c2c2c2");
  await until(() => bodies.length === 2);
  expect(bodies[1]).toEqual({ projectId: "p", repository: "o/r", number: 7, commit: "c2c2c2c2" });
});

test("a selected commit that is no longer in the pull request reads as All commits", async () => {
  const { code, bodies } = harness();
  await until(() => code.status() === "loaded");
  code.selectedCommit.set("gone");
  expect(code.commit()).toBeNull();
  expect(bodies.length).toBe(1);
});

test("in a commit's diff no comment is written on a line and every conversation is listed apart", async () => {
  const { code, review } = harness();
  await until(() => code.status() === "loaded");
  expect(review.canCommentOnLines()).toBe(true);
  expect(review.unplaced().length).toBe(0);
  expect(review.groups().length).toBe(1);
  code.selectedCommit.set("c1c1c1c1");
  expect(review.canCommentOnLines()).toBe(false);
  expect(review.canComment()).toBe(true);
  expect(review.begin({ side: "new", start: 0, end: 0 })).toBe(false);
  expect(review.draft()).toBeNull();
  expect(review.groups().length).toBe(0);
  expect(review.unplaced().map((thread) => thread.id)).toEqual(["t1"]);
});

test("a host that records no views offers no ticks", async () => {
  const code = createPullRequestCodeModel({
    request: async () => ({ files: [] }),
    ref: () => ({ projectId: "p", repository: "o/r", number: 7 }),
    active: () => false,
    http: { endpoint: () => "ws://127.0.0.1:1/", bearer: () => "tok", fetch: (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch },
    viewedFiles: () => undefined,
  });
  expect(code.viewedEnabled()).toBe(false);
});
