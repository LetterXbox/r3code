import { expect, open, test } from "nsh/test";

test("provider selection survives repeated equivalent environment snapshots", async () => {
  const app = await open("./ProviderScopeRefreshFixture.tsx", { width: 1100, height: 1200 });
  await app.waitFor("label:Select Claude");
  await app.press("label:Select Claude");
  await app.waitFor("id:provider-claudeAgent-selected");
  for (let i = 0; i < 3; i++) {
    await app.press("label:Refresh configuration snapshot");
    await expect(app.shows("id:provider-claudeAgent-selected")).toBe(true);
  }
});
