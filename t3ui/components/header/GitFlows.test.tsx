import { expect, open, test } from "nsh/test";

const size = { width: 900, height: 700, platform: "macos" } as const;

test("Push on the default ref asks first: Abort runs nothing, Continue runs it there", async () => {
  const app = await open("./GitDefaultFixture.tsx", size);
  await app.waitFor("label:Push");
  await app.press("label:Push");
  await app.waitFor("text:Push to default ref?");
  await expect(app.shows('text:This action will push local commits on "main". You can continue on this ref or create a feature ref and run the same action there.')).toBe(true);
  await expect(app.texts().join("|")).not.toContain("subscribe:git.runStackedAction");
  await app.press("label:Abort");
  await app.waitFor("text:Push to default ref?", { state: "gone" });
  await expect(app.texts().join("|")).not.toContain("subscribe:git.runStackedAction");
  await app.press("label:Push");
  await app.press("label:Push to main");
  await app.waitFor("label:Pushed");
  await expect(app.texts().join("|")).toContain("subscribe:git.runStackedAction:commit_push:here");
});

test("a clean default ref cannot take a feature branch and says why", async () => {
  const app = await open("./GitDefaultFixture.tsx", size);
  await app.waitFor("label:Push");
  await app.press("label:Push");
  await app.waitFor("text:Push to default ref?");
  await expect(app.shows("text:There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on main.")).toBe(true);
  await expect(app.enabled("label:Check out feature branch & continue")).toBe(false);
});

test("Commit & push on a dirty default ref can continue on a feature branch", async () => {
  const app = await open("./GitDirtyDefaultFixture.tsx", size);
  await app.waitFor("label:Commit & push");
  await app.press("label:Commit & push");
  await app.waitFor("text:Commit & push to default ref?");
  await app.press("label:Check out feature branch & continue");
  await app.waitFor("label:Pushed");
  await expect(app.texts().join("|")).toContain("subscribe:git.runStackedAction:commit_push:feature");
  // The thread follows the branch the action created.
  await expect(app.texts().join("|")).toContain('"type":"thread.metadata.update"');
  await expect(app.texts().join("|")).toContain('"branch":"feature/new"');
});

test("Publish repository walks Provider, Repository and Summary", async () => {
  const app = await open("./GitPublishFixture.tsx", size);
  await app.waitFor("label:Publish repository");
  await app.press("label:Publish repository");
  await app.waitFor("text:Pick where to host it, then point us at a repo to push to.");
  await app.waitFor("label:Setup Required");
  await app.press("label:Next");
  await app.waitFor("text:github.com/");
  await expect(app.value("label:Repository")).toBe("me/");
  await expect(app.enabled("label:Publish")).toBe(false);
  await app.type("label:Repository", "app");
  await app.press("label:Public");
  await app.press("label:Publish");
  await app.waitFor("text:Repository published");
  await expect(app.shows("text:main is now live on GitHub.")).toBe(true);
  await expect(app.texts().join("|")).toContain('request:sourceControl.publishRepository:{"cwd":"/repo","provider":"github","repository":"me/app","visibility":"public","remoteName":"origin","protocol":"ssh"}');
  await expect(app.shows("label:Open on GitHub")).toBe(true);
});

test("Pull shows what it pulled under its title", async () => {
  const app = await open("./GitPullFixture.tsx", size);
  await app.waitFor("label:Pull");
  await app.press("label:Pull");
  await app.waitFor("label:Pulled");
  await expect(app.shows("text:Updated feature from origin/feature")).toBe(true);
});

test("without source-control:write the quick action says so and the dropdown items are disabled", async () => {
  const app = await open("./GitReadOnlyFixture.tsx", size);
  await app.waitFor("label:Commit, push & PR");
  await app.press("label:Commit, push & PR");
  await expect(app.texts().join("|")).not.toContain("subscribe:git.runStackedAction");
  await app.press("label:Git action options");
  await expect(app.enabled("label:Commit")).toBe(false);
});
