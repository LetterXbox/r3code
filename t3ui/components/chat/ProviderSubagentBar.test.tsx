import { expect, open, test } from "nsh/test";

test("the subagent bar keeps secondary copy only where there is room", async () => {
  const wide = await open("./ProviderSubagentBarFixture.tsx", { width: 800, height: 120 });
  await expect(wide.texts()).toContain("Runs on its own");
  await expect(wide.texts()).toContain("Open parent");
  const narrow = await open("./ProviderSubagentBarFixture.tsx", { width: 300, height: 120 });
  await expect(narrow.texts()).not.toContain("Runs on its own");
  await expect(narrow.texts()).not.toContain("Open parent");
  await expect(narrow.shows("label:Open parent")).toBe(true);
  await expect(narrow.texts()).toContain("Working");
});
