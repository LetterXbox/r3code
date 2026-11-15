import { expect, open, test } from "nsh/test";

test("shell pushes that keep the folder do not resubscribe subscribeVcsStatus; a new folder does", async () => {
  const app = await open("./VcsStatusLifetimeFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("text:vcs subscribes: 1");
  for (let i = 0; i < 5; i++) await app.press("label:Push shell");
  await app.waitFor("text:vcs subscribes: 1");
  await expect(app.texts().join("|")).toContain("vcs subscribes: 1|");
  await app.press("label:Change folder");
  await app.waitFor("text:vcs subscribes: 2");
});
