import { expect, open, test } from "nsh/test";

test("a slow or failed refresh leaves the current diff visible", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/second.ts");
  await app.press("label:Hold diff refresh");
  await app.press("label:Refresh diff");
  expect(app.shows("label:File src/second.ts")).toBe(true);
  await app.press("label:Release diff refresh");
  await app.waitFor("label:Refresh diff");
  await app.press("label:Fail diff refresh");
  await app.press("label:Refresh diff");
  await app.waitFor("text:Could not refresh changes: Refresh unavailable");
  expect(app.shows("label:File src/second.ts")).toBe(true);
});

async function openTree(app: Awaited<ReturnType<typeof open>>) {
  await app.waitFor("label:Show file tree");
  await app.press("label:Show file tree");
  await app.waitFor("label:Show changes in src/second.ts");
}

test("every changed file stacks under its own header, with counts and a copy button", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/first.ts");
  await app.waitFor("label:File src/second.ts");
  await expect(app.shows("label:Copy src/first.ts")).toBe(true);
  await expect(app.shows("label:Collapse src/second.ts")).toBe(true);
  // The first file's patch is cut short by the server: its header says so, and once, under the stack.
  await app.waitFor("text:This diff is incomplete or truncated.");
  await expect(app.shows("label:Partial diff preview")).toBe(true);
});

// The reference's pending header (DiffFileHeaderSuffix) carries no loading text: DiffFileStatus shows only
// an error retry or the partial-preview mark, so the port no longer prints "Loading…" in the header.
test("a file whose diff is still loading keeps its header, with no loading text in it", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/first.ts");
  await expect(app.shows("label:Loading diff")).toBe(false);
  await expect(app.shows("label:Change: change")).toBe(true);
});

test("a renamed file is one entry: the old path, an arrow, then the new path", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/renamed.ts");
  await expect(app.shows("label:Renamed from src/original.ts")).toBe(true);
  await expect(app.shows("label:File src/original.ts")).toBe(false);
  await expect(app.shows("label:Change: rename")).toBe(true);
});

test("the file tree is closed by default, sits beside the stack, and Uncommitted swaps the files", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/second.ts");
  await expect(app.shows("label:Show changes in src/second.ts")).toBe(false);
  await openTree(app);
  await app.press("label:Diff scope: Changes");
  await app.press("label:Uncommitted");
  await app.waitFor("label:Diff scope: Uncommitted");
  await app.waitFor("label:Show changes in uncommitted.txt");
});

test("errors can be retried and missing folders are explicit", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.press("label:Load error");
  await app.waitFor("text:Repository unavailable");
  await app.press("label:Retry changes");
  await app.waitFor("label:File src/second.ts");
  await app.press("label:No folder");
  await expect(app.texts()).toContain("This thread does not have a project folder.");
});

test("switching threads discards an older delayed list", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.press("label:Load slow");
  await app.press("label:No folder");
  await app.wait(500);
  await expect(app.texts()).toContain("This thread does not have a project folder.");
  await expect(app.shows("label:File src/second.ts")).toBe(false);
});

test("changing whitespace mode reloads the server preview", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/second.ts");
  await app.press("label:Show whitespace changes");
  await app.waitFor("label:File whitespace-shown.ts");
  await expect(app.shows("label:File src/second.ts")).toBe(false);
});

test("the header carries the web's controls and the tree lists files with status marks", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/second.ts");
  for (const label of ["Refresh diff", "Stacked diff view", "Split diff view", "Disable diff line wrapping", "Show whitespace changes", "Show file tree"]) {
    await expect(app.shows(`label:${label}`)).toBe(true);
  }
  await expect(app.shows("label:4 additions, 3 deletions")).toBe(true);
  await openTree(app);
  await expect(app.shows("label:Folder src")).toBe(true);
  await app.press("label:Collapse all folders");
  await expect(app.shows("label:Show changes in src/second.ts")).toBe(false);
  await app.press("label:Expand all folders");
  await app.waitFor("label:Show changes in src/second.ts");
  await app.press("label:Hide file tree");
  await expect(app.shows("label:Show changes in src/second.ts")).toBe(false);
});

test("the layout toggles and wrap toggle report their pressed state", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:Split diff view");
  await app.press("label:Split diff view");
  await app.press("label:Disable diff line wrapping");
  await app.waitFor("label:Enable diff line wrapping");
  await app.press("label:Stacked diff view");
});

test("a file's diff folds away from its header, and Collapse all files folds every file", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:Collapse src/second.ts");
  await app.press("label:Collapse src/second.ts");
  await app.waitFor("label:Expand src/second.ts");
  await app.press("label:Expand src/second.ts");
  await app.waitFor("label:Collapse src/second.ts");
  await app.press("label:Collapse all files");
  await app.waitFor("label:Expand all files");
  await app.waitFor("label:Expand src/second.ts");
  await app.press("label:Expand all files");
  await app.waitFor("label:Collapse src/second.ts");
});

test("the changed-files column has its own resize edge once the tree opens", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:Show file tree");
  await expect(app.shows("label:Resize Changes files")).toBe(false);
  await app.press("label:Show file tree");
  await app.waitFor("label:Resize Changes files");
});
