import { expect, open, test } from "nsh/test";

test("an open settings select registers with the WebView occlusion registry and releases on close", async () => {
  const app = await open("./SelectOverlayFixture.tsx", { width: 1100, height: 1400 });
  await expect(app.texts()).toContain("overlays: 0");
  await app.press("label:Thread notifications = off");
  await expect(app.texts()).toContain("overlays: 1");
  await app.press("label:Sound only");
  await expect(app.texts()).toContain("overlays: 0");
});
