import { expect, open, test } from "nsh/test";

test("Restore device defaults lists what it resets, asks first, and resets those settings", async () => {
  const app = await open("./RestoreDefaultsFixture.tsx", { width: 1280, height: 900 });
  await expect(app.texts()).toContain("time format: locale");
  await app.press("label:Change time format");
  await expect(app.texts()).toContain("time format: 24-hour");
  await app.press("label:Restore device defaults");
  await expect(app.texts()).toContain("Restore default settings?");
  await expect(app.texts()).toContain("This will reset: Time format.");
  await app.press("label:Confirm");
  await expect(app.texts()).toContain("time format: locale");
});
