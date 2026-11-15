import { expect, open, test } from "nsh/test";

test("a select trigger shows the option label, and its menu lists labels", async () => {
  const app = await open("./SelectLabelsFixture.tsx", { width: 1100, height: 1400 });
  await expect(app.texts()).toContain("Off");
  await expect(app.texts()).not.toContain("notifications-and-sound");
  await app.press("label:Thread notifications = off");
  await expect(app.texts()).toContain("Notifications with sound");
  await expect(app.texts()).toContain("Sound only");
});
