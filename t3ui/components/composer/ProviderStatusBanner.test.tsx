import { expect, open, test } from "nsh/test";

test("Open provider setup selects that provider instance in Settings (ProviderStatusBanner)", async () => {
  const app = await open("./ProviderStatusBannerFixture.tsx", { width: 700, height: 300, platform: "macos" });
  await expect(app.texts()).toContain("setup none");
  await app.press("label:Open provider setup");
  await app.waitFor("text:setup claude-work");
});
