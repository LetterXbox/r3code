import { expect, open, test } from "nsh/test";

// The Turn and Commits submenus are not drawn by the headless runner (nsh Submenu); they are checked on screen.
test("the scope menu offers Latest turn and loads the branch's commits; a commit reads its own source", async () => {
  const app = await open("./DiffScopesFixture.tsx", { width: 1100, height: 800 });
  await app.waitFor("label:File src/branch.ts");
  await app.press("label:Diff scope: Changes");
  await app.waitFor("label:Latest turn");
  await app.waitFor("label:call review.getBranchCommits");
  await app.press("label:Changes");
  await app.press("label:Open commit");
  await app.waitFor("label:File commit/one.ts");
  await app.waitFor("label:Diff scope: Fix the parser");
  await expect(app.shows("label:call review.getDiffPreview@abc1234def")).toBe(true);
  await app.waitFor("label:call review.getDiffPreview@abc1234def:file");
  await expect(app.texts()).toContain("abc1234");
});

test("Latest turn reads the newest checkpoint's diff, split into one row per file", async () => {
  const app = await open("./DiffScopesFixture.tsx", { width: 1100, height: 800 });
  await app.waitFor("label:File src/branch.ts");
  await app.press("label:Diff scope: Changes");
  await app.press("label:Latest turn");
  await app.waitFor("label:Diff scope: Latest turn");
  await app.waitFor("label:File turn/a.ts");
  await expect(app.shows("label:File turn/b.ts")).toBe(true);
  await expect(app.shows("label:call orchestration.getTurnDiff")).toBe(true);
});

test("an older turn opened at a file is labelled by its count; a tool call reads its recorded patch", async () => {
  const app = await open("./DiffScopesFixture.tsx", { width: 1100, height: 800 });
  await app.press("label:Open turn 1 at b");
  await app.waitFor("label:Diff scope: Turn 1");
  await app.waitFor("label:File turn/b.ts");
  await app.press("label:Open tool call");
  await app.waitFor("label:Diff scope: Tool call");
  await app.waitFor("label:File tool.ts");
  await expect(app.shows("label:call orchestration.getTurnItem")).toBe(true);
});

test("every file of a multi-file diff offers its own file open", async () => {
  const app = await open("./DiffScopesFixture.tsx", { width: 1100, height: 800 });
  await app.press("label:Diff scope: Changes");
  await app.press("label:Latest turn");
  await app.waitFor("label:File turn/b.ts");
  await expect(app.shows("label:Open turn/a.ts")).toBe(true);
  await expect(app.shows("label:Open turn/b.ts")).toBe(true);
});

test("the comparison target picker lists local and remote refs and re-reads the branch diff against the choice (fm13)", async () => {
  const app = await open("./DiffScopesFixture.tsx", { width: 1100, height: 800 });
  await app.waitFor("label:File src/branch.ts");
  await app.waitFor("label:Comparing feature against main");
  await app.press("label:Change comparison target. Currently main");
  await app.waitFor("label:Automatic");
  await app.waitFor("label:Use remote version of main");
  await app.waitFor("label:origin/release");
  await expect(app.shows("label:feature")).toBe(false);
  await app.press("label:origin/release");
  await app.waitFor("label:call review.getDiffPreview~origin/release");
});

test("a range from turn 0 reads orchestration.getFullThreadDiff, as the web's useCheckpointDiff does", async () => {
  const { turnDiffRequest } = await import("./DiffPanel");
  expect(turnDiffRequest("t", 0, 1, false)).toEqual(["orchestration.getFullThreadDiff", { threadId: "t", toTurnCount: 1, ignoreWhitespace: false }]);
  expect(turnDiffRequest("t", 1, 2, true)).toEqual(["orchestration.getTurnDiff", { threadId: "t", fromTurnCount: 1, toTurnCount: 2, ignoreWhitespace: true }]);
});
