import { expect, open, test } from "nsh/test";

test("server filter narrows a combined PR list and changing it restores the other server", async () => {
  const app = await open("./PullRequestsMultiFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:Laptop change");
  await app.waitFor("text:Server change");
  await app.press("label:Filters");
  await app.press("label:Server filter");
  await app.press("label:Server Server");
  await app.waitUntil(() => !app.texts().includes("Laptop change"));
  expect(app.texts()).toContain("Server change");
  await app.press("label:Server All servers");
  await app.waitFor("text:Laptop change");
  expect(app.texts()).toContain("Server change");
});
