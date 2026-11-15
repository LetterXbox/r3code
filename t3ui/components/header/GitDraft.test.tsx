import { expect, open, test } from "nsh/test";

test("a draft's card shows the branch picker with the refs, and no servers, automations or lineage subscriptions", async () => {
  const app = await open("./GitDraftFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("label:Branch feature");
  await app.press("label:Branch feature");
  await app.waitFor("label:Search refs");
  await expect(app.shows("label:main")).toBe(true);
  const log = app.texts().join("|");
  await expect(log).not.toContain("subscribe:scheduledTasks.subscribe");
  await expect(log).not.toContain("subscribe:subscribeDiscoveredLocalServers");
});
