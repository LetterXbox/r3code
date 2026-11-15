import { expect, open, test } from "nsh/test";

test("the overlay bar names the app and the window", async () => {
  const app = await open("./SnapShotDetailsFixture.tsx", { width: 460, height: 400, platform: "macos" });
  await expect(app.texts()).toContain("Notes");
  await expect(app.texts()).toContain("Shopping list");
  await expect(app.texts()).toContain("Mail");
  await expect(app.texts()).toContain("Captured window");
});

test("the button opens the accessibility data, or says there is none", async () => {
  const app = await open("./SnapShotDetailsFixture.tsx", { width: 460, height: 400, platform: "macos" });
  await app.press("label:View accessibility data");
  await expect(app.texts()).toContain("Accessibility data");
  await expect(app.texts()).toContain("Window: Shopping list\n  Button: Add");
  await app.press("label:No accessibility data");
  await expect(app.texts()).toContain("The app or capture backend did not provide verified accessibility data.");
});
