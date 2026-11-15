import { expect, open, test } from "nsh/test";

test("the Code tab's hunk separators reveal unchanged lines through pullRequests.diffFileContents", async () => {
  const app = await open("./PullRequestCodeContextFixture.tsx", { width: 1200, height: 900 });
  await app.waitFor("label:30 unmodified lines");
  await expect(app.shows("label:2 unmodified lines")).toBe(true);
  await expect(app.texts()).not.toContain("line 20");
  await app.press("label:30 unmodified lines >> label:Expand");
  await app.waitFor("text:line 20");
  await expect(app.shows("label:30 unmodified lines")).toBe(false);
  await expect(app.texts()).toContain("o/r 7 change src/a.ts src/a.ts");
});
