import { expect, open, test } from "nsh/test";

test("a pull request link with a project asks before checking out, and shows Checking out... while it runs", async () => {
  const app = await open("./NewThreadLinkPageFixture.tsx", { width: 500, height: 300, platform: "macos" });
  await app.waitUntil(() => app.shows("text:Check out acme/widgets#7?"));
  await expect(app.texts()).toContain("This puts the pull request's code in a new worktree and runs your project's setup script on it.");
  await app.press("label:Check out");
  await app.waitUntil(() => app.shows("text:Checking out..."));
});
