import { expect, open, test } from "nsh/test";

test("the default browser viewport row offers the presets, and choosing one shows its size and the reset mark", async () => {
  const app = await open("./BrowserViewportFixture.tsx", { width: 1100, height: 1400 });
  await expect(app.texts()).toContain("Default browser viewport");
  await expect(app.texts()).not.toContain("Not available yet");
  await expect(app.shows("label:Default viewport width")).toBe(false);
  await app.press("label:Default browser viewport = fill");
  await expect(app.texts()).toContain("iPhone SE");
  await expect(app.texts()).toContain("375 × 667");
  await app.press("label:iPhone SE");
  await expect(app.shows("label:Default viewport width")).toBe(true);
  await expect(app.shows("label:Reset Default browser viewport to default")).toBe(true);
  await app.press("label:Rotate");
  await app.press("label:Reset Default browser viewport to default");
  await expect(app.shows("label:Default viewport width")).toBe(false);
});

test("the custom search URL row says when its template falls back to DuckDuckGo", async () => {
  const app = await open("./BrowserViewportFixture.tsx", { width: 1100, height: 3000 });
  await app.waitUntil(() => app.shows("label:Custom search URL"));
  await expect(app.texts()).toContain("Enter an http or https URL containing %s. Searches use DuckDuckGo until then.");
});
