import { expect, open, test } from "nsh/test";

test("summary review threads show a finding and indented reply cards with actions", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("id:review-summary-root");
  expect(app.shows("id:review-summary-reply")).toBe(true);
  expect(app.texts()).toContain("Is this guard enough?");
  expect(app.texts()).toContain("Yes, the lock covers it.");
  expect(app.shows("label:Resolve")).toBe(true);
  expect(app.shows("label:Load more comments")).toBe(true);
});

test("the pull request panel can be resized without leaving an input-blocking overlay", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Pull request 1");
  await app.press("label:Open pull request acme/t3code #1");
  await app.waitFor("label:Resize pull request panel");
  await app.drag("label:Resize pull request panel", { x: -80 });
  expect(app.shows("label:Resizing panel")).toBe(false);
  await app.press("label:Maximize pull request panel");
  expect(app.shows("label:Resize pull request panel")).toBe(false);
  await app.press("label:Restore pull request panel");
  expect(app.shows("label:Resize pull request panel")).toBe(true);
});
