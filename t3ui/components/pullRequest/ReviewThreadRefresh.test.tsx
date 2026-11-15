import { expect, open, test } from "nsh/test";

test("a review card updates when its thread snapshot changes", async () => {
  const app = await open("./ReviewThreadRefreshFixture.tsx", { width: 600, height: 500 });
  await app.waitFor("text:Before refresh");
  await app.press("label:Refresh review");
  await app.waitFor("text:After refresh");
  expect(app.texts()).not.toContain("Before refresh");
  expect(app.texts().some((value) => value.includes("src/new.ts"))).toBe(true);
});

test("a partially loaded thread reports missing replies even without a cursor", async () => {
  const app = await open("./ReviewThreadRefreshFixture.tsx", { width: 600, height: 500 });
  await app.press("label:Show partial thread");
  await app.waitFor("text:2 more replies");
  expect(app.shows("label:View on host")).toBe(true);
});

test("an open summary thread offers its finding action", async () => {
  const app = await open("./ReviewThreadRefreshFixture.tsx", { width: 600, height: 500 });
  await app.press("label:Fix in a thread");
  await app.waitFor("text:Fix selected");
});
