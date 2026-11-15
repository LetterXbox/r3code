import { expect, open, test } from "nsh/test";

test("pressing a pull request link opens the card without a scrim, and Close dismisses it", async () => {
  const app = await open("./PullRequestLinkPreviewFixture.tsx", { width: 600, height: 400, platform: "macos" });
  expect(app.shows("label:Pull request preview")).toBe(false);
  await app.press("text:Link");
  await app.waitUntil(() => app.texts().includes("Fix the thing"));
  expect(app.texts()).toContain("acme/t3code");
  expect(app.texts()).toContain("octocat");
  await app.press("label:Close preview");
  await app.waitUntil(() => !app.texts().includes("Fix the thing"));
});
