import { expect, open, test } from "nsh/test";

test("the workspace menu offers Current checkout, New worktree and the previous worktree with its branch", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 640, height: 500, platform: "macos" });
  await expect(app.texts()).toContain("Current checkout");
  await app.press("label:Workspace");
  await app.waitUntil(() => app.shows("label:Previous worktree"));
  await expect(app.shows("label:New worktree")).toBe(true);
  await expect(app.texts()).toContain("feature/b");
  await app.press("label:New worktree");
  await app.waitUntil(() => app.texts().includes("log:select:worktree:main:false"));
  await expect(app.texts()).toContain("New worktree");
});

test("Previous worktree takes the previous thread's worktree", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 640, height: 500, platform: "macos" });
  await app.press("label:Workspace");
  await app.waitUntil(() => app.shows("label:Previous worktree"));
  await app.press("label:Previous worktree");
  await app.waitUntil(() => app.texts().includes("log:previous:/wt/b"));
  await expect(app.texts()).toContain("Current worktree");
});

test("a new worktree picks its base ref, with a Start from remote switch that the label follows", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 640, height: 500, platform: "macos" });
  await app.press("label:Workspace");
  await app.waitUntil(() => app.shows("label:New worktree"));
  await app.press("label:New worktree");
  await app.waitUntil(() => app.texts().includes("From main"));
  await app.press("label:Select branch");
  await app.waitUntil(() => app.shows("label:Start from remote"));
  await app.press("label:Start worktree from remote");
  await app.waitUntil(() => app.texts().includes("log:select:worktree:main:false,origin:true"));
  await app.waitUntil(() => app.texts().includes("From main (remote)"));
});

test("a pull request reference typed in the branch picker offers Checkout Pull request", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 640, height: 500, platform: "macos" });
  await app.press("label:Select branch");
  await app.type("label:Search refs", "#12");
  await app.waitUntil(() => app.shows("label:Checkout Pull request"));
  await expect(app.texts()).toContain("12");
  await app.press("label:Checkout Pull request");
  await app.waitUntil(() => app.texts().includes("log:checkout:12"));
});

test("a thread that has started shows its workspace locked, with the web's wording", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 640, height: 500, platform: "macos" });
  await app.press("label:Lock workspace");
  await app.waitUntil(() => app.texts().includes("Local checkout"));
  await expect(app.texts()).not.toContain("Current checkout");
});
