import { expect, open, test } from "nsh/test";

const size = { width: 900, height: 700 };

test("each visible link is a row with its number, title and diff stat, and a dismissed stack link is not listed", async () => {
  const app = await open("./ThreadPullRequestsFixture.tsx", size);
  for (const text of ["#1", "Fix the race", "Stack layer", "#4", "acme/t3code", "feature-1 -> main", "+10", "-2"]) await expect(app.texts()).toContain(text);
  await expect(app.shows("label:Linked pull request #3")).toBe(false);
  // The footer counts open links of those listed: all but the merged one (#5).
  await expect(app.texts()).toContain("3 open · 4 linked");
  // A link the server has not synced shows its host path until the snapshot arrives.
  await expect(app.texts()).toContain("github.com/acme/t3code");
  await expect(app.shows("label:Waiting for host state")).toBe(true);
});

test("Unlink from thread sends the unlink command under the normalized key, and a stack link offers Dismiss instead", async () => {
  const app = await open("./ThreadPullRequestsFixture.tsx", size);
  await app.press("label:Actions for #1");
  await expect(app.texts()).toContain("Unlink from thread");
  await app.press("label:Unlink from thread");
  await app.waitFor('text:dispatch {"type":"thread.pull-request.unlink","threadId":"thread:a","host":"github.com","repository":"acme/t3code","number":1}');
  await app.press("label:Actions for #2");
  await expect(app.texts()).toContain("Dismiss from thread");
});

test("Watch for changes sends the watch command with the link, and a watched link offers Stop watching", async () => {
  const app = await open("./ThreadPullRequestsFixture.tsx", size);
  await app.press("label:Actions for #1");
  await app.press("label:Watch for changes");
  await app.waitFor('text:dispatch {"type":"thread.pull-request.watch","threadId":"thread:a","host":"github.com","repository":"acme/t3code","number":1,"watching":true,"link":{"url":"https://github.com/acme/t3code/pull/1","source":"agent"}}');
  // The merged link is not open, so it offers no watching.
  await app.press("label:Actions for #5");
  await expect(app.shows("label:Stop watching")).toBe(false);
});

test("pressing a row opens the pull request, and Link asks for the dialog", async () => {
  const app = await open("./ThreadPullRequestsFixture.tsx", size);
  await app.press("label:Open #1 Fix the race");
  await app.waitFor("text:open 1");
  await app.press("label:Link");
  await app.waitFor("text:link dialog");
});

test("with no links the panel says so and offers Link pull request", async () => {
  const app = await open("./ThreadPullRequestsFixture.tsx", size);
  await app.press("label:Remove all links");
  await expect(app.texts()).toContain("No linked pull requests");
  await app.press("label:Link pull request");
  await app.waitFor("text:link dialog");
});
