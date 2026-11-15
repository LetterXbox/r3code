import { expect, open, test } from "nsh/test";

test("a custom OpenAI-compatible endpoint shows its initials on a tile, one letter when small (ProviderInstanceIcon)", async () => {
  const app = await open("./CustomEndpointIconFixture.tsx", { width: 300, height: 100 });
  await expect(app.texts()).toContain("LL");
  await expect(app.texts()).toContain("G");
  await expect(app.texts()).not.toContain("GC");
});
