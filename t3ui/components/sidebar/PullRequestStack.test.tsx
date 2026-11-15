import { expect, open, test } from "nsh/test";

const options = { width: 300, height: 400, platform: "macos" } as const;

test("a thread with one chain of linked pull requests shows Stack of N with their overall state", async () => {
  const app = await open("./PullRequestStackFixture.tsx", options);
  await app.waitFor("label:Stack of 3 pull requests, open");
  await expect(app.shows("label:Pull request #3, merged")).toBe(false);
});

test("unrelated links read as +N: the open link is the current one, with the overall state", async () => {
  const app = await open("./PullRequestStackFixture.tsx", options);
  await app.waitFor("label:PR #4, open, and 1 more linked; overall open");
  await expect(app.texts()).toContain("+2");
});

test("one visible link keeps the single pull request badge, a dismissed stack link does not count", async () => {
  const app = await open("./PullRequestStackFixture.tsx", options);
  await app.waitFor("label:Pull request #6, open");
  await expect(app.texts()).toContain("6");
  await expect(app.shows("label:Pull request #7, open")).toBe(true);
});
