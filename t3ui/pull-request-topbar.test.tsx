import { expect, open, test } from "nsh/test";

test("scrolling past the filters condenses the header into the scope breadcrumb with compact filters", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 420 });
  await app.waitFor("text:Pull request 1");
  await expect(app.shows("label:Pull requests breadcrumb")).toBe(true);
  await expect(app.shows("label:Pull request scope")).toBe(false);
  await app.scroll("text:Pull request 1", 200);
  await app.waitFor("label:Pull request scope");
  await expect(app.shows("label:Filter by state")).toBe(true);
  await expect(app.shows("label:Filter by involvement")).toBe(true);
  await app.press("label:Filter by state");
  await app.press("label:Filter by state: Merged");
  await app.waitFor("text:Already merged");
});
